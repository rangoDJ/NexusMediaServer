import { requireAdmin } from '../middleware/auth.js'
import { scanLibrary } from '../services/scanner.js'

export default async function libraryRoutes(app) {
  app.addHook('preHandler', app.authenticate)

  app.get('/', async () => {
    const { rows } = await app.db.query(`
      SELECT l.id, l.name, l.type, l.paths, l.scan_status, l.last_scanned_at,
             COUNT(m.id)::int AS item_count,
             COUNT(e.id)::int AS episode_count
      FROM libraries l
      LEFT JOIN media_items m ON m.library_id = l.id
      LEFT JOIN episodes    e ON e.series_id  = m.id AND m.type = 'series'
      GROUP BY l.id
      ORDER BY l.name
    `)
    return rows
  })

  app.post('/', { preHandler: requireAdmin }, async (request, reply) => {
    const { name, type, paths } = request.body
    const { rows } = await app.db.query(
      'INSERT INTO libraries(name, type, paths) VALUES($1,$2,$3) RETURNING *',
      [name, type, paths]
    )
    // Start watching the new library's paths immediately
    app.directoryWatcher?.refreshLibrary(rows[0].id).catch(err =>
      app.log.warn({ err }, '[libraries] watcher refresh failed')
    )
    return reply.code(201).send(rows[0])
  })

  app.delete('/:id', { preHandler: requireAdmin }, async (request, reply) => {
    await app.db.query('DELETE FROM libraries WHERE id=$1', [request.params.id])
    app.directoryWatcher?.removeLibrary(request.params.id)
    return reply.code(204).send()
  })

  // Trigger a library scan
  app.post('/:id/scan', { preHandler: requireAdmin }, async (request, reply) => {
    const { rows } = await app.db.query('SELECT * FROM libraries WHERE id=$1', [request.params.id])
    if (!rows.length) return reply.code(404).send({ error: 'Library not found' })

    // Fire and forget — scan runs in background, broadcaster pushes live progress to SSE clients
    scanLibrary(app.db, rows[0], app.log, app.broadcaster)
      .catch(err => app.log.error(err, 'Library scan failed'))
    return { status: 'scanning' }
  })
}
