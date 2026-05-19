import { fetchMovieMetadata, fetchSeriesMetadata } from '../services/tmdb.js'
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

    // Fetch all media items with a known TMDB id
    const { rows: items } = await db.query(`
      SELECT id, type, title, year, tmdb_id
        FROM media_items
       WHERE tmdb_id IS NOT NULL
       ORDER BY type, title
    `)

    if (!items.length) {
      log.info('[tasks/refresh-metadata] No items with a TMDB id — nothing to do')
      return
    }

    log.info(`[tasks/refresh-metadata] Refreshing metadata for ${items.length} item(s)`)

    let done = 0
    let updated = 0
    let failed = 0

    for (const item of items) {
      if (signal.aborted) {
        log.info(`[tasks/refresh-metadata] Cancelled after ${done}/${items.length} items`)
        return
      }

      try {
        let meta
        if (item.type === 'movie') {
          meta = await fetchMovieMetadata(item.title, item.year, tmdbOpts)
        } else {
          meta = await fetchSeriesMetadata(item.title, tmdbOpts)
        }

        if (meta?.tmdb_id) {
          await db.query(`
            UPDATE media_items
               SET poster_url   = COALESCE($2, poster_url),
                   backdrop_url = COALESCE($3, backdrop_url),
                   rating       = COALESCE($4, rating),
                   plot         = COALESCE($5, plot),
                   genres       = COALESCE($6, genres),
                   tagline      = COALESCE($7, tagline)
             WHERE id = $1
          `, [
            item.id,
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
        log.warn({ err }, `[tasks/refresh-metadata] Failed to refresh "${item.title}" (tmdb=${item.tmdb_id})`)
        failed++
      }

      done++
      progress(Math.round((done / items.length) * 100))

      // Respect TMDB rate limit (~40 req/s public; 250ms keeps us safely under)
      if (done < items.length) await sleep(250)
    }

    log.info(
      `[tasks/refresh-metadata] Done — ${updated} updated, ${failed} failed, ` +
      `${items.length - updated - failed} unchanged`
    )
  },
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)) }
