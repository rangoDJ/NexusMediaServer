import axios from 'axios'
import { parseFingerprint, detectIntros } from '../services/introAnalyzer.js'

export const analyzeIntrosTask = {
  id:          'analyze-intros',
  name:        'Detect Intro Segments',
  description: 'Uses audio fingerprinting to detect intro and credits windows in TV episodes.',
  category:    'Media',

  defaultTriggers: [
    { type: 'daily', timeOfDay: '03:00' },
  ],

  async execute({ db, log, signal, progress }) {
    const node = await pickNode(db)
    if (!node) {
      log.warn('[tasks/intros] No active transcoder node — skipping')
      return
    }

    // Find all series that have episodes without intro segments
    const { rows: seriesRows } = await db.query(`
      SELECT DISTINCT m.id AS series_id, m.title
      FROM media_items m
      JOIN episodes e ON e.series_id = m.id
      WHERE m.type = 'series'
        AND e.file_path IS NOT NULL
        AND NOT EXISTS (
          SELECT 1 FROM media_segments ms
          WHERE ms.episode_id = e.id AND ms.type = 'intro'
        )
    `)

    if (!seriesRows.length) {
      log.info('[tasks/intros] No series need intro analysis — nothing to do')
      return
    }

    log.info(`[tasks/intros] Analyzing ${seriesRows.length} series`)
    let seriesDone = 0

    for (const series of seriesRows) {
      if (signal.aborted) {
        log.info('[tasks/intros] Cancelled')
        return
      }

      // Group episodes by season
      const { rows: episodes } = await db.query(`
        SELECT id, file_path, season_number, episode_number, duration_secs
        FROM episodes
        WHERE series_id = $1 AND file_path IS NOT NULL
        ORDER BY season_number, episode_number
      `, [series.series_id])

      const bySeason = new Map()
      for (const ep of episodes) {
        const s = ep.season_number ?? 0
        if (!bySeason.has(s)) bySeason.set(s, [])
        bySeason.get(s).push(ep)
      }

      for (const [season, eps] of bySeason) {
        if (signal.aborted) return
        if (eps.length < 2) {
          // Can't fingerprint-compare intros with only one episode. Mark it
          // analyzed anyway (a zero-length "no intro" sentinel) so this
          // season stops matching the outer "needs analysis" query — without
          // this, the whole series matches forever and every OTHER season
          // gets re-fingerprinted on every run just because of this one.
          await markNoIntro(db, eps)
          continue
        }

        log.info(`[tasks/intros] "${series.title}" S${season} — fingerprinting ${eps.length} episodes`)

        // Fingerprint each episode (first 2 minutes of audio only)
        const fingerprinted = []
        for (const ep of eps) {
          if (signal.aborted) return
          try {
            const { data } = await axios.post(
              `${node.url}/analyze/chromaprint`,
              { file_path: ep.file_path, duration: 120 },
              {
                headers: { 'x-transcoder-secret': process.env.TRANSCODER_SECRET },
                timeout: 120_000,
              }
            )
            fingerprinted.push({
              id:            ep.id,
              fingerprint:   parseFingerprint(data.fingerprint),
              duration_secs: data.duration_secs,
            })
          } catch (err) {
            log.warn(`[tasks/intros] Fingerprint failed for episode ${ep.id}: ${err.message}`)
          }
        }

        if (fingerprinted.length < 2) {
          await markNoIntro(db, eps)
          continue
        }

        const segments = detectIntros(fingerprinted)
        if (!segments.length) {
          log.info(`[tasks/intros] No common intro found in "${series.title}" S${season}`)
          await markNoIntro(db, eps)
          continue
        }

        // Upsert segments — replace any existing intro segments for these episodes
        for (const seg of segments) {
          await db.query(`
            INSERT INTO media_segments(episode_id, type, start_secs, end_secs)
            VALUES($1, 'intro', $2, $3)
            ON CONFLICT (episode_id, type) DO UPDATE
              SET start_secs = EXCLUDED.start_secs,
                  end_secs   = EXCLUDED.end_secs
          `, [seg.episode_id, seg.start_secs, seg.end_secs])
        }
        log.info(`[tasks/intros] ✓ "${series.title}" S${season}: intro ${segments[0].start_secs}s–${segments[0].end_secs}s (${segments.length} episodes)`)
      }

      seriesDone++
      progress(Math.round((seriesDone / seriesRows.length) * 100))
    }

    log.info(`[tasks/intros] Done — processed ${seriesDone} series`)
  },
}

// Records "analyzed, no intro segment" for episodes we're not going to
// fingerprint-compare (or found no common intro for) — a zero-length
// sentinel row so the outer query's NOT EXISTS stops matching them.
async function markNoIntro(db, episodes) {
  for (const ep of episodes) {
    await db.query(`
      INSERT INTO media_segments(episode_id, type, start_secs, end_secs)
      VALUES($1, 'intro', 0, 0)
      ON CONFLICT (episode_id, type) DO NOTHING
    `, [ep.id])
  }
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
