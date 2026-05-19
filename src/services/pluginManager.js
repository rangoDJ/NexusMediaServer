/**
 * PluginManager — Jellyfin-inspired plugin system for NexusMediaServer.
 *
 * Plugin contract (what a plugin file/folder exports)
 * ────────────────────────────────────────────────────
 *
 *   export const manifest = {
 *     id:               'my-plugin',        // required — unique slug
 *     name:             'My Plugin',        // required
 *     version:          '1.0.0',
 *     description:      'Short summary',
 *     overview:         'Longer markdown description',
 *     author:           'Your Name',
 *     category:         'Metadata',         // Metadata|Notifications|Authentication|General
 *     homepage:         'https://...',
 *     minServerVersion: '0.1.0',            // semver — skip if not met
 *     permissions:      ['http.fetch'],     // declared capabilities (informational)
 *
 *     // JSON-Schema-lite — used to validate settings and render a UI form
 *     settingsSchema: {
 *       apiKey: { type: 'string', title: 'API Key', required: true, secret: true },
 *       lang:   { type: 'string', title: 'Language', default: 'en', enum: ['en','fr'] },
 *       max:    { type: 'number', title: 'Max results', default: 10, minimum: 1, maximum: 100 },
 *     },
 *   }
 *
 *   // Lifecycle — all optional
 *   export async function onLoad({ db, log, settings, dataDir }) { }
 *   export async function onUnload({ log, settings }) { }
 *   export async function onSettingsChanged({ newSettings, oldSettings, log }) { }
 *
 *   // Event hooks — optional (5 s timeout per call)
 *   export const hooks = {
 *     'stream.start':  async ({ filePath, codec }, settings) => ({ codec: 'h265' }),
 *     'media.added':   async ({ type, id, title }, settings) => { },
 *   }
 *
 *   // Scheduled tasks — optional, auto-registered with TaskScheduler
 *   export const tasks = [
 *     {
 *       id:              'my-plugin.daily-sync',   // must be namespaced with plugin id
 *       name:            'My Plugin Daily Sync',
 *       description:     '...',
 *       category:        'My Plugin',
 *       defaultTriggers: [{ type: 'daily', timeOfDay: '03:00' }],
 *       execute: async ({ db, log, signal, progress }, settings) => { },
 *     },
 *   ]
 *
 * Available hooks
 * ───────────────
 *   api.routes         { app }                              → void   (register Fastify routes)
 *   stream.start       { filePath, codec, resolution }      → { codec?, resolution?, bitrate? }
 *   metadata.movie     { title, year, tmdbMeta, nfo }       → metadata overrides
 *   metadata.series    { title, tmdbMeta, nfo }             → metadata overrides
 *   media.added        { type, id, title, year, tmdb_id }   → void   (notification)
 *   scan.complete      { library, itemCount }               → void   (notification)
 *   auth.login         { username }                         → { denied: true, reason: string }
 *   subtitle.providers { mediaItemId, episodeId }           → { tracks: SubtitleTrack[] }
 */

import { readdir, mkdir, rm, writeFile } from 'fs/promises'
import { existsSync } from 'fs'
import { join, basename, resolve as resolvePath } from 'path'
import { pathToFileURL } from 'url'
import axios from 'axios'

const SERVER_VERSION = '0.1.0'
const HOOK_TIMEOUT_MS = 5_000
const PLUGINS_PATH = process.env.PLUGINS_PATH ?? '/plugins'
const PLUGINS_DATA_ROOT = process.env.PLUGINS_DATA_PATH
  ?? join(PLUGINS_PATH, '..', 'plugin-data')

// ── Registry (shared with pluginLoader.js shim for backward compat) ───────────
export const registry = {
  plugins: new Map(), // id → RegistryEntry
  hooks:   new Map(), // hookName → [{ pluginId, fn, priority }]
}

/**
 * @typedef {Object} RegistryEntry
 * @property {object}   manifest
 * @property {object}   hooks      — { hookName: fn }
 * @property {object[]} tasks      — task definition objects
 * @property {object}   settings   — merged (defaults ← saved)
 * @property {string}   filePath   — absolute path to entry point
 * @property {string}   dataDir    — per-plugin writable directory
 * @property {Function} [onUnload]
 * @property {Function} [onSettingsChanged]
 */

// ── PluginManager ─────────────────────────────────────────────────────────────

class PluginManager {
  /** @type {import('./taskScheduler.js').TaskScheduler|null} */
  #scheduler = null

  // ── Loading ────────────────────────────────────────────────────────────────

  /**
   * Load all plugins from PLUGINS_PATH.
   * @param {import('pg').Pool}                              db
   * @param {import('fastify').FastifyBaseLogger}            log
   * @param {import('./taskScheduler.js').TaskScheduler}     scheduler
   */
  async loadAll(db, log, scheduler) {
    this.#scheduler = scheduler

    if (!existsSync(PLUGINS_PATH)) {
      log.info(`[plugins] Directory "${PLUGINS_PATH}" not found — no plugins loaded`)
      return
    }

    await mkdir(PLUGINS_DATA_ROOT, { recursive: true })

    const entries = await readdir(PLUGINS_PATH, { withFileTypes: true })

    for (const entry of entries) {
      let entryPath
      if (entry.isDirectory()) {
        entryPath = join(PLUGINS_PATH, entry.name, 'index.js')
      } else if (entry.isFile() && entry.name.endsWith('.js') && entry.name !== 'index.js') {
        entryPath = join(PLUGINS_PATH, entry.name)
      } else {
        continue
      }

      if (!existsSync(entryPath)) continue
      await this.#loadOne(entryPath, db, log)
    }

    log.info(`[plugins] System ready — ${registry.plugins.size} plugin(s) active`)
  }

  /** @returns {string} absolute path of the plugin's writable data directory */
  getDataDir(pluginId) {
    return join(PLUGINS_DATA_ROOT, pluginId)
  }

  // ── Core load ──────────────────────────────────────────────────────────────

  async #loadOne(entryPath, db, log) {
    // The canonical plugin ID comes from manifest.id, not the filename

    try {
      // Dynamic import — plugins intentionally run at full trust (self-hosted)
      const mod = await import(pathToFileURL(entryPath).href)
      const { manifest, hooks = {}, tasks = [], onLoad, onUnload, onSettingsChanged } = mod

      if (!manifest?.id || !manifest?.name) {
        log.warn(`[plugins] "${entryPath}" missing manifest.id or manifest.name — skipped`)
        return
      }

      // ── Version compatibility check (like Jellyfin's targetAbi) ───────────
      if (manifest.minServerVersion && !semverSatisfies(SERVER_VERSION, manifest.minServerVersion)) {
        log.warn(
          `[plugins] "${manifest.name}" requires server >= ${manifest.minServerVersion} ` +
          `(current: ${SERVER_VERSION}) — skipped`
        )
        await this.#upsertRecord(db, manifest, entryPath, {
          error: `Requires server version >= ${manifest.minServerVersion}`,
        })
        return
      }

      // ── DB record — load persisted enabled + settings ─────────────────────
      const { rows } = await db.query('SELECT is_enabled, settings FROM plugins WHERE id=$1', [manifest.id])
      const dbRow    = rows[0]
      const isEnabled = dbRow?.is_enabled ?? true
      const savedSettings = dbRow?.settings ?? {}
      const settings = applyDefaults(manifest.settingsSchema ?? {}, savedSettings)

      // ── Validate saved settings against schema ────────────────────────────
      const validationErrors = validateSettings(manifest.settingsSchema ?? {}, settings)
      if (validationErrors.length) {
        log.warn(`[plugins] "${manifest.name}" has invalid settings: ${validationErrors.join('; ')}`)
      }

      // ── Upsert DB record ──────────────────────────────────────────────────
      const dataDir = this.getDataDir(manifest.id)
      await mkdir(dataDir, { recursive: true })

      await this.#upsertRecord(db, manifest, entryPath, {
        isEnabled,
        settings,
        dataDir,
        hasError: false,
      })

      if (!isEnabled) {
        log.info(`[plugins] "${manifest.name}" is disabled — skipping`)
        return
      }

      // ── Register in memory ────────────────────────────────────────────────
      registry.plugins.set(manifest.id, {
        manifest,
        hooks,
        tasks,
        settings,
        filePath: entryPath,
        dataDir,
        onUnload,
        onSettingsChanged,
      })

      // ── Register hooks ────────────────────────────────────────────────────
      for (const [hookName, fn] of Object.entries(hooks)) {
        if (typeof fn !== 'function') continue
        if (!registry.hooks.has(hookName)) registry.hooks.set(hookName, [])
        registry.hooks.get(hookName).push({ pluginId: manifest.id, fn })
      }

      // ── Register plugin tasks with TaskScheduler ──────────────────────────
      if (tasks.length && this.#scheduler) {
        for (const taskDef of tasks) {
          if (!taskDef.id || !taskDef.execute) {
            log.warn(`[plugins] "${manifest.name}" task missing id or execute — skipped`)
            continue
          }
          // Enforce namespace: task id must start with plugin id
          if (!taskDef.id.startsWith(manifest.id)) {
            log.warn(
              `[plugins] "${manifest.name}" task "${taskDef.id}" must be namespaced as ` +
              `"${manifest.id}.*" — skipped`
            )
            continue
          }
          try {
            // Wrap execute to inject plugin settings automatically
            const pluginSettings = () => registry.plugins.get(manifest.id)?.settings ?? {}
            const wrappedTask = {
              ...taskDef,
              execute: (ctx) => taskDef.execute(ctx, pluginSettings()),
            }
            this.#scheduler.register(wrappedTask)
            log.info(`[plugins] Registered task "${taskDef.id}" from "${manifest.name}"`)
          } catch (err) {
            log.warn({ err }, `[plugins] Failed to register task "${taskDef.id}"`)
          }
        }
      }

      // ── Call onLoad lifecycle hook ─────────────────────────────────────────
      if (typeof onLoad === 'function') {
        try {
          await withTimeout(
            onLoad({ db, log, settings, dataDir }),
            30_000,
            `${manifest.name}.onLoad`
          )
        } catch (err) {
          log.warn({ err }, `[plugins] "${manifest.name}" onLoad failed`)
        }
      }

      log.info(`[plugins] Loaded "${manifest.name}" v${manifest.version ?? '?'} [${manifest.id}]`)
    } catch (err) {
      log.error(err, `[plugins] Failed to load plugin at "${entryPath}"`)
      const fallbackId = basename(
        entryPath.endsWith('index.js') ? join(entryPath, '..') : entryPath,
        '.js'
      )
      await db.query(`
        INSERT INTO plugins(id, name, error, loaded_at)
        VALUES ($1, $1, $2, now())
        ON CONFLICT(id) DO UPDATE SET error=$2, loaded_at=now()
      `, [fallbackId, err.message])
        .catch(dbErr => log.warn({ err: dbErr }, `[plugins] Failed to record load error`))
    }
  }

  // ── Unload ─────────────────────────────────────────────────────────────────

  async unloadPlugin(pluginId, log) {
    const entry = registry.plugins.get(pluginId)
    if (!entry) return

    // Call onUnload lifecycle
    if (typeof entry.onUnload === 'function') {
      try {
        await withTimeout(
          entry.onUnload({ log, settings: entry.settings }),
          10_000,
          `${pluginId}.onUnload`
        )
      } catch (err) {
        log.warn({ err }, `[plugins] "${pluginId}" onUnload failed`)
      }
    }

    // Remove hooks
    for (const handlers of registry.hooks.values()) {
      const idx = handlers.findIndex(h => h.pluginId === pluginId)
      while (idx !== -1) {
        handlers.splice(idx, 1)
        // Don't search again — findIndex returns first match
        break
      }
    }
    // Clean out empty hook arrays
    for (const [name, handlers] of registry.hooks.entries()) {
      if (!handlers.length) registry.hooks.delete(name)
    }

    registry.plugins.delete(pluginId)
    log.info(`[plugins] Unloaded "${pluginId}"`)
  }

  // ── Enable / disable ──────────────────────────────────────────────────────

  async setEnabled(pluginId, enabled, db, log) {
    const { rowCount } = await db.query(
      'UPDATE plugins SET is_enabled=$1 WHERE id=$2',
      [enabled, pluginId]
    )
    if (!rowCount) throw new Error('Plugin not found')

    if (!enabled && registry.plugins.has(pluginId)) {
      await this.unloadPlugin(pluginId, log)
    }

    return { restart_required: enabled } // enabling requires reload/restart to re-import
  }

  // ── Reload (hot) ──────────────────────────────────────────────────────────

  async reload(pluginId, db, log) {
    const entry = registry.plugins.get(pluginId)
    const filePath = entry?.filePath
      ?? (await db.query('SELECT install_url FROM plugins WHERE id=$1', [pluginId])).rows[0]?.install_url

    if (!filePath) throw new Error(`Cannot reload "${pluginId}" — file path unknown`)

    if (entry) await this.unloadPlugin(pluginId, log)
    await this.#loadOne(filePath, db, log)
    log.info(`[plugins] Reloaded "${pluginId}"`)
  }

  // ── Settings update ────────────────────────────────────────────────────────

  async updateSettings(pluginId, newSettings, db, log) {
    const entry = registry.plugins.get(pluginId)
    const schema = entry?.manifest?.settingsSchema ?? {}

    // Validate against schema
    const errors = validateSettings(schema, newSettings)
    if (errors.length) throw new Error(`Invalid settings: ${errors.join('; ')}`)

    // Merge with existing
    const { rows } = await db.query('SELECT settings FROM plugins WHERE id=$1', [pluginId])
    if (!rows.length) throw new Error('Plugin not found')
    const merged = { ...(rows[0].settings ?? {}), ...newSettings }

    await db.query('UPDATE plugins SET settings=$1 WHERE id=$2', [JSON.stringify(merged), pluginId])

    // Hot-apply in memory
    if (entry) {
      const oldSettings = entry.settings
      entry.settings = merged

      if (typeof entry.onSettingsChanged === 'function') {
        try {
          await withTimeout(
            entry.onSettingsChanged({ newSettings: merged, oldSettings, log }),
            5_000,
            `${pluginId}.onSettingsChanged`
          )
        } catch (err) {
          log.warn({ err }, `[plugins] "${pluginId}" onSettingsChanged failed`)
        }
      }
    }

    return merged
  }

  // ── Install ───────────────────────────────────────────────────────────────

  /**
   * Install a plugin from a URL (must be a .js file).
   * ZIP support requires the 'fflate' package — not yet included.
   *
   * @param {string} downloadUrl
   * @param {string} [pluginName]  — saved filename; auto-detected from URL if omitted
   * @param {import('pg').Pool} db
   * @param {import('fastify').FastifyBaseLogger} log
   */
  async install(downloadUrl, pluginName, db, log) {
    log.info(`[plugins] Downloading plugin from ${downloadUrl}`)

    let content
    try {
      const { data } = await axios.get(downloadUrl, {
        responseType: 'text',
        timeout: 30_000,
        maxContentLength: 10 * 1024 * 1024, // 10 MB max
      })
      content = data
    } catch (err) {
      throw new Error(`Download failed: ${err.message}`)
    }

    // Determine filename
    const filename = pluginName
      ?? basename(new URL(downloadUrl).pathname)
      ?? 'plugin.js'
    const destPath = join(PLUGINS_PATH, filename.endsWith('.js') ? filename : `${filename}.js`)

    await writeFile(destPath, content, 'utf8')
    log.info(`[plugins] Saved plugin to ${destPath}`)

    // Load it
    await this.#loadOne(destPath, db, log)

    // Record install source
    const importedEntry = [...registry.plugins.values()].find(e => e.filePath === destPath)
    if (importedEntry) {
      await db.query(
        "UPDATE plugins SET install_source='url', install_url=$1 WHERE id=$2",
        [downloadUrl, importedEntry.manifest.id]
      )
    }

    return importedEntry?.manifest ?? null
  }

  // ── Uninstall ─────────────────────────────────────────────────────────────

  async uninstall(pluginId, db, log) {
    const entry = registry.plugins.get(pluginId)
    const { rows } = await db.query('SELECT * FROM plugins WHERE id=$1', [pluginId])
    if (!rows.length) throw new Error('Plugin not found in DB')

    // Unload from memory
    if (entry) await this.unloadPlugin(pluginId, log)

    // Delete files
    const filePath = entry?.filePath
    if (filePath && existsSync(filePath)) {
      const isDir = filePath.endsWith('index.js')
      try {
        if (isDir) {
          await rm(resolvePath(filePath, '..'), { recursive: true, force: true })
        } else {
          await rm(filePath, { force: true })
        }
        log.info(`[plugins] Deleted plugin files for "${pluginId}"`)
      } catch (err) {
        log.warn({ err }, `[plugins] Could not delete plugin files for "${pluginId}"`)
      }
    }

    // Remove DB record
    await db.query('DELETE FROM plugins WHERE id=$1', [pluginId])
    log.info(`[plugins] Uninstalled "${pluginId}"`)
  }

  // ── Catalog ───────────────────────────────────────────────────────────────

  /**
   * Fetch plugin listings from all enabled catalog sources.
   * Each source must serve JSON matching the CatalogManifest shape (see docs/plugin-catalog-format.md).
   * @returns {{ source: string, plugins: CatalogPlugin[] }[]}
   */
  async getCatalog(db, log) {
    const { rows: sources } = await db.query(
      'SELECT * FROM plugin_catalog_sources WHERE is_enabled=true ORDER BY name'
    )

    const results = await Promise.allSettled(
      sources.map(async source => {
        const { data } = await axios.get(source.url, { timeout: 10_000 })
        return {
          sourceId:       source.id,
          sourceName:     source.name,
          repositoryName: data.repositoryName ?? source.name,
          plugins:        Array.isArray(data.plugins) ? data.plugins : [],
        }
      })
    )

    const catalog = []
    for (let i = 0; i < results.length; i++) {
      if (results[i].status === 'fulfilled') {
        catalog.push(results[i].value)
      } else {
        log?.warn(`[plugins] Catalog source "${sources[i].name}" failed: ${results[i].reason?.message}`)
        catalog.push({ sourceId: sources[i].id, sourceName: sources[i].name, error: results[i].reason?.message, plugins: [] })
      }
    }

    return catalog
  }

  async addCatalogSource(name, url, db) {
    const { rows } = await db.query(
      'INSERT INTO plugin_catalog_sources(name, url) VALUES($1, $2) RETURNING *',
      [name, url]
    )
    return rows[0]
  }

  async removeCatalogSource(id, db) {
    const { rowCount } = await db.query('DELETE FROM plugin_catalog_sources WHERE id=$1', [id])
    return rowCount > 0
  }

  async listCatalogSources(db) {
    const { rows } = await db.query('SELECT * FROM plugin_catalog_sources ORDER BY name')
    return rows
  }

  // ── Hook execution ────────────────────────────────────────────────────────

  /**
   * Call all handlers registered for a hook in load order.
   * Each handler has a 5 s timeout.  Failures are logged and skipped.
   * @returns {any[]} collected non-null return values
   */
  async callHook(hookName, context, log) {
    const handlers = registry.hooks.get(hookName)
    if (!handlers?.length) return []

    const results = []
    for (const { pluginId, fn } of handlers) {
      const { settings } = registry.plugins.get(pluginId) ?? {}
      try {
        const result = await withTimeout(
          fn(context, settings ?? {}),
          HOOK_TIMEOUT_MS,
          `${pluginId}/${hookName}`
        )
        if (result != null) results.push(result)
      } catch (err) {
        log?.warn(`[plugins] "${pluginId}" hook "${hookName}" ${err.message}`)
      }
    }
    return results
  }

  /** In-memory settings update (no DB write — for use by plugins internally). */
  updatePluginSettings(pluginId, settings) {
    const entry = registry.plugins.get(pluginId)
    if (entry) entry.settings = settings
  }

  // ── Private helpers ───────────────────────────────────────────────────────

  async #upsertRecord(db, manifest, entryPath, { isEnabled = true, settings, dataDir, hasError = false, error } = {}) {
    const dataDir_ = dataDir ?? this.getDataDir(manifest.id)
    await db.query(`
      INSERT INTO plugins(
        id, name, version, description, overview, author, category,
        homepage, min_server_version, permissions, settings_schema,
        data_path, is_enabled, settings, has_tasks, error, loaded_at
      )
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,now())
      ON CONFLICT(id) DO UPDATE SET
        name=$2, version=$3, description=$4, overview=$5, author=$6, category=$7,
        homepage=$8, min_server_version=$9, permissions=$10, settings_schema=$11,
        data_path=$12, has_tasks=$15,
        error = CASE WHEN $16::text IS NOT NULL THEN $16 ELSE NULL END,
        loaded_at = now()
    `, [
      manifest.id,
      manifest.name,
      manifest.version     ?? null,
      manifest.description ?? null,
      manifest.overview    ?? null,
      manifest.author      ?? null,
      manifest.category    ?? null,
      manifest.homepage    ?? null,
      manifest.minServerVersion ?? null,
      manifest.permissions ?? [],
      JSON.stringify(manifest.settingsSchema ?? {}),
      dataDir_,
      isEnabled,
      JSON.stringify(settings ?? {}),
      (manifest.tasks?.length ?? 0) > 0,
      error ?? null,
    ])
  }
}

// ── Singleton export ──────────────────────────────────────────────────────────

export const pluginManager = new PluginManager()

// Convenience re-exports for backward compatibility with pluginLoader.js consumers
export async function callHook(hookName, context, log) {
  return pluginManager.callHook(hookName, context, log)
}
export function updatePluginSettings(pluginId, settings) {
  return pluginManager.updatePluginSettings(pluginId, settings)
}
export async function loadPlugins(db, log, scheduler) {
  return pluginManager.loadAll(db, log, scheduler)
}

// ── Utilities ─────────────────────────────────────────────────────────────────

/** Race a promise against a timeout. */
function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error(`Timed out after ${ms}ms`)), ms)
    ),
  ])
}

/**
 * Validate settings against a settingsSchema.
 * Returns an array of error strings (empty = valid).
 */
export function validateSettings(schema, settings) {
  const errors = []
  for (const [key, rule] of Object.entries(schema)) {
    const value = settings[key]
    const missing = value === undefined || value === null || value === ''

    if (rule.required && missing) {
      errors.push(`"${key}" is required`)
      continue
    }
    if (missing) continue

    if (rule.type === 'string'  && typeof value !== 'string')  errors.push(`"${key}" must be a string`)
    if (rule.type === 'number'  && typeof value !== 'number')  errors.push(`"${key}" must be a number`)
    if (rule.type === 'boolean' && typeof value !== 'boolean') errors.push(`"${key}" must be a boolean`)
    if (rule.enum && !rule.enum.includes(value))
      errors.push(`"${key}" must be one of: ${rule.enum.join(', ')}`)
    if (rule.minimum  !== undefined && value < rule.minimum)
      errors.push(`"${key}" must be >= ${rule.minimum}`)
    if (rule.maximum  !== undefined && value > rule.maximum)
      errors.push(`"${key}" must be <= ${rule.maximum}`)
    if (rule.minLength !== undefined && String(value).length < rule.minLength)
      errors.push(`"${key}" must be at least ${rule.minLength} characters`)
    if (rule.maxLength !== undefined && String(value).length > rule.maxLength)
      errors.push(`"${key}" must be at most ${rule.maxLength} characters`)
    if (rule.pattern && !new RegExp(rule.pattern).test(String(value)))
      errors.push(`"${key}" does not match the required pattern`)
  }
  return errors
}

/**
 * Apply schema defaults to a settings object (non-destructive — existing values win).
 */
function applyDefaults(schema, settings) {
  const result = { ...settings }
  for (const [key, rule] of Object.entries(schema)) {
    if (result[key] === undefined && rule.default !== undefined) {
      result[key] = rule.default
    }
  }
  return result
}

/**
 * Minimal semver "greater-than-or-equal" check.
 * Returns true if `current` >= `required`.
 * Only handles x.y.z numeric comparisons.
 */
function semverSatisfies(current, required) {
  const parse = v => String(v).split('.').map(Number)
  const [ca, cb, cc] = parse(current)
  const [ra, rb, rc] = parse(required)
  if (ca !== ra) return ca > ra
  if (cb !== rb) return cb > rb
  return cc >= rc
}
