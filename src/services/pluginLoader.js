import { readdir } from 'fs/promises'
import { join } from 'path'
import { pathToFileURL } from 'url'
import { existsSync } from 'fs'

const PLUGINS_PATH = process.env.PLUGINS_PATH ?? '/plugins'

// In-memory registry — rebuilt on every startup.
// plugins: pluginId → { manifest, hooks, settings }
// hooks:   hookName → [{ pluginId, fn }]
export const registry = {
  plugins: new Map(),
  hooks: new Map(),
}

export async function loadPlugins(db, log) {
  if (!existsSync(PLUGINS_PATH)) {
    log.info(`Plugin directory "${PLUGINS_PATH}" not found — no plugins loaded`)
    return
  }

  const entries = await readdir(PLUGINS_PATH, { withFileTypes: true })

  for (const entry of entries) {
    // Support both directory plugins (folder/index.js) and single-file plugins (plugin.js)
    let entryPath
    if (entry.isDirectory()) {
      entryPath = join(PLUGINS_PATH, entry.name, 'index.js')
    } else if (entry.isFile() && entry.name.endsWith('.js') && entry.name !== 'index.js') {
      entryPath = join(PLUGINS_PATH, entry.name)
    } else {
      continue
    }

    if (!existsSync(entryPath)) continue

    const pluginId = entry.name.replace(/\.js$/, '')

    try {
      // Dynamic import — plugins are untrusted code run by the server admin.
      // They have full access to Node.js APIs, which is intentional for self-hosted use.
      const mod = await import(pathToFileURL(entryPath).href)
      const { manifest, hooks } = mod

      if (!manifest?.id || !manifest?.name) {
        log.warn(`Plugin at "${entryPath}" is missing manifest.id or manifest.name — skipped`)
        continue
      }

      // Load persisted state from DB (merge defaults ← saved settings)
      const { rows } = await db.query(
        'SELECT is_enabled, settings FROM plugins WHERE id=$1',
        [manifest.id]
      )
      const dbRow = rows[0]
      const isEnabled = dbRow?.is_enabled ?? true
      const settings = { ...(manifest.defaultSettings ?? {}), ...(dbRow?.settings ?? {}) }

      // Upsert plugin record (preserves is_enabled and settings across restarts)
      await db.query(`
        INSERT INTO plugins(id, name, version, description, author, is_enabled, settings, loaded_at)
        VALUES($1,$2,$3,$4,$5,$6,$7,now())
        ON CONFLICT(id) DO UPDATE
          SET name=$2, version=$3, description=$4, author=$5, loaded_at=now(), error=NULL
      `, [manifest.id, manifest.name, manifest.version ?? null,
          manifest.description ?? null, manifest.author ?? null,
          isEnabled, JSON.stringify(settings)])

      if (!isEnabled) {
        log.info(`Plugin "${manifest.name}" is disabled — skipped`)
        continue
      }

      registry.plugins.set(manifest.id, { manifest, hooks: hooks ?? {}, settings })

      // Register each hook this plugin exports
      for (const [hookName, fn] of Object.entries(hooks ?? {})) {
        if (typeof fn !== 'function') continue
        if (!registry.hooks.has(hookName)) registry.hooks.set(hookName, [])
        registry.hooks.get(hookName).push({ pluginId: manifest.id, fn })
      }

      log.info(`Loaded plugin: "${manifest.name}" v${manifest.version ?? '?'} [${manifest.id}]`)
    } catch (err) {
      log.error(err, `Failed to load plugin at "${entryPath}"`)
      // Record the error so it shows in the admin UI
      await db.query(`
        INSERT INTO plugins(id, name, error) VALUES($1,$1,$2)
        ON CONFLICT(id) DO UPDATE SET error=$2, loaded_at=now()
      `, [pluginId, err.message]).catch(() => {})
    }
  }

  log.info(`Plugin system ready — ${registry.plugins.size} plugin(s) active`)
}

// Call all handlers registered for a hook in load order.
// Results from each handler are collected and returned.
// A plugin that throws is logged and skipped — it never crashes the server.
export async function callHook(hookName, context, log) {
  const handlers = registry.hooks.get(hookName)
  if (!handlers?.length) return []

  const results = []
  for (const { pluginId, fn } of handlers) {
    const { settings } = registry.plugins.get(pluginId) ?? {}
    try {
      const result = await fn(context, settings ?? {})
      if (result != null) results.push(result)
    } catch (err) {
      log?.warn(`Plugin "${pluginId}" threw on hook "${hookName}": ${err.message}`)
    }
  }
  return results
}

// Update a plugin's in-memory settings immediately (no restart needed for settings changes).
export function updatePluginSettings(pluginId, settings) {
  const entry = registry.plugins.get(pluginId)
  if (entry) entry.settings = settings
}
