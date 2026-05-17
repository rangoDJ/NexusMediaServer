import ffmpeg from 'fluent-ffmpeg'
import { existsSync, createReadStream } from 'fs'
import { mkdir, stat } from 'fs/promises'
import { join } from 'path'
import { createHash } from 'crypto'

// Extract a single subtitle stream from a media file as WebVTT.
// Cached on disk under /tmp/vtts/<sha1(file_path|stream_index)>.vtt so the
// same track is only extracted once per container lifetime.
const VTT_CACHE_DIR = process.env.VTT_CACHE_DIR ?? '/tmp/vtts'

function cacheKey(filePath, streamIndex) {
  return createHash('sha1').update(`${filePath}|${streamIndex}`).digest('hex')
}

function extract(filePath, streamIndex, outPath) {
  return new Promise((resolve, reject) => {
    ffmpeg(filePath)
      .outputOptions([
        `-map 0:${streamIndex}`,
        '-c:s webvtt',
      ])
      .format('webvtt')
      .output(outPath)
      .on('end',   () => resolve())
      .on('error', err => reject(err))
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
    if (!existsSync(file_path)) return reply.code(404).send({ error: 'File not found' })

    const cachePath = join(VTT_CACHE_DIR, `${cacheKey(file_path, stream_index)}.vtt`)
    if (!existsSync(cachePath)) {
      try { await extract(file_path, parseInt(stream_index), cachePath) }
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
