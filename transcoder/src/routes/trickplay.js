import { mkdir, writeFile } from 'fs/promises'
import { join } from 'path'
import { existsSync } from 'fs'
import ffmpeg from 'fluent-ffmpeg'

const TILE_COLS  = 10
const TILE_ROWS  = 10
const THUMB_W    = 160
const THUMB_H    = 90
const INTERVAL   = 10 // seconds between frames
// A hung ffmpeg on a malformed/long input must not pin the node forever.
const GENERATE_TIMEOUT_MS = 5 * 60 * 1000

export default async function trickplayRoutes(app) {
  /**
   * POST /trickplay
   * Body: { file_path, output_dir }
   * Generates a JPEG sprite sheet + WebVTT file in output_dir.
   * Returns { vtt_path, sprite_path, interval, tile_cols, tile_rows, thumb_w, thumb_h, duration_secs }
   */
  app.post('/', async (request, reply) => {
    const { file_path, output_dir } = request.body
    if (typeof file_path !== 'string' || !file_path ||
        typeof output_dir !== 'string' || !output_dir) {
      return reply.code(400).send({ error: 'file_path and output_dir (strings) are required' })
    }
    if (!existsSync(file_path)) {
      return reply.code(404).send({ error: 'File not found on transcoder' })
    }

    await mkdir(output_dir, { recursive: true })

    const spritePath = join(output_dir, 'trickplay.jpg')
    const vttPath    = join(output_dir, 'trickplay.vtt')

    // Build sprite sheet: sample one frame every INTERVAL seconds, tile into a
    // single TILE_COLS × TILE_ROWS grid image.  One tile covers at most
    // TILE_COLS * TILE_ROWS * INTERVAL seconds of content.
    const vfsFilter = [
      `fps=1/${INTERVAL}`,
      `scale=${THUMB_W}:${THUMB_H}:force_original_aspect_ratio=decrease`,
      `pad=${THUMB_W}:${THUMB_H}:(ow-iw)/2:(oh-ih)/2`,
      `tile=${TILE_COLS}x${TILE_ROWS}`,
    ].join(',')

    let durationSecs = 0

    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        console.warn(`[trickplay] generation timed out after ${GENERATE_TIMEOUT_MS}ms — killing ffmpeg`)
        try { command.kill('SIGKILL') } catch {}
        reject(new Error('trickplay generation timed out'))
      }, GENERATE_TIMEOUT_MS)

      const command = ffmpeg(file_path)
        .outputOptions([
          '-vf', vfsFilter,
          '-frames:v', '1',
          '-q:v', '5',
        ])
        .output(spritePath)
        .on('codecData', data => {
          const m = data.duration?.match(/(\d+):(\d+):(\d+)/)
          if (m) durationSecs = parseInt(m[1]) * 3600 + parseInt(m[2]) * 60 + parseInt(m[3])
        })
        .on('end', () => { clearTimeout(timer); resolve() })
        .on('error', err => { clearTimeout(timer); reject(err) })
        .run()
    })

    // Get precise duration via ffprobe
    durationSecs = await new Promise((resolve) => {
      ffmpeg.ffprobe(file_path, (err, meta) => {
        resolve(err ? durationSecs : Math.floor(meta?.format?.duration ?? durationSecs))
      })
    })

    // Generate WebVTT pointing at sprite offsets.
    // Cap to the tiles that actually exist in the single sprite sheet.
    // Videos longer than TILE_COLS * TILE_ROWS * INTERVAL seconds will have
    // seek previews only for the first portion — generating multiple sheets
    // is left for a future improvement.
    const maxThumbs = TILE_COLS * TILE_ROWS
    const thumbCount = Math.min(Math.ceil(durationSecs / INTERVAL), maxThumbs)
    const lines = ['WEBVTT', '']
    for (let i = 0; i < thumbCount; i++) {
      const startSecs  = i * INTERVAL
      const endSecs    = Math.min(startSecs + INTERVAL, durationSecs)
      const col        = i % TILE_COLS
      const row        = Math.floor(i / TILE_COLS) % TILE_ROWS
      const xoff       = col * THUMB_W
      const yoff       = row * THUMB_H
      lines.push(formatVttTime(startSecs) + ' --> ' + formatVttTime(endSecs))
      lines.push(`trickplay.jpg#xywh=${xoff},${yoff},${THUMB_W},${THUMB_H}`)
      lines.push('')
    }
    await writeFile(vttPath, lines.join('\n'), 'utf8')

    return {
      vtt_path:      vttPath,
      sprite_path:   spritePath,
      interval:      INTERVAL,
      tile_cols:     TILE_COLS,
      tile_rows:     TILE_ROWS,
      thumb_w:       THUMB_W,
      thumb_h:       THUMB_H,
      duration_secs: durationSecs,
    }
  })
}

function formatVttTime(secs) {
  const h   = Math.floor(secs / 3600)
  const m   = Math.floor((secs % 3600) / 60)
  const s   = Math.floor(secs % 60)
  const ms  = Math.round((secs % 1) * 1000)
  return `${pad2(h)}:${pad2(m)}:${pad2(s)}.${String(ms).padStart(3, '0')}`
}

function pad2(n) { return String(n).padStart(2, '0') }
