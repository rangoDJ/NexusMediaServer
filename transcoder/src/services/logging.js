import { mkdirSync } from 'fs'
import { join } from 'path'
import pino from 'pino'

const DEFAULT_RETENTION_DAYS = 3 // matches Jellyfin's default retainedFileCountLimit

/**
 * Build a ready-to-use pino logger instance — never throws, never blocks
 * startup. Always logs to stdout; additionally writes a daily-rotating,
 * retention-capped file under `logDir` when that's actually possible.
 * Falls all the way back to a bare, synchronous stdout-only logger on ANY
 * failure — see src/services/logging.js on the main API side for the same
 * helper and the reasoning.
 *
 * @returns {import('pino').Logger}
 */
export function buildLogger({ logDir, fileBaseName, retentionDays = DEFAULT_RETENTION_DAYS, level = process.env.LOG_LEVEL ?? 'info' }) {
  try {
    mkdirSync(logDir, { recursive: true })

    const transport = pino.transport({
      targets: [
        { target: 'pino/file', level, options: { destination: 1 } },
        {
          target: 'pino-roll',
          level,
          options: {
            file: join(logDir, fileBaseName),
            frequency: 'daily',
            size: '100m',
            limit: { count: retentionDays },
            mkdir: true,
            extension: '.log',
          },
        },
      ],
    })

    transport.on('error', err => {
      console.error('[logging] file transport error (stdout logging continues):', err)
    })

    return pino({ level }, transport)
  } catch (err) {
    const fallback = pino({ level })
    fallback.warn({ err: err.message }, `[logging] File logging disabled (dir: ${logDir}) — falling back to stdout only`)
    return fallback
  }
}
