import { requireAdmin } from '../middleware/auth.js'
import { getSetting } from '../services/settingsCache.js'
import axios from 'axios'

// Default priority per hw_accel type — used when the transcoder doesn't send one
// and no settings row exists yet.
const DEFAULT_PRIORITY = { nvenc: 10, vaapi: 8, qsv: 8, cpu: 1 }
const PRIORITY_SETTING  = {
  nvenc: 'transcoding.nvenc_priority',
  vaapi: 'transcoding.vaapi_priority',
  qsv:   'transcoding.qsv_priority',
  cpu:   'transcoding.cpu_priority',
}

async function resolvePriority(db, hwAccel, explicitPriority) {
  if (explicitPriority != null) return parseInt(explicitPriority)
  const key = PRIORITY_SETTING[hwAccel] ?? PRIORITY_SETTING.cpu
  const raw = await getSetting(db, key, String(DEFAULT_PRIORITY[hwAccel] ?? 1))
  return parseInt(raw)
}

export default async function transcoderRoutes(app) {
  // Self-registration endpoint — no user auth, gated by the shared secret only.
  // Transcoder containers call this on startup so no manual admin step is needed.
  app.post('/register', async (request, reply) => {
    if (request.headers['x-transcoder-secret'] !== process.env.TRANSCODER_SECRET) {
      return reply.code(401).send({ error: 'Unauthorized' })
    }

    const { name, url, hw_accel, is_builtin, priority } = request.body
    if (!name || !url) return reply.code(400).send({ error: 'name and url required' })

    const hw       = hw_accel ?? 'cpu'
    const builtin  = Boolean(is_builtin)
    const resolved = await resolvePriority(app.db, hw, priority)

    const { rows } = await app.db.query(`
      INSERT INTO transcoder_nodes(name, url, hw_accel, is_builtin, priority, is_enabled, registered_at, last_seen_at)
      VALUES($1, $2, $3, $4, $5, true, now(), now())
      ON CONFLICT (url) DO UPDATE
        SET name=$1, hw_accel=$3, is_builtin=$4, priority=$5, is_enabled=true,
            registered_at=now(), last_seen_at=now()
      RETURNING id, name, url, hw_accel, is_builtin, priority, active_sessions
    `, [name, url, hw, builtin, resolved])

    app.log.info(`Transcoder registered: ${name} (${hw}, priority=${resolved}) @ ${url}`)
    return reply.code(201).send(rows[0])
  })

  // All routes below require admin auth
  app.addHook('preHandler', app.authenticate)
  app.addHook('preHandler', requireAdmin)

  app.get('/', async () => {
    const { rows } = await app.db.query(`
      SELECT id, name, url, hw_accel, is_builtin, priority, is_enabled,
             active_sessions, last_seen_at, registered_at
      FROM transcoder_nodes
      ORDER BY priority DESC, name
    `)
    return rows
  })

  // Manual registration (admin UI fallback — for transcoders on isolated networks)
  app.post('/', async (request, reply) => {
    const { name, url, hw_accel, priority } = request.body
    if (!name || !url) return reply.code(400).send({ error: 'name and url required' })

    const hw       = hw_accel ?? 'cpu'
    const resolved = await resolvePriority(app.db, hw, priority)

    const { rows } = await app.db.query(
      `INSERT INTO transcoder_nodes(name, url, hw_accel, priority)
       VALUES($1, $2, $3, $4) RETURNING *`,
      [name, url, hw, resolved]
    )
    return reply.code(201).send(rows[0])
  })

  app.patch('/:id', async (request, reply) => {
    const { is_enabled, priority } = request.body
    const updates = []
    const values  = []

    if (is_enabled !== undefined) {
      updates.push(`is_enabled=$${updates.length + 1}`)
      values.push(is_enabled)
    }
    if (priority !== undefined) {
      updates.push(`priority=$${updates.length + 1}`)
      values.push(parseInt(priority))
    }

    if (!updates.length) return reply.code(400).send({ error: 'Nothing to update' })
    values.push(request.params.id)

    const { rows } = await app.db.query(
      `UPDATE transcoder_nodes SET ${updates.join(', ')} WHERE id=$${values.length} RETURNING *`,
      values
    )
    if (!rows.length) return reply.code(404).send({ error: 'Not found' })
    return rows[0]
  })

  app.delete('/:id', async (request, reply) => {
    const { rows } = await app.db.query(
      'SELECT is_builtin FROM transcoder_nodes WHERE id=$1',
      [request.params.id]
    )
    if (!rows.length) return reply.code(404).send({ error: 'Not found' })
    if (rows[0].is_builtin) return reply.code(403).send({ error: 'Built-in transcoder cannot be removed' })

    await app.db.query('DELETE FROM transcoder_nodes WHERE id=$1', [request.params.id])
    return reply.code(204).send()
  })

  app.get('/:id/health', async (request, reply) => {
    const { rows } = await app.db.query('SELECT url FROM transcoder_nodes WHERE id=$1', [request.params.id])
    if (!rows.length) return reply.code(404).send({ error: 'Not found' })
    try {
      const { data } = await axios.get(`${rows[0].url}/health`, {
        headers: { 'x-transcoder-secret': process.env.TRANSCODER_SECRET },
        timeout: 3000
      })
      await app.db.query('UPDATE transcoder_nodes SET last_seen_at=now() WHERE id=$1', [request.params.id])
      return data
    } catch {
      return reply.code(502).send({ error: 'Node unreachable' })
    }
  })
}
