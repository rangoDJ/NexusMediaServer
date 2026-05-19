import axios from 'axios'
import { createReadStream } from 'fs'
import { stat } from 'fs/promises'
import { extname } from 'path'
import { pickTranscoder } from '../services/transcoderPool.js'

// Codecs natively supported for direct play in common mobile/browser environments.
// Mobile apps pass their own list via ?client_codecs= to get an accurate answer.
const DEFAULT_DIRECT_PLAY_CODECS = new Set(['h264', 'aac', 'mp3', 'vp8', 'vp9'])
const DEFAULT_DIRECT_PLAY_CONTAINERS = new Set(['mp4', 'webm', 'm4v'])

const IMAGE_MIME = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
                     '.png': 'image/png',  '.webp': 'image/webp' }

/**
 * Rewrites poster_url / backdrop_url on a media row so that when TMDB had no
 * artwork but the scanner found a local poster.jpg / fanart.jpg, the client
 * gets a working URL pointing at our artwork-serving endpoint.
 * Mutates and returns the same row for convenience.
 */
function applyLocalArtwork(row) {
  if (!row) return row
  const meta = row.metadata ?? {}
  if (!row.poster_url   && meta.local_poster_path)   row.poster_url   = `/api/v1/media/${row.id}/poster`
  if (!row.backdrop_url && meta.local_backdrop_path) row.backdrop_url = `/api/v1/media/${row.id}/backdrop`
  return row
}

export default async function mediaRoutes(app) {
  // Subtitle .vtt URLs are loaded by the <track> element which can't set
  // Authorization headers — accept the JWT as ?token= as a fallback.
  // Skips auth for routes that opt in via `config.public: true` — used for
  // poster/backdrop images so <img> tags work without token-juggling.
  app.addHook('preHandler', async (request, reply) => {
    if (request.routeOptions?.config?.public) return
    if (request.query.token && !request.headers.authorization) {
      request.headers.authorization = `Bearer ${request.query.token}`
    }
    return app.authenticate(request, reply)
  })

  // List media (paginated). Supports filtering and sorting for the home page rows.
  // sort = alphabetical | recently_added | random | year_desc | rating
  app.get('/', async (request) => {
    const { library_id, type, search, genre, sort = 'alphabetical', page = 1, limit = 50 } = request.query
    const offset = (page - 1) * limit
    const params = []
    const conditions = []

    if (library_id) { params.push(library_id); conditions.push(`library_id=$${params.length}`) }
    if (type)       { params.push(type);       conditions.push(`type=$${params.length}`) }
    if (search)     { params.push(`%${search}%`); conditions.push(`title ILIKE $${params.length}`) }
    if (genre)      { params.push(genre);      conditions.push(`$${params.length} = ANY(genres)`) }

    const ORDER_BY = {
      alphabetical:   'sort_title NULLS LAST, title',
      recently_added: 'created_at DESC NULLS LAST',
      random:         'RANDOM()',
      year_desc:      'year DESC NULLS LAST, title',
      rating:         'rating DESC NULLS LAST, title',
    }
    const orderBy = ORDER_BY[sort] ?? ORDER_BY.alphabetical
    const where   = conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''

    const { rows } = await app.db.query(
      `SELECT id, library_id, type, title, year, genres, poster_url, backdrop_url, rating,
              duration_secs, video_codec, audio_codec, container, width, height, created_at,
              metadata
       FROM media_items ${where}
       ORDER BY ${orderBy}
       LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, limit, offset]
    )
    // Rewrite poster_url / backdrop_url to point at the local-artwork route
    // for items that have local poster.jpg but no TMDB poster.
    return rows.map(r => {
      applyLocalArtwork(r)
      delete r.metadata // not needed by clients listing many items
      return r
    })
  })

  // Distinct genre list (for filter dropdowns)
  app.get('/genres', async (request) => {
    const { library_id } = request.query
    const params = []
    let where = ''
    if (library_id) { params.push(library_id); where = `WHERE library_id=$1` }
    const { rows } = await app.db.query(
      `SELECT DISTINCT unnest(genres) AS genre
       FROM media_items ${where}
       ORDER BY genre`,
      params
    )
    return rows.map(r => r.genre).filter(Boolean)
  })

  // Items the user started but hasn't finished, newest first
  app.get('/continue-watching', async (request) => {
    const { rows } = await app.db.query(`
      SELECT m.id, m.type, m.title, m.year, m.poster_url, m.duration_secs,
             wp.position_secs, wp.updated_at
      FROM watch_progress wp
      JOIN media_items m ON m.id = wp.media_item_id
      WHERE wp.user_id = $1 AND wp.completed = false AND wp.position_secs > 30
      ORDER BY wp.updated_at DESC
      LIMIT 20
    `, [request.user.sub])
    return rows
  })

  // Single media item with full metadata
  app.get('/:id', async (request, reply) => {
    const { rows } = await app.db.query('SELECT * FROM media_items WHERE id=$1', [request.params.id])
    if (!rows.length) return reply.code(404).send({ error: 'Not found' })
    const item = applyLocalArtwork(rows[0])

    if (item.type === 'series') {
      const { rows: episodes } = await app.db.query(
        `SELECT id, season_number, episode_number, title, duration_secs,
                video_codec, audio_codec, container, width, height
         FROM episodes WHERE series_id=$1 ORDER BY season_number, episode_number`,
        [item.id]
      )
      item.episodes = episodes
    }
    return item
  })

  // Serve local poster / backdrop images stored alongside the media file.
  // PUBLIC route (config.public:true) — <img> tags can't send auth headers
  // and posters aren't sensitive content. Cached aggressively client-side.
  for (const kind of ['poster', 'backdrop']) {
    app.get(`/:id/${kind}`, { config: { public: true } }, async (request, reply) => {
      const { rows } = await app.db.query(
        'SELECT metadata FROM media_items WHERE id=$1', [request.params.id]
      )
      if (!rows.length) return reply.code(404).send({ error: 'Not found' })
      const path = rows[0].metadata?.[`local_${kind}_path`]
      if (!path) return reply.code(404).send({ error: `No local ${kind}` })
      let st
      try { st = await stat(path) }
      catch { return reply.code(404).send({ error: `${kind} file missing on disk` }) }
      const mime = IMAGE_MIME[extname(path).toLowerCase()] ?? 'application/octet-stream'
      reply.headers({
        'Content-Type':   mime,
        'Content-Length': st.size,
        'Cache-Control':  'private, max-age=86400',
      })
      return reply.send(createReadStream(path))
    })
  }

  // Playback info — the primary endpoint for mobile apps before starting a stream.
  // Tells the client whether it can direct-play the file or needs transcoding,
  // and what parameters to use if transcoding is required.
  //
  // Query params:
  //   client_codecs      comma-separated list of codecs the client supports (e.g. h264,aac)
  //   client_containers  comma-separated list of containers the client supports (e.g. mp4,webm)
  //   episode_id         (optional) for a specific episode instead of the media item
  app.get('/:id/playback-info', async (request, reply) => {
    const { episode_id, client_codecs, client_containers } = request.query

    const clientCodecs = client_codecs
      ? new Set(client_codecs.split(',').map(s => s.trim().toLowerCase()))
      : DEFAULT_DIRECT_PLAY_CODECS

    const clientContainers = client_containers
      ? new Set(client_containers.split(',').map(s => s.trim().toLowerCase()))
      : DEFAULT_DIRECT_PLAY_CONTAINERS

    let item
    if (episode_id) {
      const { rows } = await app.db.query('SELECT * FROM episodes WHERE id=$1', [episode_id])
      if (!rows.length) return reply.code(404).send({ error: 'Episode not found' })
      item = rows[0]
    } else {
      const { rows } = await app.db.query('SELECT * FROM media_items WHERE id=$1', [request.params.id])
      if (!rows.length) return reply.code(404).send({ error: 'Not found' })
      item = rows[0]
    }

    const videoCodec     = item.video_codec?.toLowerCase()
    const audioCodec     = item.audio_codec?.toLowerCase()
    const container      = item.container?.toLowerCase()

    const videoOk     = !videoCodec || clientCodecs.has(videoCodec)
    const audioOk     = !audioCodec || clientCodecs.has(audioCodec)
    const containerOk = !container || clientContainers.has(container)
    const canDirectPlay = videoOk && audioOk && containerOk

    const reasons = []
    if (!videoOk)     reasons.push(`video codec "${videoCodec}" not supported by client`)
    if (!audioOk)     reasons.push(`audio codec "${audioCodec}" not supported by client`)
    if (!containerOk) reasons.push(`container "${container}" not supported by client`)

    // Recommend the lowest-effort transcode that will work
    const recommendedCodec      = clientCodecs.has('h264') ? 'h264' : 'h265'
    const recommendedResolution = item.height >= 2160 ? '4k'
      : item.height >= 1080 ? '1080p'
      : item.height >= 720  ? '720p'
      : '480p'

    return {
      media_id:   item.series_id ? undefined : item.id,
      episode_id: item.series_id ? item.id   : undefined,
      title:      item.title,
      file: {
        container,
        video_codec:  videoCodec,
        audio_codec:  audioCodec,
        duration_secs: item.duration_secs,
        width:         item.width,
        height:        item.height,
        bitrate_kbps:  item.bitrate_kbps,
        file_size:     item.file_size,
      },
      playback: {
        direct_play:         canDirectPlay,
        direct_play_reasons: reasons,
        // Pre-built path the web client can drop into a <video src=...>
        // (it appends ?token= itself).
        direct_play_url: canDirectPlay
          ? (item.series_id
              ? `/api/v1/stream/direct?episode_id=${item.id}`
              : `/api/v1/stream/direct?media_item_id=${item.id}`)
          : null,
        stream_endpoint:    '/api/v1/stream/start',
        recommended_params: canDirectPlay ? null : {
          codec:      recommendedCodec,
          resolution: recommendedResolution,
        },
      },
      // Embedded text subtitle tracks the Player can request as WebVTT.
      // Populated during scan (see scanner.js → metadata.subtitle_streams).
      subtitle_tracks: ((item.metadata?.subtitle_streams) ?? []).map(s => ({
        stream_index: s.index,
        language:     s.language,
        title:        s.title,
        codec:        s.codec,
        forced:       s.forced ?? false,
        default:      s.default ?? false,
        url: item.series_id
          ? `/api/v1/media/episode/${item.id}/subtitle/${s.index}.vtt`
          : `/api/v1/media/${item.id}/subtitle/${s.index}.vtt`,
      })),
    }
  })

  // Proxy a single subtitle track from the file as WebVTT. Goes through a
  // transcoder node (the API container has no ffmpeg).
  app.get('/:id/subtitle/:idx.vtt', async (request, reply) => {
    return proxySubtitle(app, request, reply, { isEpisode: false })
  })
  app.get('/episode/:id/subtitle/:idx.vtt', async (request, reply) => {
    return proxySubtitle(app, request, reply, { isEpisode: true })
  })

  // Watch progress
  app.get('/:id/progress', async (request) => {
    const userId = request.user.sub
    const { rows } = await app.db.query(
      'SELECT * FROM watch_progress WHERE user_id=$1 AND media_item_id=$2',
      [userId, request.params.id]
    )
    return rows[0] ?? { position_secs: 0, completed: false }
  })

  app.put('/:id/progress', async (request, reply) => {
    const userId = request.user.sub
    const { position_secs, duration_secs, completed } = request.body
    await app.db.query(`
      INSERT INTO watch_progress(user_id, media_item_id, position_secs, duration_secs, completed)
      VALUES($1,$2,$3,$4,$5)
      ON CONFLICT (user_id, media_item_id) DO UPDATE
        SET position_secs=$3, duration_secs=$4, completed=$5, updated_at=now()
    `, [userId, request.params.id, position_secs, duration_secs, completed ?? false])
    return reply.code(204).send()
  })

  // Episode-level watch progress (separate from media_item progress)
  app.get('/episode/:episodeId/progress', async (request) => {
    const { rows } = await app.db.query(
      'SELECT * FROM watch_progress WHERE user_id=$1 AND episode_id=$2',
      [request.user.sub, request.params.episodeId]
    )
    return rows[0] ?? { position_secs: 0, completed: false }
  })

  app.put('/episode/:episodeId/progress', async (request, reply) => {
    const { position_secs, duration_secs, completed } = request.body
    await app.db.query(`
      INSERT INTO watch_progress(user_id, episode_id, position_secs, duration_secs, completed)
      VALUES($1,$2,$3,$4,$5)
      ON CONFLICT (user_id, episode_id) DO UPDATE
        SET position_secs=$3, duration_secs=$4, completed=$5, updated_at=now()
    `, [request.user.sub, request.params.episodeId, position_secs, duration_secs, completed ?? false])
    return reply.code(204).send()
  })
}

// Proxy a single subtitle track from a transcoder node back to the client
// as WebVTT. The .idx URL param is the ffmpeg stream index from probe.
async function proxySubtitle(app, request, reply, { isEpisode }) {
  const idx = parseInt(request.params.idx, 10)
  if (Number.isNaN(idx)) return reply.code(400).send({ error: 'Bad subtitle index' })

  let filePath
  if (isEpisode) {
    const { rows } = await app.db.query('SELECT file_path FROM episodes WHERE id=$1', [request.params.id])
    if (!rows.length) return reply.code(404).send({ error: 'Episode not found' })
    filePath = rows[0].file_path
  } else {
    const { rows } = await app.db.query('SELECT file_path FROM media_items WHERE id=$1', [request.params.id])
    if (!rows.length) return reply.code(404).send({ error: 'Media not found' })
    filePath = rows[0].file_path
  }
  if (!filePath) return reply.code(404).send({ error: 'No file' })

  const node = await pickTranscoder(app.db)
  if (!node) return reply.code(503).send({ error: 'No transcoder available for subtitle extraction' })

  try {
    const resp = await axios.post(
      `${node.url}/subtitle`,
      { file_path: filePath, stream_index: idx },
      {
        headers: { 'x-transcoder-secret': process.env.TRANSCODER_SECRET },
        responseType: 'arraybuffer',
        timeout: 60_000,
      }
    )
    reply.headers({
      'Content-Type':  'text/vtt; charset=utf-8',
      'Cache-Control': 'private, max-age=86400',
    })
    return reply.send(Buffer.from(resp.data))
  } catch (err) {
    app.log.warn(err, `Subtitle extraction failed (${filePath} idx=${idx})`)
    return reply.code(502).send({ error: 'Subtitle extraction failed' })
  }
}
