import { v4 as uuidv4 } from 'uuid'
import { createReadStream, existsSync, readFileSync } from 'fs'
import { join } from 'path'
import { sessionStore } from '../services/sessionStore.js'
import { startTranscodeSession, stopSession, touchSession } from '../services/transcoder.js'

export default async function sessionRoutes(app) {
  // Create a new transcode session
  app.post('/', async (request, reply) => {
    const { file_path, codec, resolution, bitrate, variants } = request.body

    if (!existsSync(file_path)) {
      return reply.code(404).send({ error: 'File not found on transcoder' })
    }

    const session_id = uuidv4()
    await startTranscodeSession({ session_id, file_path, codec, resolution, bitrate, variants })

    return reply.code(201).send({ session_id, abr: !!variants })
  })

  // Session status
  app.get('/:id/status', async (request, reply) => {
    const s = sessionStore.get(request.params.id)
    if (!s) return reply.code(404).send({ error: 'Session not found' })
    return { session_id: request.params.id, status: s.status, abr: !!s.abr }
  })

  // Real-time encoding metrics: fps, speed multiplier, frames processed, timemark.
  // Populated by the progress/stderr event handlers in transcoder.js.
  // Returns nulls for all fields when ffmpeg hasn't emitted a progress line yet.
  app.get('/:id/metrics', async (request, reply) => {
    const s = sessionStore.get(request.params.id)
    if (!s) return reply.code(404).send({ error: 'Session not found' })
    touchSession(request.params.id)
    return s.metrics ?? {
      fps: null, speed: null, frames: null, bitrate: null, timemark: null, updated_at: null,
    }
  })

  // Single-variant playlist (non-ABR sessions)
  app.get('/:id/playlist.m3u8', async (request, reply) => {
    return servePlaylist(request, reply, ['playlist.m3u8'])
  })

  // ABR master playlist
  app.get('/:id/master.m3u8', async (request, reply) => {
    return servePlaylist(request, reply, ['master.m3u8'])
  })

  // ABR variant playlist: /:id/v0/playlist.m3u8
  app.get('/:id/:variant/playlist.m3u8', async (request, reply) => {
    return servePlaylist(request, reply, [request.params.variant, 'playlist.m3u8'])
  })

  // ABR variant segment: /:id/v0/segment_00001.ts
  app.get('/:id/:variant/:segment', async (request, reply) => {
    return serveSegment(request, reply, [request.params.variant, request.params.segment])
  })

  // Single-variant segment
  app.get('/:id/:segment', async (request, reply) => {
    return serveSegment(request, reply, [request.params.segment])
  })

  // Terminate session + clean up
  app.delete('/:id', async (request, reply) => {
    stopSession(request.params.id, 'client requested DELETE')
    return reply.code(204).send()
  })
}

function servePlaylist(request, reply, pathParts) {
  const s = sessionStore.get(request.params.id)
  if (!s) {
    console.log(`[sessions] playlist request for unknown session ${request.params.id}`)
    return reply.code(404).send({ error: 'Session not found' })
  }
  if (s.status === 'error') {
    console.log(`[sessions:${request.params.id}] session in error state — returning 500`)
    return reply.code(500).send({ error: 'Transcode process failed' })
  }

  touchSession(request.params.id)

  const fullPath = join(s.outputDir, ...pathParts)
  const exists = existsSync(fullPath)
  console.log(`[sessions:${request.params.id}] playlist ${pathParts.join('/')} → ${fullPath} exists=${exists} status=${s.status}`)

  if (!exists) {
    return reply.code(202).send({ error: 'Playlist not ready yet' })
  }

  let content
  try { content = readFileSync(fullPath, 'utf8') } catch { content = '(unreadable)' }
  console.log(`[sessions:${request.params.id}] serving playlist ${pathParts.join('/')}:\n${content}`)

  reply.header('Content-Type', 'application/vnd.apple.mpegurl')
  return reply.send(content)
}

function serveSegment(request, reply, pathParts) {
  const s = sessionStore.get(request.params.id)
  if (!s) return reply.code(404).send({ error: 'Session not found' })

  touchSession(request.params.id)

  const fullPath = join(s.outputDir, ...pathParts)
  if (!existsSync(fullPath)) return reply.code(404).send({ error: 'Segment not found' })

  reply.header('Content-Type', 'video/MP2T')
  return reply.send(createReadStream(fullPath))
}
