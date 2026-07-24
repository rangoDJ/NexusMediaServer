import { mkdirSync } from 'fs'
import { join } from 'path'
import pino from 'pino'

const DEFAULT_RETENTION_DAYS = 3 // matches Jellyfin's default retainedFileCountLimit

/**
 * Build a ready-to-use pino logger instance — never throws, never blocks
 * startup. Always logs to stdout; additionally writes a daily-rotating,
 * retention-capped file under `logDir` when that's actually possible.
 * Falls all the way back to a bare, synchronous stdout-only logger on ANY
 * failure — missing pino-roll (e.g. an old container image that wasn't
 * rebuilt with this dependency), a bad/unwritable path, whatever. A broken
 * log setup must never be the reason the server won't start.
 *
 * Mirrors Jellyfin's Serilog config (Console + rolling File sink, daily
 * rotation, retainedFileCountLimit) — see Jellyfin.Server/Resources/
 * Configuration/logging.json.
 *
 * @param {object} opts
 * @param {string}  opts.logDir         directory to write rotated logs into
 * @param {string}  opts.fileBaseName   e.g. "server" → server.<date>.log
 * @param {number}  [opts.retentionDays]
 * @param {string}  [opts.level]
 * @returns {import('pino').Logger}
 */
export function buildLogger({ logDir, fileBaseName, retentionDays = DEFAULT_RETENTION_DAYS, level = process.env.LOG_LEVEL ?? 'info' }) {
  try {
    mkdirSync(logDir, { recursive: true })

    const transport = pino.transport({
      targets: [
        { target: 'pino/file', level, options: { destination: 1 } }, // stdout, fd 1
        {
          target: 'pino-roll',
          level,
          options: {
            file: join(logDir, fileBaseName),
            frequency: 'daily',
            size: '100m',       // mid-day rollover backstop if a single day's log gets huge
            limit: { count: retentionDays },
            mkdir: true,
            extension: '.log',
          },
        },
      ],
    })

    // A failure *after* construction (e.g. permission denied, hit inside the
    // worker thread once it actually tries to open the file) emits 'error'
    // rather than throwing — an unhandled 'error' event on a stream throws
    // and kills the process, so this always needs a listener.
    transport.on('error', err => {
      console.error('[logging] file transport error (stdout logging continues):', err)
    })

    return pino({ level }, transport)
  } catch (err) {
    // Anything going wrong above (missing pino-roll, bad path, ...) must
    // never take the whole server down with it — fall back to a plain
    // synchronous stdout logger, which cannot fail.
    const fallback = pino({ level })
    fallback.warn({ err: err.message }, `[logging] File logging disabled (dir: ${logDir}) — falling back to stdout only`)
    return fallback
  }
}
