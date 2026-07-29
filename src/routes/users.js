import bcrypt from 'bcrypt'
import { requireAdmin } from '../middleware/auth.js'
import { logActivity } from '../services/activityLog.js'

export default async function usersRoutes(app) {
  app.addHook('preHandler', app.authenticate)

  // Admin: list all users
  app.get('/', { preHandler: requireAdmin }, async () => {
    const { rows } = await app.db.query(
      'SELECT id, username, email, role, created_at FROM users ORDER BY username'
    )
    return rows
  })

  // Admin: change a user's role
  app.patch('/:id/role', { preHandler: requireAdmin }, async (request, reply) => {
    const { role } = request.body
    if (!['admin', 'viewer'].includes(role)) {
      return reply.code(400).send({ error: 'Invalid role' })
    }
    const { rows } = await app.db.query(
      'UPDATE users SET role=$1 WHERE id=$2 RETURNING id, username, role',
      [role, request.params.id]
    )
    if (!rows.length) return reply.code(404).send({ error: 'User not found' })
    return rows[0]
  })

  // Admin: delete a user
  app.delete('/:id', { preHandler: requireAdmin }, async (request, reply) => {
    if (request.params.id === request.user.sub) {
      return reply.code(400).send({ error: 'Cannot delete yourself' })
    }
    const { rows } = await app.db.query(
      'DELETE FROM users WHERE id=$1 RETURNING username', [request.params.id]
    )
    if (!rows.length) return reply.code(404).send({ error: 'User not found' })

    logActivity(app.db, app.log, {
      type: 'user.deleted', userId: request.user.sub,
      message: `${request.user.username} deleted account "${rows[0].username}"`,
    })

    return reply.code(204).send()
  })

  // Admin: get a user's library access list. Empty array = unrestricted
  // (sees every library) — see services/libraryAccess.js for the semantics.
  app.get('/:id/libraries', { preHandler: requireAdmin }, async (request, reply) => {
    const { rows: users } = await app.db.query('SELECT id FROM users WHERE id=$1', [request.params.id])
    if (!users.length) return reply.code(404).send({ error: 'User not found' })
    const { rows } = await app.db.query(
      'SELECT library_id FROM user_library_access WHERE user_id=$1', [request.params.id]
    )
    return { library_ids: rows.map(r => r.library_id) }
  })

  // Admin: replace a user's library access list.
  // Body: { library_ids: string[] } — [] clears all restrictions (unrestricted).
  app.put('/:id/libraries', { preHandler: requireAdmin }, async (request, reply) => {
    const { library_ids } = request.body ?? {}
    if (!Array.isArray(library_ids) || !library_ids.every(id => typeof id === 'string')) {
      return reply.code(400).send({ error: 'library_ids must be an array of strings' })
    }
    const { rows: users } = await app.db.query('SELECT id FROM users WHERE id=$1', [request.params.id])
    if (!users.length) return reply.code(404).send({ error: 'User not found' })

    const client = await app.db.connect()
    try {
      await client.query('BEGIN')
      await client.query('DELETE FROM user_library_access WHERE user_id=$1', [request.params.id])
      for (const libraryId of library_ids) {
        await client.query(
          'INSERT INTO user_library_access(user_id, library_id) VALUES($1,$2) ON CONFLICT DO NOTHING',
          [request.params.id, libraryId]
        )
      }
      await client.query('COMMIT')
    } catch (err) {
      await client.query('ROLLBACK')
      throw err
    } finally {
      client.release()
    }
    return { library_ids }
  })

  // Self: change password
  app.put('/me/password', async (request, reply) => {
    const { current_password, new_password } = request.body

    if (typeof new_password !== 'string' || new_password.trim().length < 8) {
      return reply.code(400).send({ error: 'new_password must be at least 8 characters' })
    }

    const { rows } = await app.db.query('SELECT password_hash FROM users WHERE id=$1', [request.user.sub])
    if (!rows.length) return reply.code(404).send({ error: 'User not found' })

    if (!(await bcrypt.compare(current_password, rows[0].password_hash))) {
      return reply.code(401).send({ error: 'Current password incorrect' })
    }
    const hash = await bcrypt.hash(new_password, 12)
    await app.db.query('UPDATE users SET password_hash=$1 WHERE id=$2', [hash, request.user.sub])
    return reply.code(204).send()
  })
}
