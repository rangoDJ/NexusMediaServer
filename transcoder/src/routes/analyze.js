import { execFile } from 'child_process'
import { promisify } from 'util'

const execFileAsync = promisify(execFile)

export default async function analyzeRoutes(app) {
  /**
   * POST /analyze/chromaprint
   * Body: { file_path, duration?: number }
   * Returns { fingerprint: string, duration_secs: number }
   *
   * Uses fpcalc (chromaprint CLI) to produce a raw audio fingerprint.
   * If fpcalc is unavailable, falls back to ffmpeg -af chromaprint.
   */
  app.post('/chromaprint', async (request, reply) => {
    const { file_path, duration = 120 } = request.body
    if (!file_path) return reply.code(400).send({ error: 'file_path is required' })

    // Try fpcalc first (fast, purpose-built)
    try {
      const { stdout } = await execFileAsync('fpcalc', [
        '-raw', '-length', String(duration), file_path,
      ], { timeout: 60_000 })
      const fpLine  = stdout.split('\n').find(l => l.startsWith('FINGERPRINT='))
      const durLine = stdout.split('\n').find(l => l.startsWith('DURATION='))
      if (fpLine) {
        return {
          fingerprint:   fpLine.slice('FINGERPRINT='.length).trim(),
          duration_secs: durLine ? parseFloat(durLine.slice('DURATION='.length)) : duration,
        }
      }
    } catch {
      // fpcalc not available or failed — fall back to ffmpeg chromaprint filter
    }

    // ffmpeg fallback: write fingerprint to stderr via -af chromaprint=fp_format=raw
    try {
      const { stderr } = await execFileAsync('ffmpeg', [
        '-i', file_path,
        '-t', String(duration),
        '-af', 'chromaprint=fp_format=raw',
        '-f', 'null', '-',
      ], { timeout: 90_000 })

      const match = stderr.match(/fingerprint=([0-9,]+)/)
      if (!match) return reply.code(422).send({ error: 'Could not extract fingerprint' })
      return { fingerprint: match[1], duration_secs: duration }
    } catch (err) {
      app.log.error({ err }, '[analyze] chromaprint failed')
      return reply.code(500).send({ error: 'Fingerprint extraction failed' })
    }
  })
}
