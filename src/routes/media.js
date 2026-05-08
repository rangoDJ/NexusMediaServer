// Codecs natively supported for direct play in common mobile/browser environments.
// Mobile apps pass their own list via ?client_codecs= to get an accurate answer.
const DEFAULT_DIRECT_PLAY_CODECS = new Set(['h264', 'aac', 'mp3', 'vp8', 'vp9'])
const DEFAULT_DIRECT_PLAY_CONTAINERS = new Set(['mp4', 'webm', 'm4v'])

export default async function mediaRoutes(app) {
  app.addHook('preHandler', app.authenticate)

  // List media in a library (paginated)
  app.get('/', async (request) => {
    const { library_id, type, search, page = 1, limit = 50 } = request.query
    const offset = (page - 1) * limit
    const params = []
    const conditions = []

    if (library_id) { params.push(library_id); conditions.push(`library_id=$${params.length}`) }
    if (type) { params.push(type); conditions.push(`type=$${params.length}`) }
    if (search) { params.push(`%${search}%`); conditions.push(`title ILIKE $${params.length}`) }

    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''
    const { rows } = await app.db.query(
      `SELECT id, library_id, type, title, year, genres, poster_url, backdrop_url, rating,
              duration_secs, video_codec, audio_codec, container, width, height
       FROM media_items ${where}
       ORDER BY sort_title NULLS LAST, title
       LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, limit, offset]
    )
    return rows
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
    const item = rows[0]

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
        direct_play:          canDirectPlay,
        direct_play_reasons:  reasons,
        stream_endpoint:      '/api/v1/stream/start',
        recommended_params:   canDirectPlay ? null : {
          codec:      recommendedCodec,
          resolution: recommendedResolution,
        },
      },
    }
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
