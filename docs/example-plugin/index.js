/**
 * NexusMediaServer Example Plugin
 * ════════════════════════════════
 * Drop this folder into your PLUGINS_PATH to see the full plugin system in action.
 *
 * Install path:  <PLUGINS_PATH>/example-plugin/index.js
 * Data dir:      <PLUGINS_DATA_PATH>/example-plugin/          (auto-created)
 *
 * This plugin demonstrates every feature of the plugin contract:
 *   ✓ Rich manifest with settingsSchema
 *   ✓ onLoad / onUnload / onSettingsChanged lifecycle
 *   ✓ Hook registrations (stream.start, media.added, auth.login)
 *   ✓ A custom API route via api.routes
 *   ✓ A plugin-registered scheduled task
 */

import { writeFile, readFile } from 'fs/promises'
import { join } from 'path'

// ── Manifest ──────────────────────────────────────────────────────────────────

export const manifest = {
  // required
  id:      'example-plugin',
  name:    'Example Plugin',

  // recommended
  version:     '1.0.0',
  description: 'Demonstrates the NexusMediaServer plugin API.',
  overview:    `
# Example Plugin

A reference implementation showing every capability of the NexusMediaServer plugin system.

## Features
- Hooks into stream start to prefer H.265 encoding
- Logs every new media item to a local JSON file
- Exposes a custom API route at \`GET /api/v1/plugins/example-plugin/stats\`
- Runs a daily scheduled task
  `.trim(),
  author:   'Nexus Team',
  category: 'General',            // Metadata | Notifications | Authentication | General
  homepage: 'https://github.com/nexus-example/example-plugin',

  minServerVersion: '0.1.0',      // semver — plugin will be skipped if server is older

  permissions: [
    'db.read',                    // informational: helps admins understand plugin needs
    'http.fetch',
    'fs.write',
  ],

  // ── Settings schema ────────────────────────────────────────────────────────
  // Controls:
  //   • Settings validation before save (type checking, required, enum, min/max)
  //   • Default value injection on first load
  //   • UI form generation (the admin panel reads this to render inputs)
  settingsSchema: {
    preferH265: {
      type:        'boolean',
      title:       'Prefer H.265 encoding',
      description: 'When enabled, the stream.start hook overrides codec to h265.',
      default:     true,
    },
    logFile: {
      type:        'string',
      title:       'Media log filename',
      description: 'Name of the JSON file written to the plugin data directory.',
      default:     'media-log.json',
      minLength:   1,
      maxLength:   64,
    },
    blockedUsers: {
      type:        'string',
      title:       'Blocked usernames (comma-separated)',
      description: 'Users listed here will be denied login by the auth.login hook.',
      default:     '',
    },
    maxLogEntries: {
      type:        'number',
      title:       'Max log entries',
      description: 'Trim the log file to this many entries.',
      default:     500,
      minimum:     10,
      maximum:     10000,
    },
    notifyLevel: {
      type:    'string',
      title:   'Notification level',
      default: 'info',
      enum:    ['debug', 'info', 'warn', 'error'],
    },
  },
}

// ── State (module-level; reset on reload) ─────────────────────────────────────

let _dataDir = null
let _log = null
let _mediaLog = []

// ── Lifecycle ─────────────────────────────────────────────────────────────────

/**
 * Called once when the plugin is loaded (or reloaded).
 * Use this to initialise state, open connections, read cached data, etc.
 */
export async function onLoad({ db, log, settings, dataDir }) {
  _dataDir = dataDir
  _log     = log

  log.info(`[example-plugin] onLoad — dataDir: ${dataDir}`)

  // Load any previously saved media log
  try {
    const raw = await readFile(join(dataDir, settings.logFile ?? 'media-log.json'), 'utf8')
    _mediaLog = JSON.parse(raw)
    log.info(`[example-plugin] Loaded ${_mediaLog.length} existing log entries`)
  } catch {
    _mediaLog = []   // file doesn't exist yet — fine
  }
}

/**
 * Called when the plugin is disabled or the server shuts down.
 * Use this to flush state, close connections, etc.
 */
export async function onUnload({ log, settings }) {
  log.info('[example-plugin] onUnload — flushing media log')
  await flushLog(settings).catch(err => log.warn({ err }, '[example-plugin] Flush on unload failed'))
}

/**
 * Called immediately after the admin updates plugin settings.
 * The plugin is already using the new settings object by the time this fires.
 */
export async function onSettingsChanged({ newSettings, oldSettings, log }) {
  log.info('[example-plugin] Settings changed', {
    preferH265Changed: oldSettings.preferH265 !== newSettings.preferH265,
  })
  // If the log filename changed, reload from the new file
  if (oldSettings.logFile !== newSettings.logFile) {
    try {
      const raw = await readFile(join(_dataDir, newSettings.logFile), 'utf8')
      _mediaLog = JSON.parse(raw)
    } catch {
      _mediaLog = []
    }
  }
}

// ── Hooks ─────────────────────────────────────────────────────────────────────

export const hooks = {

  /**
   * api.routes — register custom Fastify routes.
   * Context: { app }   (the Fastify instance)
   * Return:  void
   */
  'api.routes': async ({ app }, settings) => {
    app.get(
      '/api/v1/plugins/example-plugin/stats',
      { preHandler: app.authenticate },
      async () => ({
        loggedItems:  _mediaLog.length,
        preferH265:   settings.preferH265,
        pluginVersion: manifest.version,
      })
    )
  },

  /**
   * stream.start — intercept streaming parameters before the transcoder is picked.
   * Context: { filePath, codec, resolution, bitrate }
   * Return:  object with any of { codec, resolution, bitrate } to override, or null
   */
  'stream.start': async ({ codec }, settings) => {
    if (settings.preferH265 && codec === 'h264') {
      return { codec: 'h265' }
    }
    return null
  },

  /**
   * media.added — notification fired when a new item is inserted during scan.
   * Context: { type, id, title, year, tmdb_id }
   * Return:  void (return value is ignored)
   */
  'media.added': async ({ type, id, title, year }, settings) => {
    _mediaLog.push({ type, id, title, year, addedAt: new Date().toISOString() })

    // Trim to max entries
    const max = settings.maxLogEntries ?? 500
    if (_mediaLog.length > max) _mediaLog.splice(0, _mediaLog.length - max)

    await flushLog(settings).catch(() => {})
  },

  /**
   * auth.login — intercept login attempts.
   * Context: { username }
   * Return:  { denied: true, reason: string } to block login, or null to allow
   */
  'auth.login': async ({ username }, settings) => {
    const blocked = (settings.blockedUsers ?? '')
      .split(',')
      .map(u => u.trim().toLowerCase())
      .filter(Boolean)

    if (blocked.includes(username.toLowerCase())) {
      return { denied: true, reason: 'Your account has been restricted by a server plugin.' }
    }
    return null
  },

  /**
   * scan.complete — notification fired after a library scan finishes.
   * Context: { library, itemCount }
   * Return:  void
   */
  'scan.complete': async ({ library, itemCount }, settings) => {
    if (_log && settings.notifyLevel === 'info') {
      _log.info(`[example-plugin] Scan complete: "${library.name}" — ${itemCount} new item(s)`)
    }
  },
}

// ── Scheduled tasks ───────────────────────────────────────────────────────────

export const tasks = [
  {
    // ID must be namespaced with the plugin id
    id:          'example-plugin.daily-report',
    name:        'Example Plugin Daily Report',
    description: 'Logs a daily summary of items tracked by the Example Plugin.',
    category:    'Example Plugin',

    defaultTriggers: [
      { type: 'daily', timeOfDay: '06:00' },
    ],

    /**
     * execute receives the standard TaskScheduler context plus the plugin's
     * current settings as a second argument.
     */
    execute: async ({ db, log, signal, progress }, settings) => {
      log.info('[example-plugin.daily-report] Starting daily report')
      progress(10)

      if (signal.aborted) return

      // Count items added in the last 24 h
      const { rows } = await db.query(`
        SELECT COUNT(*) AS new_today
        FROM media_items
        WHERE created_at >= now() - interval '24 hours'
      `)
      const newToday = parseInt(rows[0].new_today)
      progress(50)

      if (signal.aborted) return

      log.info(`[example-plugin.daily-report] ${newToday} new media item(s) in the last 24 hours`)
      log.info(`[example-plugin.daily-report] Total tracked in log: ${_mediaLog.length}`)
      progress(100)
    },
  },
]

// ── Helpers ───────────────────────────────────────────────────────────────────

async function flushLog(settings) {
  if (!_dataDir) return
  const filename = settings?.logFile ?? 'media-log.json'
  await writeFile(
    join(_dataDir, filename),
    JSON.stringify(_mediaLog, null, 2),
    'utf8'
  )
}
