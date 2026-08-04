/**
 * Server-Sent Events endpoint — GET /api/v1/events
 *
 * Clients subscribe here to receive real-time scan progress and library-changed
 * notifications without polling. EventSource can't set an Authorization header,
 * so this accepts the JWT via the httpOnly access-token cookie (sent
 * automatically for same-origin requests) or, for non-browser clients, a
 * ?token= query param.
 *
 * Event stream format (each line is a raw SSE "data:" message):
 *   data: {"type":"connected"}\n\n
 *   data: {"type":"refresh.progress", ...}\n\n
 *   data: {"type":"library.changed",  ...}\n\n
 *   data: {"type":"scan.error",       ...}\n\n
 *   : keepalive\n\n   (sent every 25 s to prevent proxy timeouts)
 */
import { getAllowedLibraryIds } from '../services/libraryAccess.js'

// Hard caps on concurrent SSE subscriber connections to prevent an
// authenticated client (or set of clients) from exhausting memory/FDs.
const MAX_TOTAL_CONNECTIONS = 200
const MAX_PER_USER_CONNECTIONS = 5

export default async function eventsRoute(app) {
  app.get('/events', { schema: { hide: true } }, async (request, reply) => {
    // ── Authentication (manual — EventSource can't set Authorization) ─────────
    const token = request.query.token ?? request.cookies?.nexus_access
    if (!token) return reply.code(401).send({ error: 'Not authenticated' })

    let payload
    try {
      payload = app.jwt.verify(token)
    } catch {
      return reply.code(401).send({ error: 'Invalid or expired token' })
    }

    // ── Admission control BEFORE hijacking the response ────────────────────────
    // An over-cap request must be rejected cleanly; once we hijack we can't
    // return a status code.
    const userId = payload?.sub ?? null
    if (!app.broadcaster.canAddClient({
      maxTotal: MAX_TOTAL_CONNECTIONS,
      maxPerUser: MAX_PER_USER_CONNECTIONS,
      userId,
    })) {
      return reply.code(503).send({ error: 'Too many open event streams' })
    }

    // A restricted user only receives events for libraries they can access.
    const allowed = await getAllowedLibraryIds(app.db, payload)

    // ── Hijack the response so Fastify doesn't close it automatically ─────────
    reply.hijack()
    const res = request.raw.res ?? reply.raw

    res.writeHead(200, {
      'Content-Type':      'text/event-stream',
      'Cache-Control':     'no-cache',
      'Connection':        'keep-alive',
      'X-Accel-Buffering': 'no',   // tell nginx not to buffer the stream
    })

    // ── Send helper ───────────────────────────────────────────────────────────
    function send(data) {
      if (res.writableEnded) return
      try { res.write(`data: ${JSON.stringify(data)}\n\n`) } catch { /* ignore */ }
    }

    // ── Register with broadcaster ─────────────────────────────────────────────
    send({ type: 'connected' })
    app.broadcaster.addClient(send, { userId, libraryFilter: allowed })

    // ── Keepalive — prevents proxy / load-balancer idle timeouts ─────────────
    const keepalive = setInterval(() => {
      if (res.writableEnded) { clearInterval(keepalive); return }
      try { res.write(': keepalive\n\n') } catch { clearInterval(keepalive) }
    }, 25_000)

    // ── Cleanup on disconnect ─────────────────────────────────────────────────
    request.raw.on('close', () => {
      clearInterval(keepalive)
      app.broadcaster.removeClient(send)
    })

    // Hold the connection open — never resolves
    await new Promise(() => {})
  })
}
