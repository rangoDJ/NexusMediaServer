import { mkdir } from 'fs/promises'
import { join } from 'path'
import axios from 'axios'

const TRICKPLAY_BASE = process.env.TRICKPLAY_PATH ?? '/config/trickplay'

export const generateTrickplayTask = {
  id:          'generate-trickplay',
  name:        'Generate Trickplay Thumbnails',
  description: 'Generates seek-bar preview sprite sheets for movies and episodes that are missing them.',
  category:    'Media',

  defaultTriggers: [
    { type: 'daily', timeOfDay: '04:00' },
  ],

  async execute({ db, log, signal, progress }) {
    // Find all media_items (movies) and episodes missing trickplay
    const { rows: movies } = await db.query(`
      SELECT id, file_path, title FROM media_items
      WHERE trickplay_path IS NULL AND file_path IS NOT NULL AND type = 'movie'
      ORDER BY created_at DESC
    `)
    const { rows: episodes } = await db.query(`
      SELECT e.id, e.file_path, e.season_number, e.episode_number,
             m.title AS series_title
      FROM episodes e
      JOIN media_items m ON m.id = e.series_id
      WHERE e.trickplay_path IS NULL AND e.file_path IS NOT NULL
      ORDER BY e.created_at DESC
    `)

    const all = [
      ...movies.map(r => ({ ...r, kind: 'movie' })),
      ...episodes.map(r => ({ ...r, kind: 'episode' })),
    ]

    if (!all.length) {
      log.info('[tasks/trickplay] All items already have trickplay — nothing to do')
      return
    }

    log.info(`[tasks/trickplay] ${all.length} item(s) need trickplay generation`)

    // Pick a transcoder node for ffmpeg work
    const node = await pickNode(db)
    if (!node) {
      log.warn('[tasks/trickplay] No active transcoder node available — skipping')
      return
    }

    let done = 0
    for (const item of all) {
      if (signal.aborted) {
        log.info('[tasks/trickplay] Cancelled')
        return
      }

      const label = item.kind === 'movie'
        ? item.title
        : `${item.series_title} S${item.season_number}E${item.episode_number}`

      const outputDir = item.kind === 'movie'
        ? join(TRICKPLAY_BASE, 'movies', item.id)
        : join(TRICKPLAY_BASE, 'episodes', item.id)

      try {
        await mkdir(outputDir, { recursive: true })

        const { data } = await axios.post(
          `${node.url}/trickplay`,
          { file_path: item.file_path, output_dir: outputDir },
          {
            headers: { 'x-transcoder-secret': process.env.TRANSCODER_SECRET },
            timeout: 10 * 60 * 1000, // 10 min — large files take a while
          }
        )

        const vttPath = data.vtt_path
        if (item.kind === 'movie') {
          await db.query('UPDATE media_items SET trickplay_path=$1 WHERE id=$2', [vttPath, item.id])
        } else {
          await db.query('UPDATE episodes SET trickplay_path=$1 WHERE id=$2', [vttPath, item.id])
        }
        log.info(`[tasks/trickplay] ✓ ${label}`)
      } catch (err) {
        log.warn(`[tasks/trickplay] ✗ ${label}: ${err.message}`)
      }

      done++
      progress(Math.round((done / all.length) * 100))
    }

    log.info(`[tasks/trickplay] Done — ${done}/${all.length} processed`)
  },
}

async function pickNode(db) {
  const { rows } = await db.query(`
    SELECT id, url FROM transcoder_nodes
    WHERE is_enabled = true
      AND last_seen_at > now() - interval '2 minutes'
    ORDER BY active_sessions ASC
    LIMIT 1
  `)
  return rows[0] ?? null
}
