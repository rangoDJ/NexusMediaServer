import { requireAdmin } from '../middleware/auth.js'
import { pluginManager, registry, validateSettings } from '../services/pluginManager.js'

/**
 * Plugins REST API — all routes require admin.
 *
 * Installed plugins
 *   GET    /                     List all plugins (DB + live registry state)
 *   GET    /:id                  Single plugin detail
 *   PATCH  /:id/enabled          Enable / disable (disable = immediate unload)
 *   PUT    /:id/settings         Update settings (immediate hot-apply + onSettingsChanged)
 *   POST   /:id/reload           Hot-reload a plugin from disk
 *   DELETE /:id                  Uninstall (unload + delete files + remove DB record)
 *
 * Installation
 *   POST   /install              Install from download URL
 *
 * Catalog
 *   GET    /catalog              Aggregate packages from all enabled sources
 *   GET    /catalog/sources      List configured catalog sources
 *   POST   /catalog/sources      Add a catalog source
 *   DELETE /catalog/sources/:id  Remove a catalog source
 */
export default async function pluginRoutes(app) {
  app.addHook('preHandler', app.authenticate)
  app.addHook('preHandler', requireAdmin)

  // ── List installed plugins ────────────────────────────────────────────────

  app.get('/', async () => {
    const { rows } = await app.db.query(`
      SELECT id, name, version, description, overview, author, category,
             homepage, min_server_version, permissions, settings_schema,
             data_path, has_tasks, is_enabled, settings, error, install_source,
             loaded_at, created_at
      FROM plugins
      ORDER BY name
    `)
    return rows.map(row => serializePlugin(row))
  })

  // ── Single plugin ─────────────────────────────────────────────────────────

  app.get('/:id', async (request, reply) => {
    const { rows } = await app.db.query(
      `SELECT id, name, version, description, overview, author, category,
              homepage, min_server_version, permissions, settings_schema,
              data_path, has_tasks, is_enabled, settings, error, install_source,
              loaded_at, created_at
       FROM plugins WHERE id=$1`,
      [request.params.id]
    )
    if (!rows.length) return reply.code(404).send({ error: 'Plugin not found' })
    return serializePlugin(rows[0])
  })

  // ── Enable / disable ──────────────────────────────────────────────────────

  app.patch('/:id/enabled', async (request, reply) => {
    const { enabled } = request.body
    if (typeof enabled !== 'boolean') {
      return reply.code(400).send({ error: 'enabled must be a boolean' })
    }
    try {
      const result = await pluginManager.setEnabled(request.params.id, enabled, app.db, app.log)
      return { id: request.params.id, is_enabled: enabled, ...result }
    } catch (err) {
      if (err.message === 'Plugin not found') return reply.code(404).send({ error: err.message })
      throw err
    }
  })

  // ── Update settings ───────────────────────────────────────────────────────

  app.put('/:id/settings', async (request, reply) => {
    const { settings } = request.body
    if (typeof settings !== 'object' || Array.isArray(settings) || settings === null) {
      return reply.code(400).send({ error: 'settings must be an object' })
    }
    try {
      const merged = await pluginManager.updateSettings(request.params.id, settings, app.db, app.log)
      return { id: request.params.id, settings: merged }
    } catch (err) {
      if (err.message.startsWith('Invalid settings:')) return reply.code(422).send({ error: err.message })
      if (err.message === 'Plugin not found') return reply.code(404).send({ error: err.message })
      throw err
    }
  })

  // ── Validate settings (dry run — no write) ────────────────────────────────

  app.post('/:id/settings/validate', async (request, reply) => {
    const { rows } = await app.db.query(
      'SELECT settings_schema FROM plugins WHERE id=$1',
      [request.params.id]
    )
    if (!rows.length) return reply.code(404).send({ error: 'Plugin not found' })

    const schema = rows[0].settings_schema ?? {}
    const errors = validateSettings(schema, request.body?.settings ?? {})
    return { valid: errors.length === 0, errors }
  })

  // ── Hot-reload ────────────────────────────────────────────────────────────

  app.post('/:id/reload', async (request, reply) => {
    try {
      await pluginManager.reload(request.params.id, app.db, app.log)
      return { id: request.params.id, reloaded: true }
    } catch (err) {
      if (err.message.includes('not found') || err.message.includes('unknown')) {
        return reply.code(404).send({ error: err.message })
      }
      throw err
    }
  })

  // ── Uninstall ─────────────────────────────────────────────────────────────

  app.delete('/:id', async (request, reply) => {
    try {
      await pluginManager.uninstall(request.params.id, app.db, app.log)
      return reply.code(204).send()
    } catch (err) {
      if (err.message.includes('not found')) return reply.code(404).send({ error: err.message })
      throw err
    }
  })

  // ── Install from URL ──────────────────────────────────────────────────────
  //
  // Body: { downloadUrl: string, pluginName?: string }
  // Downloads a .js plugin file from the given URL and loads it immediately.

  app.post('/install', async (request, reply) => {
    const { downloadUrl, pluginName } = request.body ?? {}
    if (!downloadUrl || typeof downloadUrl !== 'string') {
      return reply.code(400).send({ error: 'downloadUrl is required' })
    }
    try {
      const manifest = await pluginManager.install(downloadUrl, pluginName, app.db, app.log)
      return reply.code(201).send({ installed: true, plugin: manifest })
    } catch (err) {
      return reply.code(422).send({ error: err.message })
    }
  })

  // ── Catalog ───────────────────────────────────────────────────────────────

  // Aggregate plugin listings from all enabled catalog sources
  app.get('/catalog', async () => {
    return pluginManager.getCatalog(app.db, app.log)
  })

  // List catalog sources
  app.get('/catalog/sources', async () => {
    return pluginManager.listCatalogSources(app.db)
  })

  // Add a catalog source
  // Body: { name: string, url: string }
  app.post('/catalog/sources', async (request, reply) => {
    const { name, url } = request.body ?? {}
    if (!name || !url) return reply.code(400).send({ error: 'name and url are required' })
    try {
      const source = await pluginManager.addCatalogSource(name, url, app.db)
      return reply.code(201).send(source)
    } catch (err) {
      if (err.code === '23505') { // unique_violation
        return reply.code(409).send({ error: 'A catalog source with this URL already exists' })
      }
      throw err
    }
  })

  // Remove a catalog source
  app.delete('/catalog/sources/:id', async (request, reply) => {
    const removed = await pluginManager.removeCatalogSource(request.params.id, app.db)
    if (!removed) return reply.code(404).send({ error: 'Catalog source not found' })
    return reply.code(204).send()
  })
}

// ── Serializer ────────────────────────────────────────────────────────────────

function serializePlugin(row) {
  const live = registry.plugins.get(row.id)
  return {
    // Identity
    id:                 row.id,
    name:               row.name,
    version:            row.version,
    description:        row.description,
    overview:           row.overview,
    author:             row.author,
    category:           row.category,
    homepage:           row.homepage,
    min_server_version: row.min_server_version,
    permissions:        row.permissions ?? [],

    // State
    is_enabled:    row.is_enabled,
    loaded:        !!live,
    error:         row.error ?? null,
    install_source:row.install_source,
    loaded_at:     row.loaded_at,
    created_at:    row.created_at,

    // Settings
    settings:        row.settings ?? {},
    settings_schema: row.settings_schema ?? {},

    // Capabilities (from live registry if loaded, else DB metadata)
    hooks:     live ? Object.keys(live.hooks) : [],
    has_tasks: row.has_tasks ?? false,
    tasks:     live
      ? live.tasks.map(t => ({ id: t.id, name: t.name, description: t.description, category: t.category }))
      : [],

    // Storage
    data_path: row.data_path,
  }
}
