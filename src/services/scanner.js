import { readdir, stat } from 'fs/promises'
import { join, extname, basename, dirname } from 'path'
import { parseNfo } from './nfoParser.js'
import { fetchMovieMetadata, fetchSeriesMetadata, fetchMovieById, fetchSeriesById, findTmdbIdByExternalId } from './tmdb.js'
import { getSettings } from './settingsCache.js'
import { probeFile, invalidateProbeCache } from './probe.js'
import { callHook } from './pluginLoader.js'
import { logActivity } from './activityLog.js'
import { parseProviderTags } from './providerTags.js'

/**
 * Yield to the Node.js event loop so that pending HTTP request callbacks
 * can run between file-processing iterations. setImmediate fires in the
 * "check" phase — after I/O poll — which is what we need here.
 */
const yieldToEventLoop = () => new Promise(resolve => setImmediate(resolve))

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
 * Registry of in-flight scans, keyed by library id, so a scan can be
 * cancelled from outside the call that started it (e.g. a REST DELETE
 * handler cancelling a scan that a different request kicked off).
 * Mirrors Jellyfin's ability to cancel an in-progress library validation.
 * @type {Map<string, AbortController>}
 */
const activeScans = new Map()

/** True if a scan is currently registered as running for this library. */
export function isScanRunning(libraryId) {
  return activeScans.has(libraryId)
}

/**
 * Abort the in-progress scan for a library, if any.
 * @returns {boolean} true if a running scan was found and signalled to stop
 */
export function cancelScan(libraryId) {
  const controller = activeScans.get(libraryId)
  if (!controller) return false
  controller.abort()
  return true
}

/**
 * @param {import('pg').Pool}                             db
 * @param {object}                                        library
 * @param {import('fastify').FastifyBaseLogger}           log
 * @param {import('./scanBroadcaster.js').ScanBroadcaster|null} [broadcaster]
 * @param {object}                                         [opts]
 * @param {AbortSignal|null}                               [opts.signal]  external cancellation source (e.g. the task engine)
 * @param {import('./directoryWatcher.js').DirectoryWatcher|null} [opts.watcher] paused for the duration of the scan, mirroring Jellyfin's LibraryMonitor.Stop()/Start()
 */
export async function scanLibrary(db, library, log, broadcaster = null, { signal: externalSignal = null, watcher = null } = {}) {
  log.info(`[scan] Starting library "${library.name}" (id=${library.id}, type=${library.type})`)
  log.info(`[scan] Paths: ${library.paths.join(', ')}`)

  if (activeScans.has(library.id)) {
    log.warn(`[scan] "${library.name}" is already scanning — ignoring duplicate start`)
    return
  }

  const controller = new AbortController()
  externalSignal?.addEventListener('abort', () => controller.abort())
  activeScans.set(library.id, controller)
  const signal = controller.signal

  const emit = (phase, progress, currentItem = null) => {
    broadcaster?.emitProgress(library.id, library.name, phase, progress, currentItem)
    // Also persist to DB so REST-polling clients see it
    db.query(
      'UPDATE libraries SET scan_status=$1, scan_progress=$2, scan_phase=$3, scan_current=$4 WHERE id=$5',
      ['scanning', progress, phase, currentItem, library.id]
    ).catch(() => {})
  }

  await watcher?.pause(library.id)

  try {
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

    // Quick pre-count so per-item progress is accurate
    let totalFiles = 0
    for (const rootPath of library.paths) {
      totalFiles += await countVideoFiles(library.type, rootPath, log)
    }
    log.info(`[scan] Pre-count: ${totalFiles} video file(s) found across ${library.paths.length} path(s)`)
    emit('Discovering files', 5)

    // Progress tracker shared across all paths.
    // Throttled to emit at most once per second: the DB UPDATE and SSE broadcast
    // inside emit() are fire-and-forget, and firing one per file on a large
    // fully-scanned library (where files are skipped in <1 ms each) floods the
    // connection pool with hundreds of concurrent UPDATE queries and starves
    // normal HTTP request handlers.
    let processedFiles = 0
    let lastEmitMs = 0
    const onItem = (filename) => {
      processedFiles++
      const now = Date.now()
      if (now - lastEmitMs >= 1_000) {
        lastEmitMs = now
        const pct = totalFiles > 0 ? Math.round(5 + (processedFiles / totalFiles) * 80) : 50
        emit('Importing', pct, basename(filename))
      }
    }

    let itemsAdded = []
    const seenPaths = new Set()
    let cancelled = false

    for (const rootPath of library.paths) {
      if (signal.aborted) { cancelled = true; break }

      log.info(`[scan] → Scanning path: ${rootPath}`)
      let result
      if (library.type === 'movies') {
        result = await scanMovies(db, library, rootPath, tmdbOpts, log, onItem, signal)
      } else if (library.type === 'series' || library.type === 'tv') {
        result = await scanTv(db, library, rootPath, tmdbOpts, log, onItem, signal)
      } else {
        log.warn(`[scan] Unknown library type "${library.type}" — skipping ${rootPath}`)
        continue
      }
      itemsAdded = itemsAdded.concat(result.itemsAdded)
      for (const p of result.seenPaths) seenPaths.add(p)
      if (result.cancelled) { cancelled = true; break }
    }

    if (cancelled) {
      log.info(`[scan] ⊘ Library "${library.name}" cancelled`)
      await db.query(
        'UPDATE libraries SET scan_status=$1, scan_progress=NULL, scan_phase=NULL, scan_current=NULL WHERE id=$2',
        ['idle', library.id]
      )
      invalidateProbeCache()
      broadcaster?.emitScanCancelled(library.id, library.name)
      return
    }

    emit('Finishing', 95)

    // Reconciliation: remove DB rows whose backing file is confirmed gone.
    // Only ENOENT counts as "gone" — any other stat error (permission,
    // dropped network mount, etc.) leaves the row alone so a transient
    // filesystem blip can never mass-delete a library.
    const itemsRemoved = await reconcileRemovedItems(db, library, seenPaths, log)

    const itemCount = itemsAdded.length
    log.info(`[scan] ✓ Library "${library.name}" complete — ${itemCount} new item(s) added, ${itemsRemoved.length} removed`)

    await db.query(
      'UPDATE libraries SET scan_status=$1, last_scanned_at=now(), scan_progress=100, scan_phase=NULL, scan_current=NULL WHERE id=$2',
      ['idle', library.id]
    )

    // Drop the probe node cache so the next scan re-resolves a fresh node.
    invalidateProbeCache()
    callHook('scan.complete', { library, itemCount }, log).catch(err => log.warn({ err }, '[scan] scan.complete hook failed'))
    broadcaster?.emitScanComplete(library.id, library.name, itemsAdded, itemsRemoved)
    // Only worth a feed entry when something actually changed — a "0 changes"
    // line every 12h for every library would drown out everything else.
    if (itemCount > 0 || itemsRemoved.length > 0) {
      logActivity(db, log, {
        type: 'scan.complete',
        message: `"${library.name}" scan complete — ${itemCount} added, ${itemsRemoved.length} removed`,
        details: { library_id: library.id, added: itemCount, removed: itemsRemoved.length },
      })
    }
  } catch (err) {
    log.error({ err }, `[scan] ✗ Library "${library.name}" failed: ${err.message}`)
    invalidateProbeCache()
    await db.query(
      'UPDATE libraries SET scan_status=$1, scan_progress=NULL, scan_phase=NULL, scan_current=NULL WHERE id=$2',
      ['error', library.id]
    )
    broadcaster?.emitScanError(library.id, library.name, err.message)
    logActivity(db, log, {
      type: 'scan.error', severity: 'error',
      message: `"${library.name}" scan failed — ${err.message}`,
      details: { library_id: library.id },
    })
    throw err
  } finally {
    activeScans.delete(library.id)
    await watcher?.resume(library.id)
  }
}

/**
 * Diff the on-disk paths seen during this scan against what's still in the
 * DB for the library, and delete rows for files that are confirmed gone.
 * Deletes cascade via existing FKs to watch_progress, play_sessions,
 * favorites, and media_cast. Never touches files on disk.
 *
 * Deliberately does NOT delete now-empty series rows — a show with zero
 * episodes might just be newly added and not yet populated. That cleanup
 * stays a manual, explicit action (POST /libraries/cleanup-empty-series).
 */
async function reconcileRemovedItems(db, library, seenPaths, log) {
  const removed = []

  if (library.type === 'movies') {
    const { rows } = await db.query(
      'SELECT id, title, file_path FROM media_items WHERE library_id=$1',
      [library.id]
    )
    const candidates = rows.filter(r => r.file_path && !seenPaths.has(r.file_path))
    const toDelete = await filterConfirmedGone(candidates, log)
    if (toDelete.length) {
      await db.query('DELETE FROM media_items WHERE id = ANY($1::uuid[])', [toDelete.map(r => r.id)])
      for (const r of toDelete) {
        log.info(`[scan] ✗ Removed movie "${r.title}" — file no longer exists: ${r.file_path}`)
        removed.push({ id: r.id, title: r.title, type: 'movie' })
      }
    }
  } else if (library.type === 'series' || library.type === 'tv') {
    const { rows } = await db.query(`
      SELECT e.id, e.file_path, e.season_number, e.episode_number, m.title AS series_title
      FROM episodes e
      JOIN media_items m ON m.id = e.series_id
      WHERE m.library_id = $1
    `, [library.id])
    const candidates = rows.filter(r => r.file_path && !seenPaths.has(r.file_path))
    const toDelete = await filterConfirmedGone(candidates, log)
    if (toDelete.length) {
      await db.query('DELETE FROM episodes WHERE id = ANY($1::uuid[])', [toDelete.map(r => r.id)])
      for (const r of toDelete) {
        log.info(`[scan] ✗ Removed episode "${r.series_title}" S${String(r.season_number).padStart(2, '0')}E${String(r.episode_number).padStart(2, '0')} — file no longer exists: ${r.file_path}`)
        removed.push({ id: r.id, title: r.series_title, type: 'episode' })
      }
    }
  }

  return removed
}

/** Keep only candidates whose file is confirmed gone (ENOENT). Any other stat error is treated as "leave it alone". */
async function filterConfirmedGone(candidates, log) {
  const confirmed = []
  for (const c of candidates) {
    try {
      await stat(c.file_path)
      // Still exists — must have been missed this pass (unreadable dir, etc). Leave it.
    } catch (err) {
      if (err.code === 'ENOENT') {
        confirmed.push(c)
      } else {
        log.warn(`[scan] Could not verify "${c.file_path}" is gone (${err.code ?? err.message}) — leaving row in place`)
      }
    }
  }
  return confirmed
}

async function scanMovies(db, library, rootPath, tmdbOpts, log, onItem = null, signal = null) {
  let entries
  try {
    entries = await readdir(rootPath, { withFileTypes: true })
  } catch (err) {
    log.error(`[scan] Cannot read directory "${rootPath}": ${err.message}`)
    throw err
  }

  log.info(`[scan] Found ${entries.length} entries in ${rootPath}`)
  const itemsAdded = []
  const seenPaths = new Set()

  for (const entry of entries) {
    if (signal?.aborted) {
      log.info(`[scan] Cancelled while scanning "${rootPath}"`)
      return { count: itemsAdded.length, itemsAdded, seenPaths, cancelled: true }
    }

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
      seenPaths.add(filePath)
      // A single bad item (constraint/type error) must never kill the whole
      // library scan — log and continue to the next file.
      try {
        const added = await upsertMovie(db, library, filePath, nfoPath, tmdbOpts, log, localArtwork)
        if (added) itemsAdded.push(added)
      } catch (err) {
        log.warn({ err }, `[scan] Skipping movie "${filePath}" after upsert error: ${err.message}`)
      }
      await yieldToEventLoop()

    } else if (VIDEO_EXTENSIONS.has(extname(entry.name).toLowerCase())) {
      log.info(`[scan] Processing movie file: ${entry.name}`)
      onItem?.(fullPath)
      seenPaths.add(fullPath)
      try {
        const added = await upsertMovie(db, library, fullPath, null, tmdbOpts, log, { poster_path: null, backdrop_path: null })
        if (added) itemsAdded.push(added)
      } catch (err) {
        log.warn({ err }, `[scan] Skipping movie "${fullPath}" after upsert error: ${err.message}`)
      }
      await yieldToEventLoop()

    } else {
      log.debug(`[scan] Skipping non-video entry: ${entry.name}`)
    }
  }

  log.info(`[scan] Movies path done — ${itemsAdded.length} new item(s) from ${rootPath}`)
  return { count: itemsAdded.length, itemsAdded, seenPaths, cancelled: false }
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

  // TMDB — if the folder name carries an embedded id tag (Radarr's default
  // naming, e.g. "{tmdb-11679}"), look up that exact id directly instead of
  // a fuzzy title search. More accurate, and avoids the tag itself (still
  // present in the raw folder name even though guessTitle() stripped it for
  // display) polluting the search query.
  const folderTags = parseProviderTags(basename(dirname(filePath)))
  let tmdbMeta = {}
  if (tmdbOpts.enabled && tmdbOpts.apiKey && !nfo.skipTmdb) {
    try {
      if (folderTags.tmdbId) {
        log.info(`[scan] Folder name has embedded TMDB id ${folderTags.tmdbId} for "${title}" — fetching directly`)
        tmdbMeta = await fetchMovieById(folderTags.tmdbId, tmdbOpts)
      } else if (folderTags.tvdbId) {
        // No direct TMDB endpoint for a TVDB id — resolve it via TMDB's
        // cross-reference /find endpoint first, same intent as the tmdbId
        // branch above: an exact match beats a fuzzy title search.
        log.info(`[scan] Folder name has embedded TVDB id ${folderTags.tvdbId} for "${title}" — resolving via TMDB`)
        const resolvedId = await findTmdbIdByExternalId(folderTags.tvdbId, 'tvdb_id', { ...tmdbOpts, mediaType: 'movie' })
        if (resolvedId) tmdbMeta = await fetchMovieById(resolvedId, tmdbOpts)
      }
      if (!tmdbMeta.tmdb_id) {
        log.info(`[scan] Fetching TMDB metadata for "${title}" (${year ?? '?'})`)
        tmdbMeta = await fetchMovieMetadata(title, year, tmdbOpts)
      }
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

    // Upsert collection membership if TMDB returned belongs_to_collection
    if (tmdbMeta.collection) {
      try {
        const col = tmdbMeta.collection
        const { rows: colRows } = await db.query(`
          INSERT INTO collections(tmdb_id, name, poster_url, backdrop_url)
          VALUES($1, $2, $3, $4)
          ON CONFLICT (tmdb_id) DO UPDATE
            SET name=$2, poster_url=$3, backdrop_url=$4, updated_at=now()
          RETURNING id
        `, [col.tmdb_id, col.name, col.poster_url ?? null, col.backdrop_url ?? null])
        if (colRows[0]) {
          await db.query(
            'UPDATE media_items SET collection_id=$1 WHERE id=$2',
            [colRows[0].id, rows[0].id]
          )
          log.info(`[scan] ↳ Collection "${col.name}" (tmdb=${col.tmdb_id})`)
        }
      } catch (err) {
        log.warn(`[scan] Collection upsert failed for "${tmdbMeta.collection?.name}": ${err.message}`)
      }
    }

    callHook('media.added', { type: 'movie', ...rows[0] }, log).catch(err => log.warn({ err }, '[scan] media.added hook failed'))
    return { id: rows[0].id, title: rows[0].title, type: 'movie' }
  } else {
    log.warn(`[scan] Insert returned no row for "${title}" — possible conflict`)
    return null
  }
}

/**
 * If the episode's on-disk file size changed, re-probe and UPDATE the row in
 * place. Never deletes or re-inserts — that would orphan watch_progress rows.
 */
async function reprobeEpisodeIfChanged(db, existingRow, filePath, log) {
  try {
    const st    = await stat(filePath)
    const dbSize = existingRow.file_size != null ? Number(existingRow.file_size) : null
    if (dbSize == null || st.size === dbSize) return
    log.info(`[scan] Episode file size changed (${dbSize} → ${st.size}) — re-probing in place: ${basename(filePath)}`)
    const fi = await probeFile(db, filePath).catch(() => null)
    if (fi) {
      await db.query(`
        UPDATE episodes SET
          duration_secs=$2, video_codec=$3, audio_codec=$4, container=$5,
          file_size=$6, width=$7, height=$8, bitrate_kbps=$9
        WHERE id=$1
      `, [
        existingRow.id,
        fi.duration_secs ?? null, fi.video?.codec ?? null,
        fi.audio?.codec ?? null,  fi.container ?? null,
        fi.file_size ?? null,     fi.video?.width ?? null,
        fi.video?.height ?? null, fi.bitrate_kbps ?? null,
      ])
    }
  } catch { /* stat failed — keep existing row */ }
}

async function scanTv(db, library, rootPath, tmdbOpts, log, onItem = null, signal = null) {
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
  const seenPaths = new Set()

  for (const seriesEntry of seriesFolders) {
    if (signal?.aborted) {
      log.info(`[scan] Cancelled while scanning "${rootPath}"`)
      return { count: itemsAdded.length, itemsAdded, seenPaths, cancelled: true }
    }

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
    // Strip embedded provider-id tags (Radarr/Sonarr-style "{tmdb-1234}")
    // from the folder name before using it as a title anywhere — matching,
    // fallback title, and the final insert all derive from folderTitle.
    const folderTags   = parseProviderTags(seriesEntry.name)
    const folderTitle  = folderTags.cleanName || seriesEntry.name

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
        try {
          if (folderTags.tmdbId) {
            log.info(`[scan] Folder name has embedded TMDB id ${folderTags.tmdbId} for "${title}" — fetching directly`)
            meta = await fetchSeriesById(folderTags.tmdbId, tmdbOpts)
          } else if (folderTags.tvdbId) {
            // Sonarr's default naming tags TV shows with their TheTVDB id,
            // which TMDB has no direct lookup for — resolve via /find first.
            log.info(`[scan] Folder name has embedded TVDB id ${folderTags.tvdbId} for "${title}" — resolving via TMDB`)
            const resolvedId = await findTmdbIdByExternalId(folderTags.tvdbId, 'tvdb_id', { ...tmdbOpts, mediaType: 'tv' })
            if (resolvedId) meta = await fetchSeriesById(resolvedId, tmdbOpts)
          }
          if (!meta.tmdb_id) {
            log.info(`[scan] Fetching TMDB series metadata for "${title}"`)
            meta = await fetchSeriesMetadata(title, tmdbOpts)
          }
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

    // Pre-load ALL known episodes for this series in a single query, then look
    // them up by file_path from a Map inside the per-episode loop. Without this,
    // every episode file triggers an individual SELECT — 100 episodes = 100 round
    // trips. The Map approach collapses that to one query per series regardless
    // of episode count.
    const { rows: existingEps } = await db.query(
      'SELECT id, file_size, file_path FROM episodes WHERE series_id=$1',
      [seriesId]
    )
    const existingEpMap = new Map(existingEps.map(ep => [ep.file_path, ep]))

    for (const seasonEntry of seasonDirs) {
      const seasonNumber = parseSeasonNumber(seasonEntry.name)
      const seasonPath   = join(seriesPath, seasonEntry.name)

      let episodeFiles
      try {
        episodeFiles = await readdir(seasonPath)
      } catch (err) {
        log.warn(`[scan] Cannot read season dir "${seasonPath}": ${err.message} — skipping`)
        continue
      }

      const videoFiles = episodeFiles.filter(f => VIDEO_EXTENSIONS.has(extname(f).toLowerCase()))
      log.info(`[scan] "${title}" S${String(seasonNumber).padStart(2,'0')}: ${videoFiles.length} episode file(s)`)

      for (const epFile of videoFiles) {
        if (signal?.aborted) {
          log.info(`[scan] Cancelled while scanning "${seasonPath}"`)
          return { count: itemsAdded.length, itemsAdded, seenPaths, cancelled: true }
        }

        const epMatch       = epFile.match(/[Ss](\d{1,2})[Ee](\d{1,3})/)
        const episodeNumber = epMatch ? parseInt(epMatch[2]) : 0
        const filePath      = join(seasonPath, epFile)
        seenPaths.add(filePath)

        // Early-skip: if the file is already in the DB, leave it alone.
        // reprobeEpisodeIfChanged handles the "file replaced in place" case.
        const existingEpRow = existingEpMap.get(filePath)
        if (existingEpRow) {
          await reprobeEpisodeIfChanged(db, existingEpRow, filePath, log)
          onItem?.(filePath)
          log.debug(`[scan] Episode already in DB, skipping: ${epFile}`)
          // Yield so HTTP handlers aren't starved when hundreds of already-scanned
          // episodes are skipped in rapid succession (each iteration < 1 ms).
          await yieldToEventLoop()
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
        await yieldToEventLoop()
      }
    }

    // Flat layout: video files sitting directly in the series folder with no
    // season subdirectories. Season and episode numbers come entirely from the
    // filename (e.g. "Show.S02E05.mkv"). Also catches loose files (specials,
    // extras) sitting alongside season folders in a mixed layout.
    const rootVideoFiles = files.filter(f => VIDEO_EXTENSIONS.has(extname(f).toLowerCase()))
    if (rootVideoFiles.length > 0) {
      log.info(`[scan] "${title}": ${rootVideoFiles.length} file(s) in series root (flat/mixed layout)`)
      for (const epFile of rootVideoFiles) {
        if (signal?.aborted) {
          log.info(`[scan] Cancelled while scanning "${seriesPath}"`)
          return { count: itemsAdded.length, itemsAdded, seenPaths, cancelled: true }
        }

        const epMatch       = epFile.match(/[Ss](\d{1,2})[Ee](\d{1,3})/)
        const seasonNumber  = epMatch ? parseInt(epMatch[1]) : 1
        const episodeNumber = epMatch ? parseInt(epMatch[2]) : 0
        const filePath      = join(seriesPath, epFile)
        seenPaths.add(filePath)

        const existingEpRow = existingEpMap.get(filePath)
        if (existingEpRow) {
          await reprobeEpisodeIfChanged(db, existingEpRow, filePath, log)
          onItem?.(filePath)
          log.debug(`[scan] Episode already in DB, skipping: ${epFile}`)
          await yieldToEventLoop()
          continue
        }

        const epNfoFile = epFile.replace(extname(epFile), '.nfo')
        const epNfoPath = files.includes(epNfoFile) ? join(seriesPath, epNfoFile) : null
        const epNfo     = epNfoPath ? await parseNfo(epNfoPath).catch(() => ({})) : {}

        onItem?.(filePath)
        log.info(`[scan] Episode (flat) S${String(seasonNumber).padStart(2,'0')}E${String(episodeNumber).padStart(2,'0')} — ${epFile}`)

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

        // A single bad episode (constraint/type error) must never abort the
        // whole series scan — log and continue to the next episode.
        try {
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
            fileInfo?.audio?.codec ?? null,  fileInfo?.container ?? null,
            fileInfo?.file_size ?? null,     fileInfo?.video?.width ?? null,
            fileInfo?.video?.height ?? null, fileInfo?.bitrate_kbps ?? null,
            JSON.stringify(epMetadata),
          ])
        } catch (err) {
          log.warn({ err }, `[scan] Skipping episode "${filePath}" after insert error: ${err.message}`)
        }
        await yieldToEventLoop()
      }
    }
  }

  log.info(`[scan] TV path done — ${itemsAdded.length} new series from ${rootPath}`)
  return { count: itemsAdded.length, itemsAdded, seenPaths, cancelled: false }
}

function guessTitle(filePath) {
  const folderName = basename(dirname(filePath))
  const { cleanName } = parseProviderTags(folderName)
  return cleanName || basename(filePath, extname(filePath))
}

function guessYear(filePath) {
  const match = filePath.match(/\((\d{4})\)/)
  return match ? parseInt(match[1]) : null
}

/**
 * Parse a season number from a folder name. Handles the naming conventions
 * used by common media managers (Sonarr, Kodi, Plex, Jellyfin):
 *   "Season 1"  "Season01"  "season_2"   → 1, 1, 2
 *   "S01"  "S1"  "s02"                   → 1, 1, 2
 *   "1"  "01"                            → 1, 1
 * Returns 0 for anything that doesn't match (treated as "unknown season").
 */
function parseSeasonNumber(folderName) {
  // "Season 1", "Season01", "season_2", "Saison 1", "Staffel 1"
  let m = folderName.match(/(?:season|saison|staffel|serie)[_\s-]*(\d+)/i)
  if (m) return parseInt(m[1])
  // "S01", "S1", "S 01" (standalone — not part of an episode code like S01E01)
  m = folderName.match(/^s(\d{1,2})$/i)
  if (m) return parseInt(m[1])
  // Bare number: "1", "01"
  m = folderName.match(/^(\d{1,2})$/)
  if (m) return parseInt(m[1])
  return 0
}
