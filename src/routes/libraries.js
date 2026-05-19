import { unlink } from 'fs/promises'
import axios from 'axios'
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

  // Update library name / paths. Rebuilds the directory watcher when paths change.
  app.put('/:id', { preHandler: requireAdmin }, async (request, reply) => {
    const { name, paths } = request.body
    const { rows } = await app.db.query(
      `UPDATE libraries SET name=COALESCE($1,name), paths=COALESCE($2,paths)
       WHERE id=$3 RETURNING *`,
      [name ?? null, paths ?? null, request.params.id]
    )
    if (!rows.length) return reply.code(404).send({ error: 'Library not found' })
    // Rebuild watcher so any new/removed paths take effect immediately
    app.directoryWatcher?.refreshLibrary(rows[0].id).catch(err =>
      app.log.warn({ err }, '[libraries] watcher refresh failed after update')
    )
    return rows[0]
  })

  app.delete('/:id', { preHandler: requireAdmin }, async (request, reply) => {
    const libraryId = request.params.id

    // Verify the library exists before doing any work
    const { rows: libs } = await app.db.query(
      'SELECT id, name FROM libraries WHERE id=$1', [libraryId]
    )
    if (!libs.length) return reply.code(404).send({ error: 'Library not found' })
    const libName = libs[0].name

    // 1. Collect local artwork paths stored in metadata JSONB before the
    //    cascade delete wipes the media_items rows. We query both movies and
    //    series (which act as the parent for their episodes' artwork).
    const { rows: artworkRows } = await app.db.query(`
      SELECT metadata->>'local_poster_path'   AS poster,
             metadata->>'local_backdrop_path' AS backdrop
      FROM media_items
      WHERE library_id = $1
        AND (metadata->>'local_poster_path'   IS NOT NULL
          OR metadata->>'local_backdrop_path' IS NOT NULL)
    `, [libraryId])

    // 2. Collect active transcoder sessions for this library's content so we
    //    can stop the ffmpeg processes before the DB rows disappear.
    const { rows: activeSessions } = await app.db.query(`
      SELECT ts.remote_session_id, n.url AS node_url
      FROM transcode_sessions ts
      JOIN transcoder_nodes n ON n.id = ts.transcoder_node_id
      WHERE ts.status = 'active'
        AND (
          ts.media_item_id IN (SELECT id FROM media_items WHERE library_id=$1)
          OR
          ts.episode_id    IN (SELECT e.id FROM episodes e
                               JOIN media_items m ON m.id = e.series_id
                               WHERE m.library_id=$1)
        )
    `, [libraryId])

    // 3. Stop the directory watcher before touching the DB so no scan fires
    //    mid-delete.
    app.directoryWatcher?.removeLibrary(libraryId)

    // 4. Delete the library row — cascades to media_items → episodes →
    //    watch_progress, transcode_sessions, play_sessions, media_cast.
    await app.db.query('DELETE FROM libraries WHERE id=$1', [libraryId])
    app.log.info(`[libraries] deleted library "${libName}" (id=${libraryId})`)

    // 5. Kill orphaned ffmpeg processes on transcoder nodes. Best-effort:
    //    the DB rows are already gone so a failure here just means the
    //    transcoder session runs until its own idle timeout.
    if (activeSessions.length > 0) {
      await Promise.allSettled(
        activeSessions.map(s =>
          axios.delete(`${s.node_url}/session/${s.remote_session_id}`, {
            headers: { 'x-transcoder-secret': process.env.TRANSCODER_SECRET },
            timeout: 5_000,
          }).catch(err =>
            app.log.warn(`[libraries] failed to stop transcoder session ${s.remote_session_id}: ${err.message}`)
          )
        )
      )
      app.log.info(`[libraries] stopped ${activeSessions.length} active transcoder session(s)`)
    }

    // 6. Delete local artwork files from disk. Done after the DB delete so a
    //    disk error never leaves the library in a half-deleted state.
    //    ENOENT is silently ignored (file already gone / never existed).
    const artworkPaths = artworkRows
      .flatMap(r => [r.poster, r.backdrop])
      .filter(Boolean)

    if (artworkPaths.length > 0) {
      await Promise.allSettled(
        artworkPaths.map(p =>
          unlink(p).catch(err => {
            if (err.code !== 'ENOENT') {
              app.log.warn(`[libraries] could not delete artwork file "${p}": ${err.message}`)
            }
          })
        )
      )
      app.log.info(`[libraries] removed ${artworkPaths.length} local artwork file(s) for library "${libName}"`)
    }

    return reply.code(204).send()
  })

  // Delete series rows that have zero episodes — typically duplicates created
  // by a previous broken scan that couldn't match an existing series and
  // inserted a new empty row. Movies are unaffected (they don't have episodes).
  app.post('/cleanup-empty-series', { preHandler: requireAdmin }, async (request) => {
    const { rows } = await app.db.query(`
      DELETE FROM media_items
      WHERE type='series'
        AND id NOT IN (SELECT DISTINCT series_id FROM episodes WHERE series_id IS NOT NULL)
      RETURNING id, title
    `)
    return { deleted: rows.length, items: rows }
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
