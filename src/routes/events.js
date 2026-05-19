/**
 * Server-Sent Events endpoint — GET /api/v1/events
 *
 * Clients subscribe here to receive real-time scan progress and library-changed
 * notifications without polling.  Authentication uses the same ?token= query
 * param pattern as the HLS stream routes — EventSource cannot set custom headers.
 *
 * Event stream format (each line is a raw SSE "data:" message):
 *   data: {"type":"connected"}\n\n
 *   data: {"type":"refresh.progress", ...}\n\n
 *   data: {"type":"library.changed",  ...}\n\n
 *   data: {"type":"scan.error",       ...}\n\n
 *   : keepalive\n\n   (sent every 25 s to prevent proxy timeouts)
 */
export default async function eventsRoute(app) {
  app.get('/events', { schema: { hide: true } }, async (request, reply) => {
    // ── Authentication ────────────────────────────────────────────────────────
    // EventSource can't set Authorization headers, so we accept the JWT as a
    // query param (same pattern as /stream routes for Safari HLS).
    const token = request.query.token
    if (!token) return reply.code(401).send({ error: 'token query param required' })

    try {
      app.jwt.verify(token)
    } catch {
      return reply.code(401).send({ error: 'Invalid or expired token' })
    }

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
    app.broadcaster.addClient(send)

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
