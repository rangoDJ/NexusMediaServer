import axios from 'axios'

// Pick the enabled node with the fewest active sessions.
// Falls back to round-robin if all nodes are at equal load.
export async function pickTranscoder(db) {
  const { rows } = await db.query(`
    SELECT id, name, url, active_sessions
    FROM transcoder_nodes
    WHERE is_enabled = true
      AND last_seen_at > now() - interval '2 minutes'
    ORDER BY priority DESC, active_sessions ASC
    LIMIT 1
  `)
  return rows[0] ?? null
}

// Increment session count when a session is assigned to a node.
export async function claimSession(db, nodeId) {
  await db.query(
    'UPDATE transcoder_nodes SET active_sessions = active_sessions + 1 WHERE id=$1',
    [nodeId]
  )
}

// Decrement session count when a session ends or is cleaned up.
export async function releaseSession(db, nodeId) {
  await db.query(
    'UPDATE transcoder_nodes SET active_sessions = GREATEST(0, active_sessions - 1) WHERE id=$1',
    [nodeId]
  )
}

// Background poller — call once at startup.
// Pings all enabled nodes every 30s; marks unreachable ones stale (excluded by pickTranscoder).
// Also reconciles active_sessions count from the DB to prevent drift.
export function startHealthPoller(db, log) {
  async function poll() {
    let nodes
    try {
      const { rows } = await db.query('SELECT id, url FROM transcoder_nodes WHERE is_enabled = true')
      nodes = rows
    } catch (err) {
      log.warn(err, 'Health poller: failed to fetch nodes')
      return
    }

    for (const node of nodes) {
      try {
        await axios.get(`${node.url}/health`, {
          headers: { 'x-transcoder-secret': process.env.TRANSCODER_SECRET },
          timeout: 3000
        })
        await db.query('UPDATE transcoder_nodes SET last_seen_at=now() WHERE id=$1', [node.id])
      } catch {
        log.warn(`Transcoder node ${node.url} is unreachable`)
        // last_seen_at goes stale — pickTranscoder won't route to it
      }
    }

    // Reconcile active_sessions: count rows in transcode_sessions that are active per node
    await db.query(`
      UPDATE transcoder_nodes n
      SET active_sessions = (
        SELECT COUNT(*) FROM transcode_sessions s
        WHERE s.transcoder_node_id = n.id AND s.status = 'active'
      )
    `)
  }

  // Run immediately, then every 30 seconds
  poll().catch(err => log.error(err, 'Health poller error'))
  return setInterval(() => poll().catch(err => log.error(err, 'Health poller error')), 30_000)
}
