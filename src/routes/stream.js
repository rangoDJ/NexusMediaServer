import axios from 'axios'
import { createReadStream } from 'fs'
import { stat } from 'fs/promises'
import { pickTranscoder, claimSession, releaseSession } from '../services/transcoderPool.js'
import { callHook } from '../services/pluginLoader.js'
import { requireAdmin } from '../middleware/auth.js'

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
    let { media_item_id, episode_id, codec = 'h264', resolution = '1080p', bitrate, variants = false } = request.body
    const userId = request.user.sub

    const filePath = await resolveFilePath(app.db, media_item_id, episode_id, reply)
    if (!filePath) return

    const streamOverrides = await callHook('stream.start', { filePath, codec, resolution, bitrate }, app.log)
    for (const override of streamOverrides) {
      if (override.codec)      codec      = override.codec
      if (override.resolution) resolution = override.resolution
      if (override.bitrate)    bitrate    = override.bitrate
    }

    const node = await pickTranscoder(app.db)
    if (!node) return reply.code(503).send({ error: 'No transcoder nodes available' })

    let remoteSessionId, abr
    try {
      const { data } = await axios.post(
        `${node.url}/session`,
        { file_path: filePath, codec, resolution, bitrate, variants },
        { headers: { 'x-transcoder-secret': process.env.TRANSCODER_SECRET }, timeout: 10_000 }
      )
      remoteSessionId = data.session_id
      abr = data.abr === true
    } catch (err) {
      app.log.error(err, `Failed to start session on transcoder ${node.url}`)
      return reply.code(502).send({ error: 'Transcoder unavailable' })
    }

    const { rows } = await app.db.query(`
      INSERT INTO transcode_sessions
        (user_id, media_item_id, episode_id, transcoder_node_id, remote_session_id,
         codec, resolution, bitrate, status, expires_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,'active', now() + interval '4 hours')
      RETURNING id
    `, [userId, media_item_id ?? null, episode_id ?? null, node.id, remoteSessionId,
        codec, resolution, bitrate ?? null])

    await claimSession(app.db, node.id)

    const sessionId = rows[0].id
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

    // Poll until ffmpeg has generated at least one segment (transcoder returns 202 while not ready)
    let playlist
    for (let attempt = 0; attempt < 20; attempt++) {
      let resp
      try {
        resp = await axios.get(
          `${session.node_url}/session/${session.remote_session_id}/playlist.m3u8`,
          {
            headers: { 'x-transcoder-secret': process.env.TRANSCODER_SECRET },
            responseType: 'text',
            timeout: 10_000,
            validateStatus: s => s === 200 || s === 202,
          }
        )
      } catch (err) {
        const status = err.response?.status
        if (status === 500) return reply.code(502).send({ error: 'Transcode failed — check transcoder logs' })
        return reply.code(502).send({ error: 'Transcoder unreachable' })
      }
      if (resp.status === 200) { playlist = resp.data; break }
      await new Promise(r => setTimeout(r, 500))
    }
    if (!playlist) return reply.code(504).send({ error: 'Playlist not ready after 10s' })

    // Rewrite bare segment filenames to our proxy path
    const rewritten = playlist.replace(
      /^(segment_\d+\.ts)$/gm,
      `/api/v1/stream/${request.params.sessionId}/$1`
    )
    reply.header('Content-Type', 'application/vnd.apple.mpegurl')
    return rewritten
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

    // Same readiness poll as single-variant
    let master
    for (let attempt = 0; attempt < 20; attempt++) {
      let resp
      try {
        resp = await axios.get(
          `${session.node_url}/session/${session.remote_session_id}/master.m3u8`,
          { headers: { 'x-transcoder-secret': process.env.TRANSCODER_SECRET },
            responseType: 'text', timeout: 10_000,
            validateStatus: s => s === 200 || s === 202 }
        )
      } catch (err) {
        const status = err.response?.status
        if (status === 500) return reply.code(502).send({ error: 'Transcode failed' })
        return reply.code(502).send({ error: 'Transcoder unreachable' })
      }
      if (resp.status === 200) { master = resp.data; break }
      await new Promise(r => setTimeout(r, 500))
    }
    if (!master) return reply.code(504).send({ error: 'Master playlist not ready after 10s' })

    reply.header('Content-Type', 'application/vnd.apple.mpegurl')
    return master
  })

  // ABR variant playlist: /:sessionId/v0/playlist.m3u8
  app.get('/:sessionId/:variant/playlist.m3u8', async (request, reply) => {
    const session = await getActiveSession(app.db, request.params.sessionId, request.user.sub, reply)
    if (!session) return

    let playlist
    try {
      const resp = await axios.get(
        `${session.node_url}/session/${session.remote_session_id}/${request.params.variant}/playlist.m3u8`,
        { headers: { 'x-transcoder-secret': process.env.TRANSCODER_SECRET },
          responseType: 'text', timeout: 10_000 }
      )
      playlist = resp.data
    } catch {
      return reply.code(502).send({ error: 'Variant playlist unreachable' })
    }
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
      const { rows } = await app.db.query(
        'SELECT file_path, container FROM episodes WHERE id=$1', [episode_id]
      )
      if (!rows.length) return reply.code(404).send({ error: 'Episode not found' })
      row = rows[0]
    } else if (media_item_id) {
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

  // Admin stats — active and recent transcode sessions with user/media context.
  // Gated behind admin role so ordinary viewers can't see other users' activity.
  app.get('/stats', { preHandler: [requireAdmin] }, async (request) => {
    // Active sessions with user, media title, and node info
    const { rows: activeSessions } = await app.db.query(`
      SELECT
        s.id,
        s.codec,
        s.resolution,
        s.bitrate,
        s.created_at,
        EXTRACT(EPOCH FROM (now() - s.created_at))::int AS duration_secs,
        u.username,
        COALESCE(
          m.title,
          series.title || ' · S' || LPAD(ep.season_number::text, 2, '0')
                       || 'E' || LPAD(ep.episode_number::text, 2, '0')
        ) AS title,
        n.name  AS node_name,
        n.hw_accel
      FROM transcode_sessions s
      JOIN users u                ON u.id = s.user_id
      LEFT JOIN media_items m     ON m.id = s.media_item_id
      LEFT JOIN episodes ep       ON ep.id = s.episode_id
      LEFT JOIN media_items series ON series.id = ep.series_id
      JOIN transcoder_nodes n     ON n.id = s.transcoder_node_id
      WHERE s.status = 'active'
      ORDER BY s.created_at DESC
    `)

    // Last 30 completed/errored sessions
    const { rows: recentSessions } = await app.db.query(`
      SELECT
        s.id,
        s.codec,
        s.resolution,
        s.bitrate,
        s.status,
        s.created_at,
        s.ended_at,
        EXTRACT(EPOCH FROM (COALESCE(s.ended_at, now()) - s.created_at))::int AS duration_secs,
        u.username,
        COALESCE(
          m.title,
          series.title || ' · S' || LPAD(ep.season_number::text, 2, '0')
                       || 'E' || LPAD(ep.episode_number::text, 2, '0')
        ) AS title,
        n.name  AS node_name,
        n.hw_accel
      FROM transcode_sessions s
      JOIN users u                ON u.id = s.user_id
      LEFT JOIN media_items m     ON m.id = s.media_item_id
      LEFT JOIN episodes ep       ON ep.id = s.episode_id
      LEFT JOIN media_items series ON series.id = ep.series_id
      LEFT JOIN transcoder_nodes n ON n.id = s.transcoder_node_id
      WHERE s.status IN ('done', 'error')
      ORDER BY s.created_at DESC
      LIMIT 30
    `)

    // Summary counts
    const { rows: counts } = await app.db.query(`
      SELECT
        COUNT(*) FILTER (WHERE status = 'active')                                    AS active,
        COUNT(*) FILTER (WHERE created_at >= now() - interval '24 hours')            AS today,
        COUNT(*)                                                                      AS all_time
      FROM transcode_sessions
    `)

    return {
      active_sessions: activeSessions,
      recent_sessions: recentSessions,
      totals: counts[0],
    }
  })

  // Stop a session — clean up on both sides
  app.delete('/:sessionId', async (request, reply) => {
    const session = await getActiveSession(app.db, request.params.sessionId, request.user.sub, reply)
    if (!session) return

    await axios.delete(
      `${session.node_url}/session/${session.remote_session_id}`,
      { headers: { 'x-transcoder-secret': process.env.TRANSCODER_SECRET } }
    ).catch(() => {}) // best-effort; transcoder may already be gone

    await app.db.query(
      "UPDATE transcode_sessions SET status='done', ended_at=now() WHERE id=$1",
      [request.params.sessionId]
    )
    await releaseSession(app.db, session.transcoder_node_id)

    return reply.code(204).send()
  })
}

async function resolveFilePath(db, mediaItemId, episodeId, reply) {
  if (episodeId) {
    const { rows } = await db.query('SELECT file_path FROM episodes WHERE id=$1', [episodeId])
    if (!rows.length) { reply.code(404).send({ error: 'Episode not found' }); return null }
    return rows[0].file_path
  }
  if (mediaItemId) {
    const { rows } = await db.query('SELECT file_path FROM media_items WHERE id=$1', [mediaItemId])
    if (!rows.length) { reply.code(404).send({ error: 'Media not found' }); return null }
    return rows[0].file_path
  }
  reply.code(400).send({ error: 'media_item_id or episode_id required' })
  return null
}

async function proxySegment(app, request, reply, pathParts) {
  const session = await getActiveSession(app.db, request.params.sessionId, request.user.sub, reply)
  if (!session) return
  try {
    const res = await axios.get(
      `${session.node_url}/session/${session.remote_session_id}/${pathParts.join('/')}`,
      { headers: { 'x-transcoder-secret': process.env.TRANSCODER_SECRET },
        responseType: 'arraybuffer', timeout: 15_000 }
    )
    reply.header('Content-Type', 'video/MP2T')
    return Buffer.from(res.data)
  } catch {
    return reply.code(502).send({ error: 'Segment unavailable' })
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
