import { mkdirSync } from 'fs'
import { join } from 'path'

const DEFAULT_RETENTION_DAYS = 3 // matches Jellyfin's default retainedFileCountLimit

/**
 * Build the `logger` option for Fastify's constructor. Always logs to
 * stdout (docker logs keeps working unchanged); additionally writes a
 * daily-rotating, retention-capped file under `logDir` when that directory
 * is writable. Falls back to stdout-only — never blocks startup — when it
 * isn't (e.g. the persistent volume isn't mounted).
 *
 * Mirrors Jellyfin's Serilog config (Console + rolling File sink, daily
 * rotation, retainedFileCountLimit): see Jellyfin.Server/Resources/
 * Configuration/logging.json.
 *
 * @param {object} opts
 * @param {string}  opts.logDir         directory to write rotated logs into
 * @param {string}  opts.fileBaseName   e.g. "server" → server.<date>.log
 * @param {number}  [opts.retentionDays]
 * @param {string}  [opts.level]
 */
export function buildLoggerOptions({ logDir, fileBaseName, retentionDays = DEFAULT_RETENTION_DAYS, level = process.env.LOG_LEVEL ?? 'info' }) {
  const targets = [
    { target: 'pino/file', level, options: { destination: 1 } }, // stdout, fd 1
  ]

  try {
    mkdirSync(logDir, { recursive: true })
    targets.push({
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
    })
  } catch (err) {
    // Falls back to stdout-only. Logged via console since the pino instance
    // doesn't exist yet at this point in startup.
    console.warn(`[logging] Could not prepare log directory "${logDir}" — file logging disabled: ${err.message}`)
  }

  return { level, transport: { targets } }
}
