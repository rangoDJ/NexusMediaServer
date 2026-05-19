import axios from 'axios'

/**
 * Built-in task: clean up stale and expired transcode sessions.
 *
 * Three passes:
 *   1. Mark sessions as 'done' when they have passed their expires_at time.
 *   2. Find sessions still marked 'active' whose remote transcoder reports them
 *      as gone — mark those 'error'.
 *   3. Close any open play_session rows whose transcode session is no longer active.
 *
 * Triggers (defaults)
 *   • Every 24 hours
 *   • On startup
 *
 * This duplicates — in a thorough, scheduled form — the partial cleanup that the
 * health poller does for active_sessions counts. The health poller is fast and
 * runs every 30 s; this task is the slow comprehensive reconciliation.
 */
export const cleanupSessionsTask = {
  id:          'cleanup-sessions',
  name:        'Clean Up Transcode Sessions',
  description: 'Expires stale transcode sessions and closes orphaned play sessions.',
  category:    'Maintenance',

  defaultTriggers: [
    { type: 'startup' },
    { type: 'interval', intervalMs: 24 * 60 * 60 * 1000 }, // 24 h
  ],

  /** @param {import('../services/taskScheduler.js').ExecuteContext} ctx */
  async execute({ db, log, signal, progress }) {
    // ── Pass 1: expire by timestamp ────────────────────────────────────────────
    const { rowCount: expired } = await db.query(`
      UPDATE transcode_sessions
         SET status = 'done', ended_at = now()
       WHERE status = 'active'
         AND expires_at < now()
    `)
    log.info(`[tasks/cleanup-sessions] Expired ${expired} session(s) by timestamp`)
    progress(33)
    if (signal.aborted) return

    // ── Pass 2: reconcile against live transcoder nodes ────────────────────────
    const { rows: active } = await db.query(`
      SELECT s.id, s.remote_session_id, n.url AS node_url
        FROM transcode_sessions s
        JOIN transcoder_nodes   n ON n.id = s.transcoder_node_id
       WHERE s.status = 'active'
    `)

    let orphaned = 0
    await Promise.allSettled(
      active.map(async session => {
        if (signal.aborted) return
        try {
          await axios.get(
            `${session.node_url}/session/${session.remote_session_id}`,
            {
              headers: { 'x-transcoder-secret': process.env.TRANSCODER_SECRET },
              timeout: 5_000,
            }
          )
          // Session exists on transcoder — leave it active
        } catch (err) {
          const status = err.response?.status
          if (status === 404) {
            // Session is gone on the transcoder side — mark as error
            await db.query(
              "UPDATE transcode_sessions SET status='error', ended_at=now() WHERE id=$1",
              [session.id]
            ).catch(dbErr =>
              log.warn({ err: dbErr }, `[tasks/cleanup-sessions] Failed to mark session ${session.id} as error`)
            )
            orphaned++
          } else {
            // Transcoder unreachable — leave session alone; may recover
            log.debug({ err }, `[tasks/cleanup-sessions] Could not reach transcoder for session ${session.id}`)
          }
        }
      })
    )
    log.info(`[tasks/cleanup-sessions] Reconciled ${active.length} active session(s) — ${orphaned} orphan(s) marked error`)
    progress(66)
    if (signal.aborted) return

    // ── Pass 3: close dangling play_sessions ──────────────────────────────────
    const { rowCount: closedPlay } = await db.query(`
      UPDATE play_sessions ps
         SET ended_at = now()
        FROM transcode_sessions ts
       WHERE ps.transcode_session_id = ts.id
         AND ps.ended_at IS NULL
         AND ts.status IN ('done', 'error')
    `)

    // Also close direct-play sessions open for more than 24 hours (crash leftovers)
    const { rowCount: closedDirect } = await db.query(`
      UPDATE play_sessions
         SET ended_at = now()
       WHERE ended_at IS NULL
         AND play_type = 'direct'
         AND started_at < now() - interval '24 hours'
    `)

    log.info(
      `[tasks/cleanup-sessions] Closed ${closedPlay} transcode play_session(s) ` +
      `and ${closedDirect} stale direct play_session(s)`
    )
    progress(100)
  },
}
