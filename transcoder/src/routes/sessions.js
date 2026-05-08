import { v4 as uuidv4 } from 'uuid'
import { createReadStream, existsSync } from 'fs'
import { join } from 'path'
import { sessionStore } from '../services/sessionStore.js'
import { startTranscodeSession, stopSession } from '../services/transcoder.js'

export default async function sessionRoutes(app) {
  // Create a new transcode session
  app.post('/', async (request, reply) => {
    const { file_path, codec, resolution, bitrate } = request.body

    if (!existsSync(file_path)) {
      return reply.code(404).send({ error: 'File not found on transcoder' })
    }

    const session_id = uuidv4()
    await startTranscodeSession({ session_id, file_path, codec, resolution, bitrate })

    return reply.code(201).send({ session_id })
  })

  // Get session status
  app.get('/:id/status', async (request, reply) => {
    const s = sessionStore.get(request.params.id)
    if (!s) return reply.code(404).send({ error: 'Session not found' })
    return { session_id: request.params.id, status: s.status }
  })

  // Serve HLS playlist
  app.get('/:id/playlist.m3u8', async (request, reply) => {
    const s = sessionStore.get(request.params.id)
    if (!s) return reply.code(404).send({ error: 'Session not found' })

    if (s.status === 'error') {
      return reply.code(500).send({ error: 'Transcode process failed' })
    }

    const playlistPath = join(s.outputDir, 'playlist.m3u8')
    if (!existsSync(playlistPath)) {
      return reply.code(202).send({ error: 'Playlist not ready yet' })
    }

    reply.header('Content-Type', 'application/vnd.apple.mpegurl')
    return reply.send(createReadStream(playlistPath))
  })

  // Serve a segment
  app.get('/:id/:segment', async (request, reply) => {
    const s = sessionStore.get(request.params.id)
    if (!s) return reply.code(404).send({ error: 'Session not found' })

    const segmentPath = join(s.outputDir, request.params.segment)
    if (!existsSync(segmentPath)) {
      return reply.code(404).send({ error: 'Segment not found' })
    }

    reply.header('Content-Type', 'video/MP2T')
    return reply.send(createReadStream(segmentPath))
  })

  // Terminate session + clean up
  app.delete('/:id', async (request, reply) => {
    stopSession(request.params.id)
    return reply.code(204).send()
  })
}
