import axios from 'axios'
import { createReadStream } from 'fs'
import { stat } from 'fs/promises'
import { pickTranscoder, claimSession, releaseSession } from '../services/transcoderPool.js'
import { callHook } from '../services/pluginLoader.js'
import { requireAdmin } from '../middleware/auth.js'
import { canAccessMediaItem, canAccessEpisode } from '../services/libraryAccess.js'

// Containers whose raw bytes a typical browser can play without transcoding.
// Used for the Content-Type on direct-play responses; the eligibility check
// (codec+container support) lives in /media/:id/playback-info.
const MIME_BY_CONTAINER = {
  mp4:  'video/mp4',
  m4v:  'video/mp4',
  webm: 'video/webm',
  mov:  'video/quicktime',
  mkv:  'video/x-matroska', // some browsers will reject; playback-info gates this
}

export default async function streamRoutes(app) {
  // Stream routes accept the JWT either as a Bearer header (hls.js xhrSetup)
  // or as a ?token= query param (Safari native HLS, which can't inject headers).
  app.addHook('preHandler', async (request, reply) => {
    if (request.query.token && !request.headers.authorization) {
      request.headers.authorization = `Bearer ${request.query.token}`
    }
    return app.authenticate(request, reply)
  })

  // Start a stream — picks the least-loaded transcoder, creates a session there,
  // and returns an opaque playlist URL. The client never needs to know where the
  // transcoder lives.
  app.post('/start', async (request, reply) => {
    let { media_item_id, episode_id, codec = 'h264', resolution = '1080p', bitrate, variants = false, start_time_secs = 0 } = request.body
    const userId = request.user.sub

    const filePath = await resolveFilePath(app.db, media_item_id, episode_id, reply, request.user)
    if (!filePath) return

    const streamOverrides = await callHook('stream.start', { filePath, codec, resolution, bitrate }, app.log)
    for (const override of streamOverrides) {
      if (override.codec)      codec      = override.codec
      if (override.resolution) resolution = override.resolution
      if (override.bitrate)    bitrate    = override.bitrate
    }

    // Dedup — reuse an already-running transcode for the exact same media +
    // params (page reload, duplicate tab, retry after a network blip) instead
    // of spawning a second ffmpeg process for it. Only reuse sessions on nodes
    // that are still actually reachable, matching pickTranscoder's own
    // staleness window.
    const { rows: reusable } = await app.db.query(`
      SELECT s.transcoder_node_id, s.remote_session_id, s.is_abr
      FROM transcode_sessions s
      JOIN transcoder_nodes n ON n.id = s.transcoder_node_id
      WHERE s.status='active'
        AND s.media_item_id IS NOT DISTINCT FROM $1
        AND s.episode_id    IS NOT DISTINCT FROM $2
        AND s.codec = $3
        AND s.resolution = $4
        AND s.bitrate IS NOT DISTINCT FROM $5
        AND s.start_time_secs = $6
        AND s.is_abr = $7
        AND n.is_enabled AND n.last_seen_at > now() - interval '2 minutes'
      LIMIT 1
    `, [media_item_id ?? null, episode_id ?? null, codec, resolution, bitrate ?? null, start_time_secs, variants === true])

    let nodeId, remoteSessionId, abr

    if (reusable.length) {
      nodeId = reusable[0].transcoder_node_id
      remoteSessionId = reusable[0].remote_session_id
      abr = reusable[0].is_abr
      app.log.info(`[stream] Reusing existing transcode session ${remoteSessionId} on node ${nodeId}`)
    } else {
      const node = await pickTranscoder(app.db)
      if (!node) return reply.code(503).send({ error: 'No transcoder nodes available (none reachable or all at capacity)' })

      try {
        const { data } = await axios.post(
          `${node.url}/session`,
          { file_path: filePath, codec, resolution, bitrate, variants, start_time_secs },
          { headers: { 'x-transcoder-secret': process.env.TRANSCODER_SECRET }, timeout: 10_000 }
        )
        remoteSessionId = data.session_id
        abr = data.abr === true
      } catch (err) {
        app.log.error(err, `Failed to start session on transcoder ${node.url}`)
        return reply.code(502).send({ error: 'Transcoder unavailable' })
      }

      nodeId = node.id
      // Atomic capacity check. If the node reached max_sessions between the
      // pick query and now, tear down the just-started remote session instead
      // of registering a row that over-represents the node's load.
      const claimed = await claimSession(app.db, node.id)
      if (!claimed) {
        axios.delete(`${node.url}/session/${remoteSessionId}`, {
          headers: { 'x-transcoder-secret': process.env.TRANSCODER_SECRET },
          timeout: 3000,
        }).catch(() => {})
        return reply.code(503).send({ error: 'Transcoder node is at capacity; try again shortly' })
      }
    }

    const { rows } = await app.db.query(`
      INSERT INTO transcode_sessions
        (user_id, media_item_id, episode_id, transcoder_node_id, remote_session_id,
         codec, resolution, bitrate, start_time_secs, is_abr, status, expires_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'active', now() + interval '4 hours')
      RETURNING id
    `, [userId, media_item_id ?? null, episode_id ?? null, nodeId, remoteSessionId,
        codec, resolution, bitrate ?? null, start_time_secs, abr])

    const sessionId = rows[0].id

    // Log a play_session record so the direct/transcode ratio is trackable
    app.db.query(
      `INSERT INTO play_sessions(user_id, media_item_id, episode_id, play_type, transcode_session_id)
       VALUES($1,$2,$3,'transcode',$4)`,
      [userId, media_item_id ?? null, episode_id ?? null, sessionId]
    ).catch(err => app.log.warn(err, 'Failed to log play_session for transcode'))

    return {
      session_id:   sessionId,
      abr,
      // For ABR sessions the client points hls.js at master.m3u8 and hls.js
      // handles variant selection. For single-variant it's playlist.m3u8.
      playlist_url: abr
        ? `/api/v1/stream/${sessionId}/master.m3u8`
        : `/api/v1/stream/${sessionId}/playlist.m3u8`,
    }
  })

  // Proxy the HLS playlist — rewrite segment URLs to go through this API
  app.get('/:sessionId/playlist.m3u8', async (request, reply) => {
    const session = await getActiveSession(app.db, request.params.sessionId, request.user.sub, reply)
    if (!session) return

    // Poll until ffmpeg has generated at least one segment (transcoder returns 202 while not ready).
    // 60 × 500ms = 30s window: HW watchdog fires at 8s, CPU fallback needs ~2-5s → safely within 30s.
    const pollUrl = `${session.node_url}/session/${session.remote_session_id}/playlist.m3u8`
    app.log.info(`[stream] polling playlist.m3u8: ${pollUrl}`)
    let playlist
    for (let attempt = 0; attempt < 60; attempt++) {
      let resp
      try {
        resp = await axios.get(pollUrl, {
          headers: { 'x-transcoder-secret': process.env.TRANSCODER_SECRET },
          responseType: 'text',
          timeout: 10_000,
          validateStatus: s => s === 200 || s === 202,
        })
      } catch (err) {
        const status = err.response?.status
        app.log.error(`[stream] playlist.m3u8 poll error: status=${status} msg=${err.message}`)
        // Only a confirmed 500 from the node (transcode genuinely failed) fails fast.
        // Everything else — connection refused, timeout, DNS blip — is a transient
        // network hiccup, not proof the stream is broken. Retry it like a 202.
        if (status === 500) return reply.code(502).send({ error: 'Transcode failed — check transcoder logs' })
        await new Promise(r => setTimeout(r, 500))
        continue
      }
      if (attempt === 0 || attempt % 10 === 0 || resp.status === 200) {
        app.log.info(`[stream] playlist.m3u8 attempt=${attempt} status=${resp.status}`)
      }
      if (resp.status === 200) { playlist = resp.data; break }
      await new Promise(r => setTimeout(r, 500))
    }
    if (!playlist) return reply.code(504).send({ error: 'Playlist not ready after 30s' })

    // Rewrite bare segment filenames to our proxy path
    const rewritten = playlist.replace(
      /^(segment_\d+\.ts)$/gm,
      `/api/v1/stream/${request.params.sessionId}/$1`
    )
    app.log.info(`[stream] serving rewritten playlist.m3u8 for session ${request.params.sessionId}:\n${rewritten}`)
    reply.header('Content-Type', 'application/vnd.apple.mpegurl')
    return rewritten
  })

  // Lightweight per-session metrics — encoding fps/speed/timemark from the
  // transcoder. Any authenticated user can poll metrics for their own session.
  // Must be registered before /:sessionId/:segment so "metrics" (static) wins
  // over the wildcard parametric match.
  app.get('/:sessionId/metrics', async (request, reply) => {
    const session = await getActiveSession(app.db, request.params.sessionId, request.user.sub, reply)
    if (!session) return

    try {
      const { data } = await axios.get(
        `${session.node_url}/session/${session.remote_session_id}/metrics`,
        { headers: { 'x-transcoder-secret': process.env.TRANSCODER_SECRET }, timeout: 3_000 }
      )
      return data
    } catch {
      return {}
    }
  })

  // Proxy an individual HLS segment (single-variant sessions)
  app.get('/:sessionId/:segment', async (request, reply) => {
    return proxySegment(app, request, reply, [request.params.segment])
  })

  // ABR master playlist — pass through, the relative variant paths
  // (v0/playlist.m3u8, v1/playlist.m3u8) resolve back to this prefix
  // and hit the variant routes below.
  app.get('/:sessionId/master.m3u8', async (request, reply) => {
    const session = await getActiveSession(app.db, request.params.sessionId, request.user.sub, reply)
    if (!session) return

    // Same readiness poll as single-variant — 60 × 500ms = 30s
    const masterPollUrl = `${session.node_url}/session/${session.remote_session_id}/master.m3u8`
    app.log.info(`[stream] polling master.m3u8: ${masterPollUrl}`)
    let master
    for (let attempt = 0; attempt < 60; attempt++) {
      let resp
      try {
        resp = await axios.get(masterPollUrl, {
          headers: { 'x-transcoder-secret': process.env.TRANSCODER_SECRET },
          responseType: 'text', timeout: 10_000,
          validateStatus: s => s === 200 || s === 202,
        })
      } catch (err) {
        const status = err.response?.status
        app.log.error(`[stream] master.m3u8 poll error: status=${status} msg=${err.message}`)
        if (status === 500) return reply.code(502).send({ error: 'Transcode failed' })
        await new Promise(r => setTimeout(r, 500))
        continue
      }
      if (attempt === 0 || attempt % 10 === 0 || resp.status === 200) {
        app.log.info(`[stream] master.m3u8 attempt=${attempt} status=${resp.status}`)
      }
      if (resp.status === 200) { master = resp.data; break }
      await new Promise(r => setTimeout(r, 500))
    }
    if (!master) return reply.code(504).send({ error: 'Master playlist not ready after 30s' })

    app.log.info(`[stream] serving master.m3u8 for session ${request.params.sessionId}:\n${master}`)
    reply.header('Content-Type', 'application/vnd.apple.mpegurl')
    return master
  })

  // ABR variant playlist: /:sessionId/v0/playlist.m3u8
  // Polls with the same retry logic as master.m3u8 — hls.js fetches this
  // immediately after parsing master.m3u8, but ffmpeg may not have written
  // the first segment yet (CPU encoding all variants takes 5–15s).
  app.get('/:sessionId/:variant/playlist.m3u8', async (request, reply) => {
    const session = await getActiveSession(app.db, request.params.sessionId, request.user.sub, reply)
    if (!session) return

    const variantPath = `${request.params.variant}/playlist.m3u8`
    const variantPollUrl = `${session.node_url}/session/${session.remote_session_id}/${variantPath}`
    app.log.info(`[stream] polling variant ${variantPath}: ${variantPollUrl}`)
    let playlist
    for (let attempt = 0; attempt < 60; attempt++) {
      let resp
      try {
        resp = await axios.get(variantPollUrl, {
          headers: { 'x-transcoder-secret': process.env.TRANSCODER_SECRET },
          responseType: 'text', timeout: 10_000,
          validateStatus: s => s === 200 || s === 202,
        })
      } catch (err) {
        const status = err.response?.status
        app.log.error(`[stream] variant ${variantPath} poll error: status=${status} msg=${err.message}`)
        if (status === 500) return reply.code(502).send({ error: 'Transcode failed' })
        await new Promise(r => setTimeout(r, 500))
        continue
      }
      if (attempt === 0 || attempt % 10 === 0 || resp.status === 200) {
        app.log.info(`[stream] variant ${variantPath} attempt=${attempt} status=${resp.status}`)
      }
      if (resp.status === 200) { playlist = resp.data; break }
      await new Promise(r => setTimeout(r, 500))
    }
    if (!playlist) return reply.code(504).send({ error: 'Variant playlist not ready after 30s' })

    app.log.info(`[stream] serving variant ${variantPath} for session ${request.params.sessionId}:\n${playlist}`)
    reply.header('Content-Type', 'application/vnd.apple.mpegurl')
    return playlist
  })

  // ABR variant segment: /:sessionId/v0/segment_00001.ts
  app.get('/:sessionId/:variant/:segment', async (request, reply) => {
    return proxySegment(app, request, reply, [request.params.variant, request.params.segment])
  })

  // Direct play — serve the raw file with HTTP byte-range support so browsers
  // can scrub without any transcoding. The Player only points here when
  // /media/:id/playback-info reports direct_play=true.
  //
  // Query params:
  //   media_item_id | episode_id  — exactly one
  //   token                       — JWT (handled by the preHandler above)
  app.get('/direct', async (request, reply) => {
    const { media_item_id, episode_id } = request.query

    let row
    if (episode_id) {
      if (!(await canAccessEpisode(app.db, request.user, episode_id))) {
        return reply.code(404).send({ error: 'Episode not found' })
      }
      const { rows } = await app.db.query(
        'SELECT file_path, container FROM episodes WHERE id=$1', [episode_id]
      )
      if (!rows.length) return reply.code(404).send({ error: 'Episode not found' })
      row = rows[0]
    } else if (media_item_id) {
      if (!(await canAccessMediaItem(app.db, request.user, media_item_id))) {
        return reply.code(404).send({ error: 'Media not found' })
      }
      const { rows } = await app.db.query(
        'SELECT file_path, container FROM media_items WHERE id=$1', [media_item_id]
      )
      if (!rows.length) return reply.code(404).send({ error: 'Media not found' })
      row = rows[0]
    } else {
      return reply.code(400).send({ error: 'media_item_id or episode_id required' })
    }
    if (!row.file_path) return reply.code(404).send({ error: 'Item has no file' })

    let st
    try { st = await stat(row.file_path) }
    catch { return reply.code(404).send({ error: 'File missing on disk' }) }

    const contentType = MIME_BY_CONTAINER[row.container?.toLowerCase()] ?? 'application/octet-stream'
    const range = request.headers.range

    // Log a play_session on the first request for this file (byte offset 0 or no Range
    // header). Seeking back to position 0 re-logs, which is an acceptable approximation.
    const rangeStart = range ? parseInt(/^bytes=(\d+)/.exec(range)?.[1] ?? '0', 10) : 0
    if (rangeStart === 0) {
      app.db.query(
        `INSERT INTO play_sessions(user_id, media_item_id, episode_id, play_type)
         VALUES($1,$2,$3,'direct')`,
        [request.user.sub, media_item_id ?? null, episode_id ?? null]
      ).catch(err => app.log.warn(err, 'Failed to log direct play_session'))
    }

    if (range) {
      const m = /^bytes=(\d+)-(\d*)$/.exec(range)
      if (!m) {
        reply.header('Content-Range', `bytes */${st.size}`)
        return reply.code(416).send({ error: 'Malformed range' })
      }
      const start = parseInt(m[1], 10)
      const end   = m[2] ? parseInt(m[2], 10) : st.size - 1
      if (start >= st.size || end >= st.size || start > end) {
        reply.header('Content-Range', `bytes */${st.size}`)
        return reply.code(416).send({ error: 'Range not satisfiable' })
      }
      reply.code(206)
      reply.headers({
        'Content-Type':  contentType,
        'Content-Length': end - start + 1,
        'Content-Range': `bytes ${start}-${end}/${st.size}`,
        'Accept-Ranges': 'bytes',
        'Cache-Control': 'private, max-age=0',
      })
      return reply.send(createReadStream(row.file_path, { start, end }))
    }

    reply.headers({
      'Content-Type':   contentType,
      'Content-Length': st.size,
      'Accept-Ranges':  'bytes',
      'Cache-Control':  'private, max-age=0',
    })
    return reply.send(createReadStream(row.file_path))
  })

  // Admin stats — active and recent sessions with user/media context, per-node
  // 7-day breakdowns, direct/transcode play ratio, top users, and live encoding
  // metrics fetched from each transcoder node. Gated behind admin role.
  app.get('/stats', { preHandler: [requireAdmin] }, async (request) => {
    const TITLE_EXPR = `COALESCE(
      m.title,
      series.title || ' · S' || LPAD(ep.season_number::text, 2, '0')
                   || 'E' || LPAD(ep.episode_number::text, 2, '0')
    )`
    const EPISODE_JOINS = `
      LEFT JOIN media_items m      ON m.id = s.media_item_id
      LEFT JOIN episodes ep        ON ep.id = s.episode_id
      LEFT JOIN media_items series ON series.id = ep.series_id
    `

    const [
      { rows: activeSessions },
      { rows: recentSessions },
      { rows: [totals] },
      { rows: nodeStats },
      { rows: [playRatio] },
      { rows: topUsers },
    ] = await Promise.all([
      // Active sessions — also select node URL + remote ID for metrics fetching
      app.db.query(`
        SELECT s.id, s.codec, s.resolution, s.bitrate, s.created_at,
               s.remote_session_id,
               EXTRACT(EPOCH FROM (now() - s.created_at))::int AS duration_secs,
               u.username, ${TITLE_EXPR} AS title,
               n.name AS node_name, n.hw_accel, n.url AS node_url
        FROM transcode_sessions s
        JOIN users u ON u.id = s.user_id
        ${EPISODE_JOINS}
        JOIN transcoder_nodes n ON n.id = s.transcoder_node_id
        WHERE s.status = 'active'
        ORDER BY s.created_at DESC
      `),

      // Last 30 completed/errored sessions
      app.db.query(`
        SELECT s.id, s.codec, s.resolution, s.bitrate, s.status,
               s.created_at, s.ended_at,
               EXTRACT(EPOCH FROM (COALESCE(s.ended_at, now()) - s.created_at))::int AS duration_secs,
               u.username, ${TITLE_EXPR} AS title,
               n.name AS node_name, n.hw_accel
        FROM transcode_sessions s
        JOIN users u ON u.id = s.user_id
        ${EPISODE_JOINS}
        LEFT JOIN transcoder_nodes n ON n.id = s.transcoder_node_id
        WHERE s.status IN ('done', 'error')
        ORDER BY s.created_at DESC
        LIMIT 30
      `),

      // Summary totals (transcode only — direct plays are in play_sessions)
      app.db.query(`
        SELECT
          COUNT(*) FILTER (WHERE status = 'active')                         AS active,
          COUNT(*) FILTER (WHERE created_at >= now() - interval '24 hours') AS today,
          COUNT(*)                                                           AS all_time
        FROM transcode_sessions
      `),

      // Per-node 7-day stats: session volume, error rate, avg duration
      app.db.query(`
        SELECT
          n.id, n.name, n.hw_accel,
          n.active_sessions                                                  AS live,
          COUNT(s.id) FILTER (WHERE s.created_at >= now() - interval '7 days') AS sessions_7d,
          COUNT(s.id) FILTER (WHERE s.status = 'done'
                                AND s.created_at >= now() - interval '7 days') AS successful_7d,
          COUNT(s.id) FILTER (WHERE s.status = 'error'
                                AND s.created_at >= now() - interval '7 days') AS errors_7d,
          ROUND(AVG(EXTRACT(EPOCH FROM (s.ended_at - s.created_at)))
                FILTER (WHERE s.ended_at IS NOT NULL
                           AND s.created_at >= now() - interval '7 days'))::int AS avg_duration_secs_7d,
          COUNT(s.id)                                                        AS total_sessions
        FROM transcoder_nodes n
        LEFT JOIN transcode_sessions s ON s.transcoder_node_id = n.id
        GROUP BY n.id, n.name, n.hw_accel, n.active_sessions
        ORDER BY n.active_sessions DESC, n.name
      `),

      // Direct vs transcode ratio from the unified play_sessions log
      app.db.query(`
        SELECT
          COUNT(*) FILTER (WHERE play_type = 'direct')                              AS direct_all,
          COUNT(*) FILTER (WHERE play_type = 'transcode')                           AS transcode_all,
          COUNT(*) FILTER (WHERE play_type = 'direct'
                             AND started_at >= now() - interval '24 hours')         AS direct_today,
          COUNT(*) FILTER (WHERE play_type = 'transcode'
                             AND started_at >= now() - interval '24 hours')         AS transcode_today
        FROM play_sessions
      `),

      // Top 10 users by session count, last 30 days
      app.db.query(`
        SELECT
          u.username,
          COUNT(ps.id)                                                              AS session_count,
          COUNT(ps.id) FILTER (WHERE ps.play_type = 'direct')                      AS direct_count,
          COUNT(ps.id) FILTER (WHERE ps.play_type = 'transcode')                   AS transcode_count,
          ROUND(AVG(EXTRACT(EPOCH FROM (ps.ended_at - ps.started_at)))
                FILTER (WHERE ps.ended_at IS NOT NULL))::int                       AS avg_duration_secs
        FROM play_sessions ps
        JOIN users u ON u.id = ps.user_id
        WHERE ps.started_at >= now() - interval '30 days'
        GROUP BY u.id, u.username
        ORDER BY session_count DESC
        LIMIT 10
      `),
    ])

    // Fetch real-time encoding metrics (fps, speed, timemark) from each transcoder
    // for the active sessions. Best-effort — failures are silently ignored so a
    // slow or offline transcoder doesn't block the stats response.
    const metricsMap = {}
    await Promise.allSettled(
      activeSessions.map(async s => {
        try {
          const { data } = await axios.get(
            `${s.node_url}/session/${s.remote_session_id}/metrics`,
            { headers: { 'x-transcoder-secret': process.env.TRANSCODER_SECRET }, timeout: 2000 }
          )
          metricsMap[s.id] = data
        } catch (err) {
          app.log.debug({ err, sessionId: s.id }, 'Failed to fetch live metrics from transcoder')
        }
      })
    )

    // Strip internal node_url / remote_session_id before sending to client
    const enrichedActive = activeSessions.map(({ node_url, remote_session_id, ...s }) => ({
      ...s,
      metrics: metricsMap[s.id] ?? null,
    }))

    return {
      active_sessions: enrichedActive,
      recent_sessions: recentSessions,
      totals,
      node_stats:  nodeStats,
      play_ratio:  playRatio,
      top_users:   topUsers,
    }
  })

  // Diagnostic — return the transcoder's view of a session (file listing,
  // m3u8 contents, ffmpeg metrics, status). Admin-only. Useful for debugging
  // "why isn't this stream playing" without docker-exec.
  // Path is /debug/:sessionId (not /:sessionId/debug) so it can't be matched
  // by the /:sessionId/:segment wildcard route under any router behavior.
  app.get('/debug/:sessionId', { preHandler: [requireAdmin] }, async (request, reply) => {
    const { rows } = await app.db.query(`
      SELECT s.*, n.url AS node_url, n.name AS node_name, n.hw_accel
      FROM transcode_sessions s
      JOIN transcoder_nodes n ON n.id = s.transcoder_node_id
      WHERE s.id=$1
    `, [request.params.sessionId])
    if (!rows.length) return reply.code(404).send({ error: 'Session not found in DB' })
    const session = rows[0]

    let transcoderState = null
    let transcoderError = null
    try {
      const { data } = await axios.get(
        `${session.node_url}/session/${session.remote_session_id}/debug`,
        { headers: { 'x-transcoder-secret': process.env.TRANSCODER_SECRET }, timeout: 5000 }
      )
      transcoderState = data
    } catch (err) {
      transcoderError = err.response?.data?.error ?? err.message
    }

    // The ffmpeg log survives independently of the in-memory session (see
    // GET /session/:id/log on the node) — fetch it even for sessions that
    // have already ended, which /debug above (sessionStore-backed) can't do.
    let logTail = null
    try {
      const { data } = await axios.get(
        `${session.node_url}/session/${session.remote_session_id}/log`,
        { headers: { 'x-transcoder-secret': process.env.TRANSCODER_SECRET }, timeout: 5000 }
      )
      logTail = data.log_tail
    } catch { /* no log yet, or node unreachable — omit rather than fail the whole request */ }

    return {
      db_session: {
        id: session.id, status: session.status, codec: session.codec,
        resolution: session.resolution, bitrate: session.bitrate,
        created_at: session.created_at, ended_at: session.ended_at,
        node_name: session.node_name, hw_accel: session.hw_accel,
        node_url: session.node_url, remote_session_id: session.remote_session_id,
      },
      transcoder_state: transcoderState,
      transcoder_error: transcoderError,
      ffmpeg_log_tail: logTail,
    }
  })

  // Stop a session — clean up on both sides. If another active row still
  // references the same remote transcoder session (dedup — another viewer
  // reusing the same encode), only close this row; the underlying ffmpeg
  // process keeps running for them.
  app.delete('/:sessionId', async (request, reply) => {
    const session = await getActiveSession(app.db, request.params.sessionId, request.user.sub, reply)
    if (!session) return

    const { rows: otherViewers } = await app.db.query(`
      SELECT 1 FROM transcode_sessions
      WHERE transcoder_node_id = $1 AND remote_session_id = $2
        AND status='active' AND id != $3
      LIMIT 1
    `, [session.transcoder_node_id, session.remote_session_id, request.params.sessionId])

    if (!otherViewers.length) {
      await axios.delete(
        `${session.node_url}/session/${session.remote_session_id}`,
        { headers: { 'x-transcoder-secret': process.env.TRANSCODER_SECRET } }
      ).catch(err => app.log.warn(err, `Failed to stop remote transcoder session — may already be gone (node=${session.node_url})`))
    }

    await app.db.query(
      "UPDATE transcode_sessions SET status='done', ended_at=now() WHERE id=$1",
      [request.params.sessionId]
    )
    // Close the corresponding play_session so watch duration is accurate
    app.db.query(
      "UPDATE play_sessions SET ended_at=now() WHERE transcode_session_id=$1 AND ended_at IS NULL",
      [request.params.sessionId]
    ).catch(err => app.log.warn(err, 'Failed to close play_session on stream stop'))

    await releaseSession(app.db, session.transcoder_node_id)

    return reply.code(204).send()
  })
}

async function resolveFilePath(db, mediaItemId, episodeId, reply, user) {
  if (episodeId) {
    if (user && !(await canAccessEpisode(db, user, episodeId))) {
      reply.code(404).send({ error: 'Episode not found' }); return null
    }
    const { rows } = await db.query('SELECT file_path FROM episodes WHERE id=$1', [episodeId])
    if (!rows.length) { reply.code(404).send({ error: 'Episode not found' }); return null }
    return rows[0].file_path
  }
  if (mediaItemId) {
    if (user && !(await canAccessMediaItem(db, user, mediaItemId))) {
      reply.code(404).send({ error: 'Media not found' }); return null
    }
    const { rows } = await db.query('SELECT file_path FROM media_items WHERE id=$1', [mediaItemId])
    if (!rows.length) { reply.code(404).send({ error: 'Media not found' }); return null }
    return rows[0].file_path
  }
  reply.code(400).send({ error: 'media_item_id or episode_id required' })
  return null
}

async function proxySegment(app, request, reply, pathParts) {
  // Validate all path parts before forwarding to prevent path traversal attacks.
  // Segments must be plain filenames like "segment_00001.ts"; variants must be
  // "v0", "v1", etc. Any "../" or unusual characters are rejected here.
  const segment = pathParts[pathParts.length - 1]
  if (!/^[a-zA-Z0-9_-]+\.ts$/.test(segment)) {
    return reply.code(400).send({ error: 'Invalid segment name' })
  }
  if (pathParts.length > 1 && !/^v\d+$/.test(pathParts[0])) {
    return reply.code(400).send({ error: 'Invalid variant identifier' })
  }

  const session = await getActiveSession(app.db, request.params.sessionId, request.user.sub, reply)
  if (!session) return

  const segmentUrl = `${session.node_url}/session/${session.remote_session_id}/${pathParts.join('/')}`
  // Segments are fetched constantly during playback — a single transient
  // network blip shouldn't stall it. One short retry before giving up.
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await axios.get(segmentUrl, {
        headers: { 'x-transcoder-secret': process.env.TRANSCODER_SECRET },
        responseType: 'arraybuffer', timeout: 15_000,
      })
      reply.header('Content-Type', 'video/MP2T')
      return Buffer.from(res.data)
    } catch (err) {
      if (attempt === 0) {
        app.log.debug(`[stream] segment fetch failed, retrying once: ${err.message}`)
        await new Promise(r => setTimeout(r, 300))
        continue
      }
      return reply.code(502).send({ error: 'Segment unavailable' })
    }
  }
}

async function getActiveSession(db, sessionId, userId, reply) {
  const { rows } = await db.query(`
    SELECT s.*, n.url AS node_url
    FROM transcode_sessions s
    JOIN transcoder_nodes n ON n.id = s.transcoder_node_id
    WHERE s.id=$1 AND s.user_id=$2 AND s.status='active'
  `, [sessionId, userId])

  if (!rows.length) {
    reply.code(404).send({ error: 'Session not found or expired' })
    return null
  }
  return rows[0]
}
