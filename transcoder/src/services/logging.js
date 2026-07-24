import { mkdirSync } from 'fs'
import { join } from 'path'

const DEFAULT_RETENTION_DAYS = 3 // matches Jellyfin's default retainedFileCountLimit

/**
 * Build the `logger` option for Fastify's constructor. Always logs to
 * stdout; additionally writes a daily-rotating, retention-capped file under
 * `logDir` when that directory is writable. Falls back to stdout-only when
 * it isn't, so a bad mount never blocks startup.
 *
 * Mirrors Jellyfin's Serilog config (Console + rolling File sink) — see
 * src/services/logging.js on the main API side for the same helper.
 */
export function buildLoggerOptions({ logDir, fileBaseName, retentionDays = DEFAULT_RETENTION_DAYS, level = process.env.LOG_LEVEL ?? 'info' }) {
  const targets = [
    { target: 'pino/file', level, options: { destination: 1 } },
  ]

  try {
    mkdirSync(logDir, { recursive: true })
    targets.push({
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
    })
  } catch (err) {
    console.warn(`[logging] Could not prepare log directory "${logDir}" — file logging disabled: ${err.message}`)
  }

  return { level, transport: { targets } }
}
