import axios from 'axios'

// Pick the enabled node with the fewest active sessions, excluding nodes at
// or above their configured max_sessions cap (NULL = unlimited).
// Falls back to round-robin if all nodes are at equal load.
export async function pickTranscoder(db) {
  const { rows } = await db.query(`
    SELECT id, name, url, active_sessions
    FROM transcoder_nodes
    WHERE is_enabled = true
      AND last_seen_at > now() - interval '2 minutes'
      AND (max_sessions IS NULL OR active_sessions < max_sessions)
    ORDER BY priority DESC, active_sessions ASC
    LIMIT 1
  `)
  return rows[0] ?? null
}

// Increment session count when a session is assigned to a node.
// Atomic: the UPDATE re-checks the max_sessions cap in the SAME statement as
// the increment, so two concurrent claims can't both pass a pickTranscoder-time
// guard and oversubscribe a capped node. Returns true if the claim succeeded.
export async function claimSession(db, nodeId) {
  const { rowCount } = await db.query(
    `UPDATE transcoder_nodes
     SET active_sessions = active_sessions + 1
     WHERE id=$1 AND (max_sessions IS NULL OR active_sessions < max_sessions)`,
    [nodeId]
  )
  return rowCount > 0
}

// Decrement session count when a session ends or is cleaned up.
export async function releaseSession(db, nodeId) {
  await db.query(
    'UPDATE transcoder_nodes SET active_sessions = GREATEST(0, active_sessions - 1) WHERE id=$1',
    [nodeId]
  )
}

// Background poller — call once at startup.
//
// Pings all enabled nodes every 30s and does two things with the result:
//   1. Fast reconciliation — a node's own idle janitor can kill a session's
//      ffmpeg process without the main API ever finding out (tab closed
//      without a clean unmount, etc). The transcoder's /health response
//      already lists every session it still has live, so we diff that
//      against `transcode_sessions` rows we think are 'active' for that node
//      and close out the ones that are gone. Without this, a dead session
//      stays 'active' — and therefore counted in the load-balancing query —
//      for up to 24h (the cleanup-sessions task's slow backstop cycle).
//   2. Dead-node detection — a node that's been unreachable for over 2
//      minutes (the same staleness window pickTranscoder uses to exclude it
//      from routing) has crashed; its still-active sessions are marked
//      'error' rather than left to rot.
export function startHealthPoller(db, log) {
  async function poll() {
    let nodes
    try {
      const { rows } = await db.query('SELECT id, url, last_seen_at FROM transcoder_nodes WHERE is_enabled = true')
      nodes = rows
    } catch (err) {
      log.warn(err, 'Health poller: failed to fetch nodes')
      return
    }

    // Ping all nodes concurrently — with N nodes at a 3s timeout each,
    // sequential pinging wastes N×3s per health cycle. Promise.allSettled
    // ensures one slow/dead node never blocks updates to healthy ones.
    await Promise.allSettled(nodes.map(async node => {
      try {
        const { data } = await axios.get(`${node.url}/health`, {
          headers: { 'x-transcoder-secret': process.env.TRANSCODER_SECRET },
          timeout: 3000,
        })
        await db.query('UPDATE transcoder_nodes SET last_seen_at=now() WHERE id=$1', [node.id])
        await reconcileNodeSessions(db, log, node, data?.sessions ?? [])
      } catch {
        log.warn(`Transcoder node ${node.url} is unreachable`)
        // last_seen_at goes stale — pickTranscoder won't route to it.
        // If it stays stale past 2 minutes, the sweep below marks its
        // sessions 'error' instead of leaving them active forever.
      }
    }))

    // Dead-node sweep: nodes stale for 2+ minutes have crashed — their
    // still-'active' sessions are lies. Mark them 'error' so load balancing
    // and the admin stats stop trusting them.
    await db.query(`
      UPDATE transcode_sessions s
      SET status='error', ended_at=now()
      FROM transcoder_nodes n
      WHERE s.transcoder_node_id = n.id
        AND s.status = 'active'
        AND n.last_seen_at < now() - interval '2 minutes'
    `)

    // Reconcile active_sessions from actual ffmpeg process count, not DB row
    // count — dedup (see stream.js) lets multiple rows share one
    // remote_session_id, so COUNT(DISTINCT ...) reflects real node load.
    await db.query(`
      UPDATE transcoder_nodes n
      SET active_sessions = (
        SELECT COUNT(DISTINCT s.remote_session_id) FROM transcode_sessions s
        WHERE s.transcoder_node_id = n.id AND s.status = 'active'
      )
    `)
  }

  // Run immediately, then every 30 seconds
  poll().catch(err => log.error(err, 'Health poller error'))
  return setInterval(() => poll().catch(err => log.error(err, 'Health poller error')), 30_000)
}

/** Close out DB rows for a node whose remote session has already ended (idle timeout, normal completion). */
async function reconcileNodeSessions(db, log, node, liveSessions) {
  const { rows: active } = await db.query(
    "SELECT id, remote_session_id FROM transcode_sessions WHERE transcoder_node_id=$1 AND status='active'",
    [node.id]
  )
  if (!active.length) return

  const liveIds = new Set(liveSessions.map(s => s.id))
  const goneIds = active.filter(row => !liveIds.has(row.remote_session_id)).map(row => row.id)
  if (!goneIds.length) return

  await db.query(
    "UPDATE transcode_sessions SET status='done', ended_at=now() WHERE id = ANY($1::uuid[])",
    [goneIds]
  )
  log.debug(`[transcoder-pool] Reconciled ${goneIds.length} finished session(s) on node ${node.url}`)
}
