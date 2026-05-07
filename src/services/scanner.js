import { readdir } from 'fs/promises'
import { join, extname, basename, dirname } from 'path'
import { parseNfo } from './nfoParser.js'
import { fetchMovieMetadata, fetchSeriesMetadata } from './tmdb.js'
import { getSettings } from './settingsCache.js'
import { probeFile } from './probe.js'
import { callHook } from './pluginLoader.js'

const VIDEO_EXTENSIONS = new Set(['.mkv', '.mp4', '.avi', '.mov', '.wmv', '.m4v', '.ts', '.flv'])

export async function scanLibrary(db, library, log) {
  await db.query('UPDATE libraries SET scan_status=$1 WHERE id=$2', ['scanning', library.id])

  const settings = await getSettings(db)
  const tmdbOpts = {
    apiKey: settings['tmdb.api_key'] || process.env.TMDB_API_KEY,
    language: settings['tmdb.language'] ?? 'en',
    enabled: settings['tmdb.enabled'] !== false,
    nfoPriority: settings['metadata.nfo_priority'] !== false,
  }

  try {
    let itemCount = 0
    for (const rootPath of library.paths) {
      if (library.type === 'movies') itemCount += await scanMovies(db, library, rootPath, tmdbOpts, log)
      else if (library.type === 'tv') itemCount += await scanTv(db, library, rootPath, tmdbOpts, log)
    }
    await db.query(
      'UPDATE libraries SET scan_status=$1, last_scanned_at=now() WHERE id=$2',
      ['idle', library.id]
    )
    // Let plugins react to a completed scan (e.g. send notifications, trigger post-processing)
    callHook('scan.complete', { library, itemCount }, log).catch(() => {})
  } catch (err) {
    await db.query('UPDATE libraries SET scan_status=$1 WHERE id=$2', ['error', library.id])
    throw err
  }
}

async function scanMovies(db, library, rootPath, tmdbOpts, log) {
  const entries = await readdir(rootPath, { withFileTypes: true })
  let count = 0

  for (const entry of entries) {
    const fullPath = join(rootPath, entry.name)

    if (entry.isDirectory()) {
      const files = await readdir(fullPath)
      const videoFile = files.find(f => VIDEO_EXTENSIONS.has(extname(f).toLowerCase()))
      if (!videoFile) continue
      const filePath = join(fullPath, videoFile)
      const nfoPath = files.find(f => f.endsWith('.nfo')) ? join(fullPath, files.find(f => f.endsWith('.nfo'))) : null
      if (await upsertMovie(db, library, filePath, nfoPath, tmdbOpts, log)) count++
    } else if (VIDEO_EXTENSIONS.has(extname(entry.name).toLowerCase())) {
      if (await upsertMovie(db, library, fullPath, null, tmdbOpts, log)) count++
    }
  }
  return count
}

// Returns true if a new item was inserted.
async function upsertMovie(db, library, filePath, nfoPath, tmdbOpts, log) {
  const existing = await db.query('SELECT id FROM media_items WHERE file_path=$1', [filePath])
  if (existing.rows.length) return false

  const nfo = nfoPath ? await parseNfo(nfoPath) : {}
  const title = nfo.title ?? guessTitle(filePath)
  const year = nfo.year ?? guessYear(filePath)

  const [tmdbMeta, fileInfo] = await Promise.all([
    (tmdbOpts.enabled && tmdbOpts.apiKey && !nfo.skipTmdb)
      ? fetchMovieMetadata(title, year, tmdbOpts).catch(() => ({}))
      : {},
    probeFile(db, filePath).catch(() => null),
  ])

  // Plugin metadata hook: each plugin can return a partial metadata object.
  // Results are merged in order, after TMDB and NFO, so plugins have final say.
  const pluginResults = await callHook('metadata.movie', { title, year, tmdbMeta, nfo }, log)
  let merged = tmdbOpts.nfoPriority ? { ...tmdbMeta, ...nfo } : { ...nfo, ...tmdbMeta }
  for (const result of pluginResults) merged = { ...merged, ...result }

  const { rows } = await db.query(`
    INSERT INTO media_items(
      library_id, type, title, sort_title, year, tmdb_id, imdb_id,
      plot, tagline, genres, poster_url, backdrop_url, rating,
      file_path, nfo_path, metadata,
      duration_secs, video_codec, audio_codec, container, file_size, width, height, bitrate_kbps
    )
    VALUES($1,'movie',$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23)
    ON CONFLICT DO NOTHING
    RETURNING id, title, year, tmdb_id
  `, [
    library.id, merged.title ?? title, merged.sort_title ?? null, merged.year ?? year,
    merged.tmdb_id ?? null, merged.imdb_id ?? null, merged.plot ?? null,
    merged.tagline ?? null, merged.genres ?? null, merged.poster_url ?? null,
    merged.backdrop_url ?? null, merged.rating ?? null, filePath, nfoPath, JSON.stringify(merged),
    fileInfo?.duration_secs ?? null, fileInfo?.video?.codec ?? null,
    fileInfo?.audio?.codec ?? null, fileInfo?.container ?? null,
    fileInfo?.file_size ?? null, fileInfo?.video?.width ?? null,
    fileInfo?.video?.height ?? null, fileInfo?.bitrate_kbps ?? null,
  ])

  if (rows[0]) {
    // Fire-and-forget: notify plugins a new item was added
    callHook('media.added', { type: 'movie', ...rows[0] }, log).catch(() => {})
  }
  return !!rows[0]
}

async function scanTv(db, library, rootPath, tmdbOpts, log) {
  const seriesDirs = await readdir(rootPath, { withFileTypes: true })
  let count = 0

  for (const seriesEntry of seriesDirs) {
    if (!seriesEntry.isDirectory()) continue
    const seriesPath = join(rootPath, seriesEntry.name)

    const files = await readdir(seriesPath)
    const nfoPath = files.find(f => f === 'tvshow.nfo') ? join(seriesPath, 'tvshow.nfo') : null
    const nfo = nfoPath ? await parseNfo(nfoPath) : {}
    const title = nfo.title ?? seriesEntry.name

    let meta = {}
    if (tmdbOpts.enabled && tmdbOpts.apiKey) {
      meta = await fetchSeriesMetadata(title, tmdbOpts).catch(() => ({}))
    }

    const pluginResults = await callHook('metadata.series', { title, tmdbMeta: meta, nfo }, log)
    let merged = tmdbOpts.nfoPriority ? { ...meta, ...nfo } : { ...nfo, ...meta }
    for (const result of pluginResults) merged = { ...merged, ...result }

    const { rows } = await db.query(`
      INSERT INTO media_items(library_id, type, title, sort_title, year, tmdb_id, imdb_id, plot, genres, poster_url, backdrop_url, rating, nfo_path, metadata)
      VALUES($1,'series',$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
      ON CONFLICT (file_path) DO NOTHING
      RETURNING id, title, year, tmdb_id
    `, [
      library.id, merged.title ?? title, merged.sort_title ?? null, merged.year ?? null,
      merged.tmdb_id ?? null, merged.imdb_id ?? null, merged.plot ?? null,
      merged.genres ?? null, merged.poster_url ?? null, merged.backdrop_url ?? null,
      merged.rating ?? null, nfoPath, JSON.stringify(merged)
    ])

    const seriesId = rows[0]?.id
    if (!seriesId) continue
    if (rows[0]) callHook('media.added', { type: 'series', ...rows[0] }, log).catch(() => {})
    count++

    const seasonDirs = (await readdir(seriesPath, { withFileTypes: true })).filter(e => e.isDirectory())
    for (const seasonEntry of seasonDirs) {
      const seasonMatch = seasonEntry.name.match(/season\s*(\d+)/i)
      const seasonNumber = seasonMatch ? parseInt(seasonMatch[1]) : 0
      const seasonPath = join(seriesPath, seasonEntry.name)
      const episodeFiles = await readdir(seasonPath)

      for (const epFile of episodeFiles) {
        if (!VIDEO_EXTENSIONS.has(extname(epFile).toLowerCase())) continue
        const epMatch = epFile.match(/[Ss](\d{1,2})[Ee](\d{1,3})/)
        const episodeNumber = epMatch ? parseInt(epMatch[2]) : 0
        const filePath = join(seasonPath, epFile)
        const epNfoFile = epFile.replace(extname(epFile), '.nfo')
        const epNfoPath = episodeFiles.includes(epNfoFile) ? join(seasonPath, epNfoFile) : null
        const epNfo = epNfoPath ? await parseNfo(epNfoPath) : {}
        const fileInfo = await probeFile(db, filePath).catch(() => null)

        await db.query(`
          INSERT INTO episodes(
            series_id, season_number, episode_number, title, plot, file_path, nfo_path,
            duration_secs, video_codec, audio_codec, container, file_size, width, height, bitrate_kbps
          )
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
          ON CONFLICT DO NOTHING
        `, [
          seriesId, seasonNumber, episodeNumber,
          epNfo.title ?? null, epNfo.plot ?? null, filePath, epNfoPath,
          fileInfo?.duration_secs ?? null, fileInfo?.video?.codec ?? null,
          fileInfo?.audio?.codec ?? null, fileInfo?.container ?? null,
          fileInfo?.file_size ?? null, fileInfo?.video?.width ?? null,
          fileInfo?.video?.height ?? null, fileInfo?.bitrate_kbps ?? null,
        ])
      }
    }
  }
  return count
}

function guessTitle(filePath) {
  return basename(dirname(filePath)) || basename(filePath, extname(filePath))
}

function guessYear(filePath) {
  const match = filePath.match(/\((\d{4})\)/)
  return match ? parseInt(match[1]) : null
}
