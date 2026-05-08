import { requireAdmin } from '../middleware/auth.js'
import { invalidateSettingsCache } from '../services/settingsCache.js'

// Keys that must never be returned to non-admin callers
const SENSITIVE_KEYS = new Set(['tmdb.api_key'])

export default async function settingsRoutes(app) {
  // Public endpoint — returns non-sensitive settings the UI needs before login
  // (server name, registration toggle).
  app.get('/public', async () => {
    const { rows } = await app.db.query(
      "SELECT key, value FROM settings WHERE category = 'general'"
    )
    return Object.fromEntries(
      rows.filter(r => !SENSITIVE_KEYS.has(r.key)).map(r => [r.key, r.value])
    )
  })

  // All routes below require admin
  app.addHook('preHandler', app.authenticate)
  app.addHook('preHandler', requireAdmin)

  // Full settings dump, grouped by category
  app.get('/', async () => {
    const { rows } = await app.db.query(
      'SELECT key, value, category, label, description FROM settings ORDER BY category, key'
    )
    const grouped = {}
    for (const row of rows) {
      if (!grouped[row.category]) grouped[row.category] = []
      grouped[row.category].push(row)
    }
    return grouped
  })

  // Bulk update — body is { "key": value, ... }
  // Only updates keys that already exist in the table (no injection of arbitrary keys).
  app.put('/', async (request, reply) => {
    const updates = request.body
    if (typeof updates !== 'object' || Array.isArray(updates)) {
      return reply.code(400).send({ error: 'Body must be a key/value object' })
    }

    const { rows: existing } = await app.db.query('SELECT key FROM settings')
    const validKeys = new Set(existing.map(r => r.key))

    const entries = Object.entries(updates).filter(([k]) => validKeys.has(k))
    if (!entries.length) return reply.code(400).send({ error: 'No valid keys provided' })

    for (const [key, value] of entries) {
      await app.db.query(
        'UPDATE settings SET value=$1, updated_at=now() WHERE key=$2',
        [JSON.stringify(value), key]
      )
    }

    invalidateSettingsCache()
    return { updated: entries.map(([k]) => k) }
  })

  // Single key update
  app.put('/:key', async (request, reply) => {
    const { key } = request.params
    const { value } = request.body

    const { rowCount } = await app.db.query(
      'UPDATE settings SET value=$1, updated_at=now() WHERE key=$2',
      [JSON.stringify(value), key]
    )
    if (!rowCount) return reply.code(404).send({ error: 'Setting not found' })

    invalidateSettingsCache()
    return { key, value }
  })
}
