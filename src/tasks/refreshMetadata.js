import { fetchMovieMetadata, fetchSeriesMetadata, fetchMovieById, fetchSeriesById, findTmdbIdByExternalId } from '../services/tmdb.js'
import { getSettings } from '../services/settingsCache.js'
import { parseProviderTags } from '../services/providerTags.js'

/**
 * Built-in task: refresh TMDB metadata for all media items that have a tmdb_id.
 *
 * This updates poster/backdrop URLs, ratings, plot, and genres from TMDB without
 * re-scanning the filesystem. Useful when TMDB refreshes artwork or ratings change.
 *
 * Also repairs titles polluted by *arr-style folder naming (e.g. a folder named
 * "Movie (2005) {tmdb-11679}" scanned before this was handled at scan time —
 * see services/providerTags.js) — this pass runs even when TMDB itself is
 * disabled, since it's pure local string cleanup.
 *
 * Triggers (defaults)
 *   • Daily at 04:00 UTC
 *
 * Rate-limiting: a 250ms pause is inserted between each TMDB API call to stay
 * within TMDB's public rate limit (~40 req/s). Cancellation is honoured after
 * every item.
 */
export const refreshMetadataTask = {
  id:          'refresh-metadata',
  name:        'Refresh TMDB Metadata',
  description: 'Updates posters, ratings, and plot information from TMDB for all matched media.',
  category:    'Library',

  defaultTriggers: [
    { type: 'daily', timeOfDay: '04:00' },
  ],

  /** @param {import('../services/taskScheduler.js').ExecuteContext} ctx */
  async execute({ db, log, signal, progress }) {
    const { rows: items } = await db.query(`
      SELECT id, type, title, year, tmdb_id, poster_url
        FROM media_items
       ORDER BY (tmdb_id IS NOT NULL) DESC, type, title
    `)

    if (!items.length) {
      log.info('[tasks/refresh-metadata] No items to refresh')
      return
    }

    // Pass 0: strip embedded provider-id tags leaked into the title by
    // *arr-style folder naming, and remember any id found so the main pass
    // below can use it for a direct lookup instead of a fuzzy title search.
    // Pure local string work — runs regardless of whether TMDB is configured.
    let titlesCleaned = 0
    for (const item of items) {
      const { tmdbId, tvdbId, cleanName } = parseProviderTags(item.title)
      item.embeddedTmdbId = tmdbId
      item.embeddedTvdbId = tvdbId
      if (cleanName && cleanName !== item.title) {
        await db.query('UPDATE media_items SET title=$2 WHERE id=$1', [item.id, cleanName])
        item.title = cleanName
        titlesCleaned++
      }
    }
    if (titlesCleaned > 0) {
      log.info(`[tasks/refresh-metadata] Cleaned ${titlesCleaned} title(s) with embedded provider-id tags`)
    }
    progress(5)
    if (signal.aborted) return

    const settings = await getSettings(db)
    const tmdbOpts = {
      apiKey:   settings['tmdb.api_key'] || process.env.TMDB_API_KEY,
      language: settings['tmdb.language'] ?? 'en',
      enabled:  settings['tmdb.enabled'] !== false,
    }

    if (!tmdbOpts.enabled || !tmdbOpts.apiKey) {
      log.info('[tasks/refresh-metadata] TMDB disabled or no API key — skipping metadata match')
      return
    }

    log.info(`[tasks/refresh-metadata] Refreshing ${items.length} item(s) (${items.filter(i => !i.tmdb_id).length} need a TMDB lookup)`)

    let done = 0
    let updated = 0
    let matched = 0  // newly matched (tmdb_id was null, now set)
    let failed = 0

    for (const item of items) {
      if (signal.aborted) {
        log.info(`[tasks/refresh-metadata] Cancelled after ${done}/${items.length} items`)
        return
      }

      try {
        // Prefer an already-confirmed tmdb_id; otherwise an id embedded in
        // the (now-cleaned) title's original folder name is a guaranteed-
        // accurate lookup, far better than a fuzzy search. A TVDB id (Sonarr's
        // default naming) needs an extra hop through TMDB's /find endpoint
        // first, since TMDB has no direct-by-TVDB-id lookup.
        let effectiveTmdbId = item.tmdb_id ?? item.embeddedTmdbId
        if (!effectiveTmdbId && item.embeddedTvdbId) {
          effectiveTmdbId = await findTmdbIdByExternalId(item.embeddedTvdbId, 'tvdb_id', {
            ...tmdbOpts,
            mediaType: item.type === 'movie' ? 'movie' : 'tv',
          })
        }

        let meta
        if (effectiveTmdbId) {
          meta = item.type === 'movie'
            ? await fetchMovieById(effectiveTmdbId, tmdbOpts)
            : await fetchSeriesById(effectiveTmdbId, tmdbOpts)
          if (!item.tmdb_id && meta?.tmdb_id) matched++
        } else {
          meta = item.type === 'movie'
            ? await fetchMovieMetadata(item.title, item.year, tmdbOpts)
            : await fetchSeriesMetadata(item.title, tmdbOpts)
          if (meta?.tmdb_id) matched++
        }

        if (meta?.tmdb_id) {
          await db.query(`
            UPDATE media_items
               SET tmdb_id      = COALESCE(tmdb_id, $2),
                   title        = COALESCE($3, title),
                   poster_url   = COALESCE($4, poster_url),
                   backdrop_url = COALESCE($5, backdrop_url),
                   rating       = COALESCE($6, rating),
                   plot         = COALESCE($7, plot),
                   genres       = COALESCE($8, genres),
                   tagline      = COALESCE($9, tagline)
             WHERE id = $1
          `, [
            item.id,
            meta.tmdb_id,
            meta.title        ?? null,
            meta.poster_url   ?? null,
            meta.backdrop_url ?? null,
            meta.rating       ?? null,
            meta.plot         ?? null,
            meta.genres       ?? null,
            meta.tagline      ?? null,
          ])
          updated++
        }
      } catch (err) {
        log.warn({ err }, `[tasks/refresh-metadata] Failed to refresh "${item.title}" (tmdb=${item.tmdb_id ?? 'none'})`)
        failed++
      }

      done++
      progress(5 + Math.round((done / items.length) * 95))
      if (done < items.length) await sleep(250)
    }

    log.info(
      `[tasks/refresh-metadata] Done — ${updated} updated (${matched} newly matched), ` +
      `${failed} failed, ${items.length - updated - failed} unchanged`
    )
  },
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)) }
