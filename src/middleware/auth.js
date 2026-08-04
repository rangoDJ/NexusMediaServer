export async function authMiddleware(request, reply) {
  try {
    await request.jwtVerify()
  } catch {
    return reply.code(401).send({ error: 'Unauthorized' })
  }

  // jwtVerify() only checks signature + expiry. A user who was deleted or
  // disabled keeps a valid token for up to 24h unless we check the DB. Do a
  // tiny indexed PK lookup so revocation takes effect immediately rather than
  // on the next login.
  const db = request.server?.db
  if (!db) return
  try {
    const { rows } = await db.query('SELECT is_enabled FROM users WHERE id=$1', [request.user.sub])
    if (!rows.length || !rows[0].is_enabled) {
      return reply.code(401).send({ error: 'Unauthorized' })
    }
  } catch (err) {
    // A DB blip shouldn't turn every authenticated request into a 500 — fail
    // open on the liveness check (the DB is used for the request anyway, so
    // the next query would surface the outage).
    request.log?.warn({ err }, '[auth] user liveness check failed — continuing')
  }
}

export function requireAdmin(request, reply, done) {
  if (request.user?.role !== 'admin') {
    reply.code(403).send({ error: 'Forbidden' })
    return
  }
  done()
}