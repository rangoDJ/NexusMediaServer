import axios from 'axios'
import { createReadStream } from 'fs'
import { stat } from 'fs/promises'
import { extname, dirname, join } from 'path'
import { pickTranscoder } from '../services/transcoderPool.js'
import { fetchMovieById, fetchSeriesById, searchTmdb } from '../services/tmdb.js'
import { libraryFilterCondition, canAccessMediaItem, canAccessEpisode, getAllowedLibraryIds, resolveWithinLibrary } from '../services/libraryAccess.js'

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
    const { library_id, type, search, genre, sort = 'alphabetical', page = 1 } = request.query
    const limit  = Math.max(1, Math.min(parseInt(request.query.limit ?? '50', 10) || 50, 200))
    const offset = (Math.max(parseInt(page, 10) || 1, 1) - 1) * limit
    const userId = request.user.sub
    const params = [userId]
    const conditions = []

    if (library_id) { params.push(library_id); conditions.push(`m.library_id=$${params.length}`) }
    if (type)       { params.push(type);       conditions.push(`m.type=$${params.length}`) }
    if (search)     { params.push(`%${search}%`); conditions.push(`m.title ILIKE $${params.length}`) }
    if (genre)      { params.push(genre);      conditions.push(`$${params.length} = ANY(m.genres)`) }

    const libCond = await libraryFilterCondition(app.db, request.user, params, 'm.library_id')
    if (libCond) conditions.push(libCond)

    const ORDER_BY = {
      alphabetical:   'm.sort_title NULLS LAST, m.title',
      recently_added: 'm.created_at DESC NULLS LAST',
      random:         'RANDOM()',
      year_desc:      'm.year DESC NULLS LAST, m.title',
      rating:         'm.rating DESC NULLS LAST, m.title',
    }
    const orderBy = ORDER_BY[sort] ?? ORDER_BY.alphabetical
    const where   = conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''

    // wp = this user's progress on the movie/series row itself. For series,
    // "watched" isn't meaningful at the series level — unwatched_count (below)
    // is what the UI badges instead, mirroring Jellyfin's per-series
    // UnplayedItemCount vs per-movie Played checkmark.
    const { rows } = await app.db.query(
      `SELECT m.id, m.library_id, m.type, m.title, m.year, m.genres, m.poster_url, m.backdrop_url, m.rating,
              m.duration_secs, m.video_codec, m.audio_codec, m.container, m.width, m.height, m.created_at,
              m.metadata, m.dominant_color, m.blurhash,
              wp.completed AS watched, wp.position_secs,
              (uf.user_id IS NOT NULL) AS is_favorite,
              CASE WHEN m.type = 'series' THEN (
                SELECT COUNT(*)::int FROM episodes e
                LEFT JOIN watch_progress ewp ON ewp.episode_id = e.id AND ewp.user_id = $1
                WHERE e.series_id = m.id AND ewp.completed IS NOT TRUE
              ) ELSE NULL END AS unwatched_count
       FROM media_items m
       LEFT JOIN watch_progress wp ON wp.media_item_id = m.id AND wp.user_id = $1
       -- Lets a card render its favourite state correctly on first paint
       -- instead of guessing and then correcting itself.
       LEFT JOIN user_favorites uf ON uf.media_item_id = m.id AND uf.user_id = $1
       ${where}
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

  // Aggregate item counts for the dashboard overview tile row.
  app.get('/counts', async (request) => {
    const allowed = await getAllowedLibraryIds(app.db, request.user)
    const itemsWhere = allowed === null ? '' : ' WHERE library_id = ANY($1)'
    const episodeWhere = allowed === null ? '' : ' WHERE m.library_id = ANY($1)'
    const params = allowed === null ? [] : [[...allowed]]
    const [{ rows: byType }, { rows: [{ count: episodes }] }] = await Promise.all([
      app.db.query(`SELECT type, COUNT(*)::int AS count FROM media_items${itemsWhere} GROUP BY type`, params),
      app.db.query(
        `SELECT COUNT(*)::int AS count FROM episodes e
         JOIN media_items m ON m.id = e.series_id${episodeWhere}`,
        params
      ),
    ])
    const counts = { movies: 0, series: 0, episodes }
    for (const row of byType) {
      if (row.type === 'movie')  counts.movies = row.count
      if (row.type === 'series') counts.series = row.count
    }
    return counts
  })

  // Distinct genre list (for filter dropdowns)
  app.get('/genres', async (request) => {
    const { library_id } = request.query
    const allowed = await getAllowedLibraryIds(app.db, request.user)
    const conditions = []
    const params = []
    if (library_id) { params.push(library_id); conditions.push(`library_id=$${params.length}`) }
    // Intersect with the caller's allowed library set so genre lists can't
    // reveal the content of libraries the user was denied.
    if (allowed !== null) { params.push([...allowed]); conditions.push(`library_id = ANY($${params.length})`) }
    const where = conditions.length ? ` WHERE ${conditions.join(' AND ')}` : ''
    const { rows } = await app.db.query(
      `SELECT DISTINCT unnest(genres) AS genre
       FROM media_items${where}
       ORDER BY genre`,
      params
    )
    return rows.map(r => r.genre).filter(Boolean)
  })

  // Items the user started but hasn't finished, newest first
  app.get('/continue-watching', async (request) => {
    const params = [request.user.sub]
    const libCond = await libraryFilterCondition(app.db, request.user, params, 'm.library_id')
    const { rows } = await app.db.query(`
      SELECT m.id, m.type, m.title, m.year, m.poster_url, m.duration_secs,
             m.dominant_color, m.blurhash,
             wp.position_secs, wp.updated_at
      FROM watch_progress wp
      JOIN media_items m ON m.id = wp.media_item_id
      WHERE wp.user_id = $1 AND wp.completed = false AND wp.position_secs > 30
        ${libCond ? `AND ${libCond}` : ''}
      ORDER BY wp.updated_at DESC
      LIMIT 20
    `, params)
    return rows
  })

  // Items the current user has starred, newest first
  app.get('/favorites', async (request) => {
    const params = [request.user.sub]
    const libCond = await libraryFilterCondition(app.db, request.user, params, 'm.library_id')
    const { rows } = await app.db.query(`
      SELECT m.id, m.type, m.title, m.year, m.poster_url, m.backdrop_url,
             m.duration_secs, m.metadata, m.dominant_color, m.blurhash,
             uf.created_at AS favorited_at,
             wp.completed AS watched, wp.position_secs,
             CASE WHEN m.type = 'series' THEN (
               SELECT COUNT(*)::int FROM episodes e
               LEFT JOIN watch_progress ewp ON ewp.episode_id = e.id AND ewp.user_id = $1
               WHERE e.series_id = m.id AND ewp.completed IS NOT TRUE
             ) ELSE NULL END AS unwatched_count
      FROM user_favorites uf
      JOIN media_items m ON m.id = uf.media_item_id
      LEFT JOIN watch_progress wp ON wp.media_item_id = m.id AND wp.user_id = $1
      WHERE uf.user_id = $1
        ${libCond ? `AND ${libCond}` : ''}
      ORDER BY uf.created_at DESC
      LIMIT 50
    `, params)
    return rows.map(r => {
      applyLocalArtwork(r)
      delete r.metadata
      return r
    })
  })

  // Next unwatched episode for each series the user has started, newest first
  app.get('/next-up', async (request) => {
    const params = [request.user.sub]
    const libCond = await libraryFilterCondition(app.db, request.user, params, 'm.library_id')
    const { rows } = await app.db.query(`
      WITH last_watched_order AS (
        SELECT e.series_id,
          MAX(e.season_number * 1000 + e.episode_number) AS max_order
        FROM watch_progress wp
        JOIN episodes e ON e.id = wp.episode_id
        WHERE wp.user_id = $1 AND (wp.completed = true OR wp.position_secs > 30)
        GROUP BY e.series_id
      )
      SELECT DISTINCT ON (e.series_id)
        m.id            AS series_id,
        m.title         AS series_title,
        m.poster_url,
        m.metadata,
        -- Episodes have no artwork of their own, so they inherit their
        -- parent series' sample for both fields.
        m.dominant_color,
        m.blurhash,
        e.id            AS episode_id,
        e.season_number,
        e.episode_number,
        e.title         AS episode_title,
        e.duration_secs,
        COALESCE(wp.position_secs, 0) AS position_secs
      FROM last_watched_order lwo
      JOIN episodes e ON e.series_id = lwo.series_id
        AND (e.season_number * 1000 + e.episode_number) >= lwo.max_order
      JOIN media_items m ON m.id = e.series_id
      LEFT JOIN watch_progress wp ON wp.episode_id = e.id AND wp.user_id = $1
      WHERE COALESCE(wp.completed, false) = false
        ${libCond ? `AND ${libCond}` : ''}
      ORDER BY e.series_id, e.season_number, e.episode_number
      LIMIT 20
    `, params)
    return rows.map(r => {
      applyLocalArtwork(r)
      delete r.metadata
      return r
    })
  })

  // Single media item with full metadata
  app.get('/:id', async (request, reply) => {
    if (!(await canAccessMediaItem(app.db, request.user, request.params.id))) {
      return reply.code(404).send({ error: 'Not found' })
    }
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
  // The file path is realpath()'d and must resolve INSIDE the item's library
  // root — this blocks a symlink/tainted DB path turning the route into an
  // arbitrary-file read.
  for (const kind of ['poster', 'backdrop']) {
    app.get(`/:id/${kind}`, { config: { public: true } }, async (request, reply) => {
      const { rows } = await app.db.query(
        'SELECT library_id, metadata FROM media_items WHERE id=$1', [request.params.id]
      )
      if (!rows.length) return reply.code(404).send({ error: 'Not found' })
      const stored = rows[0].metadata?.[`local_${kind}_path`]
      if (!stored) return reply.code(404).send({ error: `No local ${kind}` })
      const path = await resolveWithinLibrary(app.db, rows[0].library_id, stored)
      if (!path) return reply.code(404).send({ error: `${kind} file missing on disk` })
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
      if (!(await canAccessEpisode(app.db, request.user, episode_id))) {
        return reply.code(404).send({ error: 'Episode not found' })
      }
      const { rows } = await app.db.query('SELECT * FROM episodes WHERE id=$1', [episode_id])
      if (!rows.length) return reply.code(404).send({ error: 'Episode not found' })
      item = rows[0]
    } else {
      if (!(await canAccessMediaItem(app.db, request.user, request.params.id))) {
        return reply.code(404).send({ error: 'Not found' })
      }
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

  // ── Favorites ────────────────────────────────────────────────────────────────

  app.get('/:id/favorite', async (request) => {
    const { rows } = await app.db.query(
      'SELECT 1 FROM user_favorites WHERE user_id=$1 AND media_item_id=$2',
      [request.user.sub, request.params.id]
    )
    return { is_favorite: rows.length > 0 }
  })

  app.post('/:id/favorite', async (request, reply) => {
    await app.db.query(`
      INSERT INTO user_favorites(user_id, media_item_id) VALUES($1,$2)
      ON CONFLICT DO NOTHING
    `, [request.user.sub, request.params.id])
    return reply.code(204).send()
  })

  app.delete('/:id/favorite', async (request, reply) => {
    await app.db.query(
      'DELETE FROM user_favorites WHERE user_id=$1 AND media_item_id=$2',
      [request.user.sub, request.params.id]
    )
    return reply.code(204).send()
  })

  // ── Manual re-identification ──────────────────────────────────────────────────

  // Search TMDB for alternative matches (admin only)
  app.get('/:id/rematch', async (request, reply) => {
    if (request.user.role !== 'admin') return reply.code(403).send({ error: 'Forbidden' })
    const { query } = request.query
    if (!query?.trim()) return reply.code(400).send({ error: 'query is required' })

    const { rows } = await app.db.query('SELECT type FROM media_items WHERE id=$1', [request.params.id])
    if (!rows.length) return reply.code(404).send({ error: 'Not found' })

    const tmdbType = rows[0].type === 'series' ? 'tv' : 'movie'
    try {
      return await searchTmdb(query.trim(), tmdbType)
    } catch (err) {
      app.log.warn(err, 'TMDB rematch search failed')
      return reply.code(502).send({ error: 'TMDB search failed' })
    }
  })

  // Apply a chosen TMDB match — force-overwrites all metadata (admin only)
  app.post('/:id/rematch', async (request, reply) => {
    if (request.user.role !== 'admin') return reply.code(403).send({ error: 'Forbidden' })
    const { tmdb_id } = request.body ?? {}
    if (!tmdb_id) return reply.code(400).send({ error: 'tmdb_id is required' })

    const { rows } = await app.db.query('SELECT * FROM media_items WHERE id=$1', [request.params.id])
    if (!rows.length) return reply.code(404).send({ error: 'Not found' })
    const item = rows[0]

    let meta
    try {
      meta = item.type === 'series'
        ? await fetchSeriesById(String(tmdb_id))
        : await fetchMovieById(String(tmdb_id))
    } catch (err) {
      app.log.warn(err, 'TMDB rematch fetch failed')
      return reply.code(502).send({ error: 'TMDB fetch failed' })
    }
    if (!meta.tmdb_id) return reply.code(502).send({ error: 'TMDB returned no data for that id' })

    const metaUpdate = {}
    if (meta.tagline) metaUpdate.tagline = meta.tagline
    if (meta.director) metaUpdate.director = meta.director
    if (meta.writer)   metaUpdate.writer   = meta.writer
    if (meta.cast)     metaUpdate.cast     = meta.cast
    if (meta.studios)  metaUpdate.studios  = meta.studios

    await app.db.query(`
      UPDATE media_items
      SET tmdb_id=$1, imdb_id=$2, title=$3, sort_title=$4, year=$5, plot=$6,
          tagline=$7, rating=$8, genres=$9, poster_url=$10, backdrop_url=$11,
          metadata=metadata || $12::jsonb, updated_at=now()
      WHERE id=$13
    `, [
      meta.tmdb_id,
      meta.imdb_id ?? item.imdb_id,
      meta.title,
      meta.sort_title ?? meta.title,
      meta.year ?? item.year,
      meta.plot ?? item.plot,
      meta.tagline ?? item.tagline,
      meta.rating ?? item.rating,
      meta.genres ?? item.genres,
      meta.poster_url ?? item.poster_url,
      meta.backdrop_url ?? item.backdrop_url,
      JSON.stringify(metaUpdate),
      item.id,
    ])

    const { rows: updated } = await app.db.query('SELECT * FROM media_items WHERE id=$1', [item.id])
    return updated[0]
  })

  // ── Trickplay ────────────────────────────────────────────────────────────────
  // WebVTT and JPEG sprite sheet for seek-bar thumbnail previews.
  // Accept token via query param so the Vidstack thumbnails prop can use
  // a plain URL without custom headers. The sprite sheets are content frame
  // thumbnails, so they require auth (the browser sends the httpOnly cookie
  // automatically on same-origin image requests) AND a library access check,
  // unlike the more benign poster/backdrop artwork.

  app.get('/:id/trickplay.vtt', { config: { public: false } }, async (request, reply) => {
    if (!(await canAccessMediaItem(app.db, request.user, request.params.id))) {
      return reply.code(404).send({ error: 'Not found' })
    }
    const { rows } = await app.db.query(
      'SELECT trickplay_path FROM media_items WHERE id=$1', [request.params.id]
    )
    if (!rows.length || !rows[0].trickplay_path) {
      return reply.code(404).send({ error: 'No trickplay available' })
    }
    return serveTrickplayFile(reply, rows[0].trickplay_path, 'text/vtt; charset=utf-8')
  })

  app.get('/:id/trickplay.jpg', { config: { public: false } }, async (request, reply) => {
    if (!(await canAccessMediaItem(app.db, request.user, request.params.id))) {
      return reply.code(404).send({ error: 'Not found' })
    }
    const { rows } = await app.db.query(
      'SELECT trickplay_path FROM media_items WHERE id=$1', [request.params.id]
    )
    if (!rows.length || !rows[0].trickplay_path) {
      return reply.code(404).send({ error: 'No trickplay available' })
    }
    const spritePath = join(dirname(rows[0].trickplay_path), 'trickplay.jpg')
    return serveTrickplayFile(reply, spritePath, 'image/jpeg')
  })

  app.get('/episode/:id/trickplay.vtt', { config: { public: false } }, async (request, reply) => {
    if (!(await canAccessEpisode(app.db, request.user, request.params.id))) {
      return reply.code(404).send({ error: 'Not found' })
    }
    const { rows } = await app.db.query(
      'SELECT trickplay_path FROM episodes WHERE id=$1', [request.params.id]
    )
    if (!rows.length || !rows[0].trickplay_path) {
      return reply.code(404).send({ error: 'No trickplay available' })
    }
    return serveTrickplayFile(reply, rows[0].trickplay_path, 'text/vtt; charset=utf-8')
  })

  app.get('/episode/:id/trickplay.jpg', { config: { public: false } }, async (request, reply) => {
    if (!(await canAccessEpisode(app.db, request.user, request.params.id))) {
      return reply.code(404).send({ error: 'Not found' })
    }
    const { rows } = await app.db.query(
      'SELECT trickplay_path FROM episodes WHERE id=$1', [request.params.id]
    )
    if (!rows.length || !rows[0].trickplay_path) {
      return reply.code(404).send({ error: 'No trickplay available' })
    }
    const spritePath = join(dirname(rows[0].trickplay_path), 'trickplay.jpg')
    return serveTrickplayFile(reply, spritePath, 'image/jpeg')
  })

  // ── Intro / credits segments ─────────────────────────────────────────────────
  app.get('/episode/:id/segments', async (request, reply) => {
    if (!(await canAccessEpisode(app.db, request.user, request.params.id))) {
      return reply.code(404).send({ error: 'Not found' })
    }
    const { rows } = await app.db.query(
      `SELECT id, type, start_secs, end_secs
       FROM media_segments WHERE episode_id=$1 ORDER BY start_secs`,
      [request.params.id]
    )
    return rows
  })
}

// Serve a trickplay file (VTT or JPEG) directly from the filesystem.
async function serveTrickplayFile(reply, filePath, contentType) {
  try {
    const st = await stat(filePath)
    reply.headers({
      'Content-Type':   contentType,
      'Content-Length': st.size,
      'Cache-Control':  'private, max-age=604800',
    })
    return reply.send(createReadStream(filePath))
  } catch {
    return reply.code(404).send({ error: 'Trickplay file not found on disk' })
  }
}

// Proxy a single subtitle track from a transcoder node back to the client
// as WebVTT. The .idx URL param is the ffmpeg stream index from probe.
async function proxySubtitle(app, request, reply, { isEpisode }) {
  const idx = parseInt(request.params.idx, 10)
  if (Number.isNaN(idx)) return reply.code(400).send({ error: 'Bad subtitle index' })

  // Proxy Subtitle tracks are content — gate them with the same library
  // access check every other media route uses, so a restricted user can't
  // pull subtitle text for items in libraries they were denied.
  if (isEpisode) {
    if (!(await canAccessEpisode(app.db, request.user, request.params.id))) {
      return reply.code(404).send({ error: 'Episode not found' })
    }
  } else if (!(await canAccessMediaItem(app.db, request.user, request.params.id))) {
    return reply.code(404).send({ error: 'Media not found' })
  }

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
