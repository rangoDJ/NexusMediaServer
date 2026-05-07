import { requireAdmin } from '../middleware/auth.js'
import { registry, updatePluginSettings } from '../services/pluginLoader.js'

export default async function pluginRoutes(app) {
  app.addHook('preHandler', [app.authenticate, requireAdmin])

  // List all known plugins (DB records merged with live registry state)
  app.get('/', async () => {
    const { rows } = await app.db.query(
      `SELECT id, name, version, description, author,
              is_enabled, settings, error, loaded_at, created_at
       FROM plugins ORDER BY name`
    )
    return rows.map(row => ({
      ...row,
      loaded: registry.plugins.has(row.id),
      hooks: registry.plugins.get(row.id)
        ? Object.keys(registry.plugins.get(row.id).hooks)
        : [],
      // Expose the manifest's defaultSettings schema so the UI can render a form
      default_settings: registry.plugins.get(row.id)?.manifest?.defaultSettings ?? null,
    }))
  })

  // Enable or disable a plugin (takes effect after restart)
  app.patch('/:id/enabled', async (request, reply) => {
    const { enabled } = request.body
    const { rowCount } = await app.db.query(
      'UPDATE plugins SET is_enabled=$1 WHERE id=$2',
      [enabled, request.params.id]
    )
    if (!rowCount) return reply.code(404).send({ error: 'Plugin not found' })
    return { id: request.params.id, is_enabled: enabled, restart_required: true }
  })

  // Update plugin settings — takes effect immediately (no restart needed)
  app.put('/:id/settings', async (request, reply) => {
    const { settings } = request.body
    if (typeof settings !== 'object' || Array.isArray(settings)) {
      return reply.code(400).send({ error: 'settings must be an object' })
    }

    const { rows } = await app.db.query('SELECT id FROM plugins WHERE id=$1', [request.params.id])
    if (!rows.length) return reply.code(404).send({ error: 'Plugin not found' })

    // Merge with existing settings so partial updates work
    const { rows: existing } = await app.db.query('SELECT settings FROM plugins WHERE id=$1', [request.params.id])
    const merged = { ...(existing[0]?.settings ?? {}), ...settings }

    await app.db.query('UPDATE plugins SET settings=$1 WHERE id=$2', [JSON.stringify(merged), request.params.id])
    updatePluginSettings(request.params.id, merged)

    return { id: request.params.id, settings: merged }
  })
}
