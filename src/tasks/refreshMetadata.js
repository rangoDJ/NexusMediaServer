import { fetchMovieMetadata, fetchSeriesMetadata, fetchMovieById, fetchSeriesById } from '../services/tmdb.js'
import { getSettings } from '../services/settingsCache.js'

/**
 * Built-in task: refresh TMDB metadata for all media items that have a tmdb_id.
 *
 * This updates poster/backdrop URLs, ratings, plot, and genres from TMDB without
 * re-scanning the filesystem. Useful when TMDB refreshes artwork or ratings change.
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
    const settings = await getSettings(db)
    const tmdbOpts = {
      apiKey:   settings['tmdb.api_key'] || process.env.TMDB_API_KEY,
      language: settings['tmdb.language'] ?? 'en',
      enabled:  settings['tmdb.enabled'] !== false,
    }

    if (!tmdbOpts.enabled || !tmdbOpts.apiKey) {
      log.info('[tasks/refresh-metadata] TMDB disabled or no API key — skipping')
      return
    }

    // Process ALL items, including those without a tmdb_id — TMDB might match
    // them now even if it didn't at scan time (added to TMDB since, key was
    // missing then, etc.). This is exactly what users mean by "why are my
    // posters missing" — items that fell through the cracks at first scan.
    const { rows: items } = await db.query(`
      SELECT id, type, title, year, tmdb_id, poster_url
        FROM media_items
       ORDER BY (tmdb_id IS NOT NULL) DESC, type, title
    `)

    if (!items.length) {
      log.info('[tasks/refresh-metadata] No items to refresh')
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
        let meta
        if (item.tmdb_id) {
          // Direct ID lookup — fast and accurate
          meta = item.type === 'movie'
            ? await fetchMovieById(item.tmdb_id, tmdbOpts)
            : await fetchSeriesById(item.tmdb_id, tmdbOpts)
        } else {
          // No tmdb_id yet — search by title to try to match
          meta = item.type === 'movie'
            ? await fetchMovieMetadata(item.title, item.year, tmdbOpts)
            : await fetchSeriesMetadata(item.title, tmdbOpts)
          if (meta?.tmdb_id) matched++
        }

        if (meta?.tmdb_id) {
          await db.query(`
            UPDATE media_items
               SET tmdb_id      = COALESCE(tmdb_id, $2),
                   poster_url   = COALESCE($3, poster_url),
                   backdrop_url = COALESCE($4, backdrop_url),
                   rating       = COALESCE($5, rating),
                   plot         = COALESCE($6, plot),
                   genres       = COALESCE($7, genres),
                   tagline      = COALESCE($8, tagline)
             WHERE id = $1
          `, [
            item.id,
            meta.tmdb_id,
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
      progress(Math.round((done / items.length) * 100))
      if (done < items.length) await sleep(250)
    }

    log.info(
      `[tasks/refresh-metadata] Done — ${updated} updated (${matched} newly matched), ` +
      `${failed} failed, ${items.length - updated - failed} unchanged`
    )
  },
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)) }
