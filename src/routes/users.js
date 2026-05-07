import bcrypt from 'bcrypt'
import { requireAdmin } from '../middleware/auth.js'

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
    await app.db.query('DELETE FROM users WHERE id=$1', [request.params.id])
    return reply.code(204).send()
  })

  // Self: change password
  app.put('/me/password', async (request, reply) => {
    const { current_password, new_password } = request.body
    const { rows } = await app.db.query('SELECT password_hash FROM users WHERE id=$1', [request.user.sub])
    if (!(await bcrypt.compare(current_password, rows[0].password_hash))) {
      return reply.code(401).send({ error: 'Current password incorrect' })
    }
    const hash = await bcrypt.hash(new_password, 12)
    await app.db.query('UPDATE users SET password_hash=$1 WHERE id=$2', [hash, request.user.sub])
    return reply.code(204).send()
  })
}
