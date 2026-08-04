import ffmpeg from 'fluent-ffmpeg'
import { existsSync, createReadStream } from 'fs'
import { mkdir, stat } from 'fs/promises'
import { join } from 'path'
import { createHash } from 'crypto'

// Extract a single subtitle stream from a media file as WebVTT.
// Cached on disk under /tmp/vtts/<sha1(file_path|stream_index)>.vtt so the
// same track is only extracted once per container lifetime.
const VTT_CACHE_DIR = process.env.VTT_CACHE_DIR ?? '/tmp/vtts'
// A hung ffmpeg on a malformed stream must not pin the node forever — extract
// under a hard timeout, then kill the process.
const EXTRACT_TIMEOUT_MS = 60_000

function cacheKey(filePath, streamIndex) {
  return createHash('sha1').update(`${filePath}|${streamIndex}`).digest('hex')
}

function extract(filePath, streamIndex, outPath) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      console.warn(`[subtitles] extraction timed out after ${EXTRACT_TIMEOUT_MS}ms — killing ffmpeg: ${filePath}#${streamIndex}`)
      try { command.kill('SIGKILL') } catch {}
      reject(new Error('subtitle extraction timed out'))
    }, EXTRACT_TIMEOUT_MS)

    const command = ffmpeg(filePath)
      .outputOptions([
        `-map 0:${streamIndex}`,
        '-c:s webvtt',
      ])
      .format('webvtt')
      .output(outPath)
      .on('end',   () => { clearTimeout(timer); resolve() })
      .on('error', err => { clearTimeout(timer); reject(err) })
      .run()
  })
}

export default async function subtitleRoutes(app) {
  await mkdir(VTT_CACHE_DIR, { recursive: true })

  // POST /subtitle  { file_path, stream_index }  →  WebVTT body
  app.post('/', async (request, reply) => {
    const { file_path, stream_index } = request.body
    if (!file_path || stream_index == null) {
      return reply.code(400).send({ error: 'file_path and stream_index required' })
    }
    // reject non-integer stream indices so a garbage value can't reach `-map`
    if (!/^\d+$/.test(String(stream_index))) {
      return reply.code(400).send({ error: 'stream_index must be a non-negative integer' })
    }
    if (!existsSync(file_path)) return reply.code(404).send({ error: 'File not found' })

    const cachePath = join(VTT_CACHE_DIR, `${cacheKey(file_path, stream_index)}.vtt`)
    if (!existsSync(cachePath)) {
      try { await extract(file_path, parseInt(stream_index, 10), cachePath) }
      catch (err) {
        return reply.code(500).send({ error: `Subtitle extraction failed: ${err.message}` })
      }
    }

    const st = await stat(cachePath)
    reply.headers({
      'Content-Type':   'text/vtt; charset=utf-8',
      'Content-Length': st.size,
      'Cache-Control':  'private, max-age=86400',
    })
    return reply.send(createReadStream(cachePath))
  })
}
