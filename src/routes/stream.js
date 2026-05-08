import axios from 'axios'
import { pickTranscoder, claimSession, releaseSession } from '../services/transcoderPool.js'
import { callHook } from '../services/pluginLoader.js'

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
    let { media_item_id, episode_id, codec = 'h264', resolution = '1080p', bitrate } = request.body
    const userId = request.user.sub

    const filePath = await resolveFilePath(app.db, media_item_id, episode_id, reply)
    if (!filePath) return

    // Allow plugins to inspect or modify transcode parameters before the session starts
    const streamOverrides = await callHook('stream.start', { filePath, codec, resolution, bitrate }, app.log)
    for (const override of streamOverrides) {
      if (override.codec)      codec      = override.codec
      if (override.resolution) resolution = override.resolution
      if (override.bitrate)    bitrate    = override.bitrate
    }

    const node = await pickTranscoder(app.db)
    if (!node) return reply.code(503).send({ error: 'No transcoder nodes available' })

    let remoteSessionId
    try {
      const { data } = await axios.post(
        `${node.url}/session`,
        { file_path: filePath, codec, resolution, bitrate },
        { headers: { 'x-transcoder-secret': process.env.TRANSCODER_SECRET }, timeout: 10_000 }
      )
      remoteSessionId = data.session_id
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
      session_id: sessionId,
      playlist_url: `/api/v1/stream/${sessionId}/playlist.m3u8`
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

  // Proxy an individual HLS segment
  app.get('/:sessionId/:segment', async (request, reply) => {
    const session = await getActiveSession(app.db, request.params.sessionId, request.user.sub, reply)
    if (!session) return

    let data
    try {
      const res = await axios.get(
        `${session.node_url}/session/${session.remote_session_id}/${request.params.segment}`,
        { headers: { 'x-transcoder-secret': process.env.TRANSCODER_SECRET }, responseType: 'arraybuffer', timeout: 15_000 }
      )
      data = res.data
    } catch {
      return reply.code(502).send({ error: 'Segment unavailable' })
    }

    reply.header('Content-Type', 'video/MP2T')
    return Buffer.from(data)
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
      "UPDATE transcode_sessions SET status='done' WHERE id=$1",
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
