export async function authMiddleware(request, reply) {
  try {
    await request.jwtVerify()
  } catch {
    reply.code(401).send({ error: 'Unauthorized' })
  }
}

export function requireAdmin(request, reply, done) {
  if (request.user?.role !== 'admin') {
    reply.code(403).send({ error: 'Forbidden' })
    return
  }
  done()
}
