import { requireAdmin } from '../middleware/auth.js'

/**
 * Server activity feed — admin-only.
 *
 * GET / — paginated, newest first.
 *   ?limit=20        max 100
 *   ?before=<ISO ts> only entries older than this (for "load more")
 */
export default async function activityRoutes(app) {
  app.addHook('preHandler', app.authenticate)
  app.addHook('preHandler', requireAdmin)

  app.get('/', async (request) => {
    const limit = Math.min(parseInt(request.query.limit ?? '20', 10) || 20, 100)
    const params = []
    let where = ''
    if (request.query.before) {
      params.push(request.query.before)
      where = `WHERE a.created_at < $${params.length}`
    }
    params.push(limit)

    const { rows } = await app.db.query(`
      SELECT a.id, a.type, a.severity, a.message, a.details, a.created_at, u.username
      FROM activity_log a
      LEFT JOIN users u ON u.id = a.user_id
      ${where}
      ORDER BY a.created_at DESC
      LIMIT $${params.length}
    `, params)
    return rows
  })
}
