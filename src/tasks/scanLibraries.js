import { scanLibrary } from '../services/scanner.js'

/**
 * Built-in task: scan all enabled libraries for new, changed, and removed media.
 *
 * Triggers (defaults)
 *   • On startup (after a 5 s grace period)
 *   • Every 12 hours
 *
 * Progress is reported per library: each library contributes an equal share
 * of the 0–100 progress range. Cancellation is honoured between libraries.
 *
 * @param {import('../services/scanBroadcaster.js').ScanBroadcaster} broadcaster
 */
export function createScanLibrariesTask(broadcaster) {
  return {
    id:          'scan-libraries',
    name:        'Scan All Libraries',
    description: 'Scans all media libraries for new, changed, and removed files.',
    category:    'Library',

    defaultTriggers: [
      { type: 'startup' },
      { type: 'interval', intervalMs: 12 * 60 * 60 * 1000 }, // 12 h
    ],

    /** @param {import('../services/taskScheduler.js').ExecuteContext} ctx */
    async execute({ db, log, signal, progress }) {
      const { rows: libraries } = await db.query(
        "SELECT * FROM libraries ORDER BY name"
      )

      if (!libraries.length) {
        log.info('[tasks/scan-libraries] No libraries configured — nothing to do')
        return
      }

      const step = 100 / libraries.length

      for (let i = 0; i < libraries.length; i++) {
        if (signal.aborted) {
          log.info('[tasks/scan-libraries] Cancelled before scanning library', libraries[i].name)
          return
        }

        const library = libraries[i]
        log.info(`[tasks/scan-libraries] Scanning "${library.name}" (${i + 1}/${libraries.length})`)

        try {
          // Pass broadcaster so per-item progress is pushed over SSE during scheduled runs too
          await scanLibrary(db, library, log, broadcaster)
        } catch (err) {
          // Log and continue — a single bad library shouldn't abort the whole task
          log.error({ err }, `[tasks/scan-libraries] Library "${library.name}" scan failed`)
        }

        progress(Math.round((i + 1) * step))
      }
    },
  }
}
