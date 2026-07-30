import PQueue from 'p-queue'
import { extractDominantColor } from '../services/colorExtractor.js'

// Posters mostly come from TMDB, so this is network-bound. Six at a time keeps
// a large backfill moving without hammering their CDN.
const CONCURRENCY = 6

// Bounded so a first run against a huge library doesn't hold a DB connection
// and a work queue open for an unbounded stretch. Whatever is left over is
// picked up by the next run.
const BATCH_LIMIT = 500

export const extractColorsTask = {
  id:          'extract-colors',
  name:        'Extract Artwork Colors',
  description: 'Samples each poster for the accent color the UI uses to tint that title.',
  category:    'Media',

  defaultTriggers: [
    { type: 'startup' },
    { type: 'daily', timeOfDay: '05:00' },
  ],

  /** @param {import('../services/taskScheduler.js').ExecuteContext} ctx */
  async execute({ db, log, signal, progress }) {
    // color_extracted_at (not dominant_color) is the "needs work" marker, so a
    // poster that legitimately yields no color is attempted once and then left
    // alone rather than being re-downloaded on every run.
    const { rows } = await db.query(`
      SELECT id, title, poster_url, metadata->>'local_poster_path' AS local_poster_path
      FROM media_items
      WHERE color_extracted_at IS NULL
        AND (poster_url IS NOT NULL OR metadata->>'local_poster_path' IS NOT NULL)
      ORDER BY created_at DESC
      LIMIT $1
    `, [BATCH_LIMIT])

    if (!rows.length) {
      log.info('[tasks/colors] Every poster has been sampled — nothing to do')
      return
    }

    log.info(`[tasks/colors] Sampling ${rows.length} poster(s)`)

    const queue = new PQueue({ concurrency: CONCURRENCY })
    let done = 0
    let found = 0

    for (const item of rows) {
      queue.add(async () => {
        if (signal.aborted) return

        // Prefer the local file: no network, and it's the artwork the user
        // actually put next to the media.
        const color = await extractDominantColor({
          filePath: item.local_poster_path ?? null,
          url:      item.local_poster_path ? null : item.poster_url,
        })

        if (signal.aborted) return

        // Stamp color_extracted_at either way — that is what marks this row
        // as attempted and keeps it out of the next run's query.
        await db.query(
          'UPDATE media_items SET dominant_color=$1, color_extracted_at=now() WHERE id=$2',
          [color, item.id]
        ).catch(err =>
          log.warn({ err }, `[tasks/colors] Failed to store color for "${item.title}"`)
        )

        if (color) found++
        done++
        progress(Math.round((done / rows.length) * 100))
      })
    }

    await queue.onIdle()

    if (signal.aborted) {
      log.info(`[tasks/colors] Cancelled after ${done}/${rows.length}`)
      return
    }

    log.info(
      `[tasks/colors] Done — ${found} color(s) from ${done} poster(s); ` +
      `${done - found} had no usable hue`
    )
  },
}
