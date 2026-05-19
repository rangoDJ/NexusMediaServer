import { readdir, stat } from 'fs/promises'
import { join, extname, basename, dirname } from 'path'

/** Fast recursive video-file count for progress calculation. */
async function countVideoFiles(libraryType, rootPath, log) {
  try {
    const entries = await readdir(rootPath, { withFileTypes: true })
    if (libraryType === 'movies') {
      let count = 0
      for (const e of entries) {
        if (e.isDirectory()) {
          try {
            const sub = await readdir(join(rootPath, e.name))
            if (sub.some(f => VIDEO_EXTENSIONS.has(extname(f).toLowerCase()))) count++
          } catch { /* skip unreadable dirs */ }
        } else if (VIDEO_EXTENSIONS.has(extname(e.name).toLowerCase())) {
          count++
        }
      }
      return count
    } else {
      // TV: count episode files in series/season dirs
      let count = 0
      for (const seriesEntry of entries.filter(e => e.isDirectory())) {
        try {
          const seriesPath = join(rootPath, seriesEntry.name)
          const seasonDirs = (await readdir(seriesPath, { withFileTypes: true })).filter(e => e.isDirectory())
          for (const seasonEntry of seasonDirs) {
            try {
              const files = await readdir(join(seriesPath, seasonEntry.name))
              count += files.filter(f => VIDEO_EXTENSIONS.has(extname(f).toLowerCase())).length
            } catch { /* skip */ }
          }
        } catch { /* skip */ }
      }
      return count
    }
  } catch (err) {
    log.warn(`[scan] countVideoFiles failed for "${rootPath}": ${err.message}`)
    return 0
  }
}
import { parseNfo } from './nfoParser.js'
import { fetchMovieMetadata, fetchSeriesMetadata } from './tmdb.js'
import { getSettings } from './settingsCache.js'
import { probeFile } from './probe.js'
import { callHook } from './pluginLoader.js'

const VIDEO_EXTENSIONS = new Set(['.mkv', '.mp4', '.avi', '.mov', '.wmv', '.m4v', '.ts', '.flv'])

// Local artwork filenames the scanner looks for alongside the media file.
// Match Jellyfin / Plex / Kodi conventions. First match in each array wins.
const POSTER_FILENAMES   = ['poster.jpg', 'poster.png', 'folder.jpg', 'folder.png',
                            'cover.jpg', 'cover.png', 'movie.jpg', 'show.jpg']
const BACKDROP_FILENAMES = ['fanart.jpg', 'fanart.png', 'backdrop.jpg', 'backdrop.png',
                            'background.jpg', 'background.png']

/** Find the first artwork file from `candidates` that exists in `files`. */
function pickArtwork(files, candidates) {
  const lower = new Map(files.map(f => [f.toLowerCase(), f]))
  for (const cand of candidates) {
    const hit = lower.get(cand)
    if (hit) return hit
  }
  return null
}

/**
 * @param {import('pg').Pool}                             db
 * @param {object}                                        library
 * @param {import('fastify').FastifyBaseLogger}           log
 * @param {import('./scanBroadcaster.js').ScanBroadcaster|null} [broadcaster]
 */
export async function scanLibrary(db, library, log, broadcaster = null) {
  log.info(`[scan] Starting library "${library.name}" (id=${library.id}, type=${library.type})`)
  log.info(`[scan] Paths: ${library.paths.join(', ')}`)

  const emit = (phase, progress, currentItem = null) => {
    broadcaster?.emitProgress(library.id, library.name, phase, progress, currentItem)
    // Also persist to DB so REST-polling clients see it
    db.query(
      'UPDATE libraries SET scan_status=$1, scan_progress=$2, scan_phase=$3, scan_current=$4 WHERE id=$5',
      ['scanning', progress, phase, currentItem, library.id]
    ).catch(() => {})
  }

  await db.query(
    'UPDATE libraries SET scan_status=$1, scan_progress=$2, scan_phase=$3, scan_current=$4 WHERE id=$5',
    ['scanning', 0, 'Starting', null, library.id]
  )
  emit('Discovering files', 0)

  const settings = await getSettings(db)
  const tmdbOpts = {
    apiKey:      settings['tmdb.api_key'] || process.env.TMDB_API_KEY,
    language:    settings['tmdb.language'] ?? 'en',
    enabled:     settings['tmdb.enabled'] !== false,
    nfoPriority: settings['metadata.nfo_priority'] !== false,
  }

  log.info(`[scan] TMDB enabled=${tmdbOpts.enabled}, hasKey=${!!tmdbOpts.apiKey}, language=${tmdbOpts.language}`)

  try {
    // Quick pre-count so per-item progress is accurate
    let totalFiles = 0
    for (const rootPath of library.paths) {
      totalFiles += await countVideoFiles(library.type, rootPath, log)
    }
    log.info(`[scan] Pre-count: ${totalFiles} video file(s) found across ${library.paths.length} path(s)`)
    emit('Discovering files', 5)

    // Progress tracker shared across all paths
    let processedFiles = 0
    const onItem = (filename) => {
      processedFiles++
      const pct = totalFiles > 0 ? Math.round(5 + (processedFiles / totalFiles) * 80) : 50
      emit('Importing', pct, basename(filename))
    }

    let itemsAdded = []

    for (const rootPath of library.paths) {
      log.info(`[scan] → Scanning path: ${rootPath}`)
      let result
      if (library.type === 'movies') {
        result = await scanMovies(db, library, rootPath, tmdbOpts, log, onItem)
      } else if (library.type === 'series' || library.type === 'tv') {
        result = await scanTv(db, library, rootPath, tmdbOpts, log, onItem)
      } else {
        log.warn(`[scan] Unknown library type "${library.type}" — skipping ${rootPath}`)
        continue
      }
      itemsAdded = itemsAdded.concat(result.itemsAdded)
    }

    const itemCount = itemsAdded.length
    emit('Finishing', 95)
    log.info(`[scan] ✓ Library "${library.name}" complete — ${itemCount} new item(s) added`)

    await db.query(
      'UPDATE libraries SET scan_status=$1, last_scanned_at=now(), scan_progress=100, scan_phase=NULL, scan_current=NULL WHERE id=$2',
      ['idle', library.id]
    )

    callHook('scan.complete', { library, itemCount }, log).catch(err => log.warn({ err }, '[scan] scan.complete hook failed'))
    broadcaster?.emitScanComplete(library.id, library.name, itemsAdded)
  } catch (err) {
    log.error({ err }, `[scan] ✗ Library "${library.name}" failed: ${err.message}`)
    await db.query(
      'UPDATE libraries SET scan_status=$1, scan_progress=NULL, scan_phase=NULL, scan_current=NULL WHERE id=$2',
      ['error', library.id]
    )
    broadcaster?.emitScanError(library.id, library.name, err.message)
    throw err
  }
}

async function scanMovies(db, library, rootPath, tmdbOpts, log, onItem = null) {
  let entries
  try {
    entries = await readdir(rootPath, { withFileTypes: true })
  } catch (err) {
    log.error(`[scan] Cannot read directory "${rootPath}": ${err.message}`)
    throw err
  }

  log.info(`[scan] Found ${entries.length} entries in ${rootPath}`)
  const itemsAdded = []

  for (const entry of entries) {
    const fullPath = join(rootPath, entry.name)

    if (entry.isDirectory()) {
      let files
      try {
        files = await readdir(fullPath)
      } catch (err) {
        log.warn(`[scan] Cannot read subdirectory "${fullPath}": ${err.message} — skipping`)
        continue
      }

      const videoFile = files.find(f => VIDEO_EXTENSIONS.has(extname(f).toLowerCase()))
      if (!videoFile) {
        log.debug(`[scan] No video file in "${entry.name}" — skipping`)
        continue
      }

      const filePath = join(fullPath, videoFile)
      const nfoFile  = files.find(f => f.endsWith('.nfo'))
      const nfoPath  = nfoFile ? join(fullPath, nfoFile) : null

      // Local artwork — poster.jpg, fanart.jpg etc. alongside the video file.
      // Stored as absolute paths in metadata so the API artwork route can serve them.
      const posterFile   = pickArtwork(files, POSTER_FILENAMES)
      const backdropFile = pickArtwork(files, BACKDROP_FILENAMES)
      const localArtwork = {
        poster_path:   posterFile   ? join(fullPath, posterFile)   : null,
        backdrop_path: backdropFile ? join(fullPath, backdropFile) : null,
      }

      log.info(`[scan] Processing movie dir: ${entry.name} → ${videoFile}${posterFile ? ` (+poster: ${posterFile})` : ''}`)
      onItem?.(filePath)
      const added = await upsertMovie(db, library, filePath, nfoPath, tmdbOpts, log, localArtwork)
      if (added) itemsAdded.push(added)

    } else if (VIDEO_EXTENSIONS.has(extname(entry.name).toLowerCase())) {
      log.info(`[scan] Processing movie file: ${entry.name}`)
      onItem?.(fullPath)
      const added = await upsertMovie(db, library, fullPath, null, tmdbOpts, log, { poster_path: null, backdrop_path: null })
      if (added) itemsAdded.push(added)

    } else {
      log.debug(`[scan] Skipping non-video entry: ${entry.name}`)
    }
  }

  log.info(`[scan] Movies path done — ${itemsAdded.length} new item(s) from ${rootPath}`)
  return { count: itemsAdded.length, itemsAdded }
}

async function upsertMovie(db, library, filePath, nfoPath, tmdbOpts, log, localArtwork = { poster_path: null, backdrop_path: null }) {
  // Skip when the file is already in the DB. We use a separate "refresh
  // metadata" task to update existing items — the periodic/event-driven scan
  // must NEVER delete and re-create rows, because that breaks foreign keys
  // (watch_progress, play_sessions) and triggers the auto-advance bug where
  // the player can't find the next episode after re-scan.
  const existing = await db.query(
    'SELECT id, file_size FROM media_items WHERE file_path=$1',
    [filePath]
  )
  if (existing.rows.length) {
    // If the on-disk file size changed, just UPDATE the file metadata
    // in-place via probe — keep the same media_items.id.
    try {
      const st = await stat(filePath)
      const dbSize = existing.rows[0].file_size != null ? Number(existing.rows[0].file_size) : null
      if (dbSize != null && st.size !== dbSize) {
        log.info(`[scan] File size changed (${dbSize} → ${st.size}) — re-probing in place: ${basename(filePath)}`)
        const fi = await probeFile(db, filePath).catch(() => null)
        if (fi) {
          await db.query(`
            UPDATE media_items SET
              duration_secs=$2, video_codec=$3, audio_codec=$4, container=$5,
              file_size=$6, width=$7, height=$8, bitrate_kbps=$9
            WHERE id=$1
          `, [
            existing.rows[0].id,
            fi.duration_secs ?? null, fi.video?.codec ?? null,
            fi.audio?.codec ?? null, fi.container ?? null,
            fi.file_size ?? null, fi.video?.width ?? null,
            fi.video?.height ?? null, fi.bitrate_kbps ?? null,
          ])
        }
      }
    } catch { /* stat failed → just keep the existing row */ }
    log.debug(`[scan] Already in DB, skipping: ${basename(filePath)}`)
    return false
  }

  const nfo   = nfoPath ? await parseNfo(nfoPath).catch(e => { log.warn(`[scan] NFO parse failed (${nfoPath}): ${e.message}`); return {} }) : {}
  const title = nfo.title ?? guessTitle(filePath)
  const year  = nfo.year  ?? guessYear(filePath)

  log.info(`[scan] New movie — title="${title}" year=${year ?? 'unknown'} file=${basename(filePath)}`)

  if (nfoPath) log.debug(`[scan] NFO: ${nfoPath} → title="${nfo.title ?? '(none)'}"`)

  // TMDB
  let tmdbMeta = {}
  if (tmdbOpts.enabled && tmdbOpts.apiKey && !nfo.skipTmdb) {
    log.info(`[scan] Fetching TMDB metadata for "${title}" (${year ?? '?'})`)
    try {
      tmdbMeta = await fetchMovieMetadata(title, year, tmdbOpts)
      if (tmdbMeta.tmdb_id) {
        log.info(`[scan] TMDB match: "${tmdbMeta.title}" (id=${tmdbMeta.tmdb_id})`)
      } else {
        log.warn(`[scan] No TMDB match found for "${title}"`)
      }
    } catch (err) {
      log.warn(`[scan] TMDB fetch failed for "${title}": ${err.message}`)
    }
  } else if (!tmdbOpts.apiKey) {
    log.debug(`[scan] Skipping TMDB — no API key configured`)
  }

  // Probe
  log.info(`[scan] Probing file: ${basename(filePath)}`)
  let fileInfo = null
  try {
    fileInfo = await probeFile(db, filePath)
    if (fileInfo) {
      log.info(`[scan] Probe result: ${fileInfo.video?.codec ?? '?'} ${fileInfo.video?.width ?? '?'}×${fileInfo.video?.height ?? '?'} / ${fileInfo.audio?.codec ?? '?'} / ${Math.round((fileInfo.duration_secs ?? 0) / 60)}min`)
    } else {
      log.warn(`[scan] Probe returned null for ${basename(filePath)} — no transcoder available?`)
    }
  } catch (err) {
    log.warn(`[scan] Probe failed for ${basename(filePath)}: ${err.message}`)
  }

  const pluginResults = await callHook('metadata.movie', { title, year, tmdbMeta, nfo }, log)
  let merged = tmdbOpts.nfoPriority ? { ...tmdbMeta, ...nfo } : { ...nfo, ...tmdbMeta }
  for (const result of pluginResults) merged = { ...merged, ...result }
  // Persist embedded subtitle stream info from probe so the player can list
  // tracks without re-probing every playback.
  if (fileInfo?.subtitle_streams) merged.subtitle_streams = fileInfo.subtitle_streams

  // Stash local artwork paths in metadata. If TMDB had no poster, the API
  // /media list / GET routes will rewrite poster_url to a local-serving URL.
  if (localArtwork.poster_path)   merged.local_poster_path   = localArtwork.poster_path
  if (localArtwork.backdrop_path) merged.local_backdrop_path = localArtwork.backdrop_path

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
    log.info(`[scan] ✓ Inserted movie "${rows[0].title}" (${rows[0].year ?? '?'}) tmdb=${rows[0].tmdb_id ?? 'none'}`)
    callHook('media.added', { type: 'movie', ...rows[0] }, log).catch(err => log.warn({ err }, '[scan] media.added hook failed'))
    return { id: rows[0].id, title: rows[0].title, type: 'movie' }
  } else {
    log.warn(`[scan] Insert returned no row for "${title}" — possible conflict`)
    return null
  }
}

async function scanTv(db, library, rootPath, tmdbOpts, log, onItem = null) {
  let seriesDirs
  try {
    seriesDirs = await readdir(rootPath, { withFileTypes: true })
  } catch (err) {
    log.error(`[scan] Cannot read TV directory "${rootPath}": ${err.message}`)
    throw err
  }

  const seriesFolders = seriesDirs.filter(e => e.isDirectory())
  log.info(`[scan] Found ${seriesFolders.length} series folder(s) in ${rootPath}`)
  const itemsAdded = []

  for (const seriesEntry of seriesFolders) {
    const seriesPath = join(rootPath, seriesEntry.name)
    log.info(`[scan] Processing series: ${seriesEntry.name}`)

    let files
    try {
      files = await readdir(seriesPath)
    } catch (err) {
      log.warn(`[scan] Cannot read series dir "${seriesPath}": ${err.message} — skipping`)
      continue
    }

    const nfoFile = files.find(f => f === 'tvshow.nfo')
    const nfoPath = nfoFile ? join(seriesPath, nfoFile) : null
    const folderTitle = seriesEntry.name

    // Find an existing series row using EVERY signal we have, before going to
    // TMDB or considering this a new series. Matching only by folder name was
    // unsafe — a series whose DB title came from NFO/TMDB would look like a
    // new series, and a TMDB miss on re-scan could spawn a duplicate empty
    // row with no episodes (orphaning the real episodes from the user's view).
    let existing = await db.query(
      `SELECT id, tmdb_id FROM media_items
       WHERE library_id=$1 AND type='series'
         AND (title=$2 OR sort_title=$2 OR nfo_path=$3)
       LIMIT 1`,
      [library.id, folderTitle, nfoPath]
    )
    let seriesId = existing.rows[0]?.id
    let nfo = {}
    let meta = {}
    let merged = {}

    if (seriesId) {
      log.debug(`[scan] Series "${folderTitle}" already in DB (id=${seriesId}) — scanning episodes only`)
    } else {
      // No fast match — parse NFO + try TMDB before deciding it's truly new
      nfo = nfoPath ? await parseNfo(nfoPath).catch(e => { log.warn(`[scan] NFO parse failed: ${e.message}`); return {} }) : {}
      const title = nfo.title ?? folderTitle

      if (tmdbOpts.enabled && tmdbOpts.apiKey) {
        log.info(`[scan] Fetching TMDB series metadata for "${title}"`)
        try {
          meta = await fetchSeriesMetadata(title, tmdbOpts)
          if (meta.tmdb_id) {
            log.info(`[scan] TMDB match: "${meta.title}" (id=${meta.tmdb_id})`)
          } else {
            log.warn(`[scan] No TMDB match for series "${title}"`)
          }
        } catch (err) {
          log.warn(`[scan] TMDB fetch failed for series "${title}": ${err.message}`)
        }
      }

      const pluginResults = await callHook('metadata.series', { title, tmdbMeta: meta, nfo }, log)
      merged = tmdbOpts.nfoPriority ? { ...meta, ...nfo } : { ...nfo, ...meta }
      for (const result of pluginResults) merged = { ...merged, ...result }

      // Local series artwork — poster.jpg / fanart.jpg in the series folder
      const seriesPoster   = pickArtwork(files, POSTER_FILENAMES)
      const seriesBackdrop = pickArtwork(files, BACKDROP_FILENAMES)
      if (seriesPoster)   merged.local_poster_path   = join(seriesPath, seriesPoster)
      if (seriesBackdrop) merged.local_backdrop_path = join(seriesPath, seriesBackdrop)

      // Check by tmdb_id AND merged.title (TMDB may give a canonical title that
      // matches an existing row even if the folder name didn't)
      const candidateTitles = [merged.title, nfo.title].filter(Boolean)
      const byMeta = await db.query(
        `SELECT id FROM media_items
         WHERE library_id=$1 AND type='series'
           AND (tmdb_id=$2 OR title = ANY($3::text[]))
         LIMIT 1`,
        [library.id, merged.tmdb_id ?? null, candidateTitles]
      )
      seriesId = byMeta.rows[0]?.id

      if (seriesId) {
        log.info(`[scan] Matched existing series via TMDB/title — using id=${seriesId} (folder="${folderTitle}")`)
      }
    }

    const title = nfo.title ?? folderTitle

    if (!seriesId) {
      const { rows } = await db.query(`
        INSERT INTO media_items(library_id, type, title, sort_title, year, tmdb_id, imdb_id, plot, genres, poster_url, backdrop_url, rating, nfo_path, metadata)
        VALUES($1,'series',$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
        ON CONFLICT DO NOTHING
        RETURNING id, title, year, tmdb_id
      `, [
        library.id, merged.title ?? title, merged.sort_title ?? null, merged.year ?? null,
        merged.tmdb_id ?? null, merged.imdb_id ?? null, merged.plot ?? null,
        merged.genres ?? null, merged.poster_url ?? null, merged.backdrop_url ?? null,
        merged.rating ?? null, nfoPath, JSON.stringify(merged)
      ])
      seriesId = rows[0]?.id
      if (rows[0]) {
        log.info(`[scan] ✓ Inserted series "${rows[0].title}" tmdb=${rows[0].tmdb_id ?? 'none'}`)
        callHook('media.added', { type: 'series', ...rows[0] }, log).catch(err => log.warn({ err }, '[scan] media.added hook failed'))
        itemsAdded.push({ id: rows[0].id, title: rows[0].title, type: 'series' })
      } else {
        // INSERT hit a unique constraint — recover the existing id rather
        // than skipping all episodes (which is what would have happened
        // before this fallback).
        log.warn(`[scan] Series insert hit conflict for "${title}" — looking up existing`)
        const recover = await db.query(
          `SELECT id FROM media_items
           WHERE library_id=$1 AND type='series'
             AND (title=$2 OR (tmdb_id IS NOT NULL AND tmdb_id=$3))
           LIMIT 1`,
          [library.id, merged.title ?? title, merged.tmdb_id ?? null]
        )
        seriesId = recover.rows[0]?.id
        if (seriesId) log.info(`[scan] Recovered existing series id=${seriesId} for "${title}"`)
      }
    }

    if (!seriesId) {
      log.warn(`[scan] No seriesId for "${title}" — skipping episode scan`)
      continue
    }

    const seasonDirs = (await readdir(seriesPath, { withFileTypes: true })).filter(e => e.isDirectory())
    log.info(`[scan] "${title}": ${seasonDirs.length} season dir(s)`)

    for (const seasonEntry of seasonDirs) {
      const seasonMatch  = seasonEntry.name.match(/season\s*(\d+)/i)
      const seasonNumber = seasonMatch ? parseInt(seasonMatch[1]) : 0
      const seasonPath   = join(seriesPath, seasonEntry.name)

      let episodeFiles
      try {
        episodeFiles = await readdir(seasonPath)
      } catch (err) {
        log.warn(`[scan] Cannot read season dir "${seasonPath}": ${err.message} — skipping`)
        continue
      }

      const videoFiles = episodeFiles.filter(f => VIDEO_EXTENSIONS.has(extname(f).toLowerCase()))
      log.info(`[scan] "${title}" S${seasonNumber}: ${videoFiles.length} episode file(s)`)

      for (const epFile of videoFiles) {
        const epMatch       = epFile.match(/[Ss](\d{1,2})[Ee](\d{1,3})/)
        const episodeNumber = epMatch ? parseInt(epMatch[2]) : 0
        const filePath      = join(seasonPath, epFile)

        // Early-skip: if the file is already in the DB, leave it alone. If the
        // on-disk file size changed, UPDATE the existing row's metadata in
        // place — NEVER delete + re-insert (that orphans watch_progress and
        // breaks the next-episode lookup). The "refresh metadata" task is
        // the right place to re-fetch TMDB / NFO data for existing items.
        const existingEp = await db.query(
          'SELECT id, file_size FROM episodes WHERE file_path=$1',
          [filePath]
        )
        if (existingEp.rows.length) {
          try {
            const st = await stat(filePath)
            const dbSize = existingEp.rows[0].file_size != null
              ? Number(existingEp.rows[0].file_size) : null
            if (dbSize != null && st.size !== dbSize) {
              log.info(`[scan] Episode file size changed (${dbSize} → ${st.size}) — re-probing in place: ${epFile}`)
              const fi = await probeFile(db, filePath).catch(() => null)
              if (fi) {
                await db.query(`
                  UPDATE episodes SET
                    duration_secs=$2, video_codec=$3, audio_codec=$4, container=$5,
                    file_size=$6, width=$7, height=$8, bitrate_kbps=$9
                  WHERE id=$1
                `, [
                  existingEp.rows[0].id,
                  fi.duration_secs ?? null, fi.video?.codec ?? null,
                  fi.audio?.codec ?? null, fi.container ?? null,
                  fi.file_size ?? null, fi.video?.width ?? null,
                  fi.video?.height ?? null, fi.bitrate_kbps ?? null,
                ])
              }
            }
          } catch { /* stat fail → keep existing row */ }
          onItem?.(filePath)
          log.debug(`[scan] Episode already in DB, skipping: ${epFile}`)
          continue
        }

        const epNfoFile     = epFile.replace(extname(epFile), '.nfo')
        const epNfoPath     = episodeFiles.includes(epNfoFile) ? join(seasonPath, epNfoFile) : null
        const epNfo         = epNfoPath ? await parseNfo(epNfoPath).catch(() => ({})) : {}

        onItem?.(filePath)
        log.info(`[scan] Episode S${String(seasonNumber).padStart(2,'0')}E${String(episodeNumber).padStart(2,'0')} — ${epFile}`)

        let fileInfo = null
        try {
          fileInfo = await probeFile(db, filePath)
          if (!fileInfo) log.warn(`[scan] Probe returned null for ${epFile}`)
        } catch (err) {
          log.warn(`[scan] Probe failed for ${epFile}: ${err.message}`)
        }

        const epMetadata = {
          ...epNfo,
          ...(fileInfo?.subtitle_streams ? { subtitle_streams: fileInfo.subtitle_streams } : {}),
        }

        await db.query(`
          INSERT INTO episodes(
            series_id, season_number, episode_number, title, plot, file_path, nfo_path,
            duration_secs, video_codec, audio_codec, container, file_size, width, height, bitrate_kbps,
            metadata
          )
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
          ON CONFLICT DO NOTHING
        `, [
          seriesId, seasonNumber, episodeNumber,
          epNfo.title ?? null, epNfo.plot ?? null, filePath, epNfoPath,
          fileInfo?.duration_secs ?? null, fileInfo?.video?.codec ?? null,
          fileInfo?.audio?.codec ?? null, fileInfo?.container ?? null,
          fileInfo?.file_size ?? null, fileInfo?.video?.width ?? null,
          fileInfo?.video?.height ?? null, fileInfo?.bitrate_kbps ?? null,
          JSON.stringify(epMetadata),
        ])
      }
    }
  }

  log.info(`[scan] TV path done — ${itemsAdded.length} new series from ${rootPath}`)
  return { count: itemsAdded.length, itemsAdded }
}

function guessTitle(filePath) {
  return basename(dirname(filePath)) || basename(filePath, extname(filePath))
}

function guessYear(filePath) {
  const match = filePath.match(/\((\d{4})\)/)
  return match ? parseInt(match[1]) : null
}
