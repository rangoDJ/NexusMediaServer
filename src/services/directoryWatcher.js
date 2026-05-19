import chokidar from 'chokidar'
import { extname } from 'path'
import { scanLibrary } from './scanner.js'
import { getSettings } from './settingsCache.js'

const VIDEO_EXTENSIONS = new Set(['.mkv', '.mp4', '.avi', '.mov', '.wmv', '.m4v', '.ts', '.flv'])
const NFO_EXTENSIONS   = new Set(['.nfo'])

/**
 * Watches every library's directories and schedules a debounced scan when
 * media files appear / disappear / change. One watcher per library — files
 * are NOT scanned per-event; instead any qualifying event marks the library
 * dirty and a single `scanLibrary` runs after the debounce window settles.
 *
 * Polling vs native fs events:
 *   Docker bind mounts (especially NFS / SMB / network shares) frequently
 *   drop inotify events. Polling is slower but reliable. We default to
 *   polling = true with a generous interval; disable it via the
 *   `watcher.use_polling` setting if your filesystem supports inotify.
 */
export class DirectoryWatcher {
  /**
   * @param {import('pg').Pool}                                db
   * @param {import('fastify').FastifyBaseLogger}              log
   * @param {import('./scanBroadcaster.js').ScanBroadcaster|null} broadcaster
   */
  constructor(db, log, broadcaster = null) {
    this.db          = db
    this.log         = log
    this.broadcaster = broadcaster
    /** library_id → chokidar.FSWatcher */
    this.watchers    = new Map()
    /** library_id → setTimeout handle */
    this.timers      = new Map()
    /** library_id → row (cached so we can rescan without re-querying) */
    this.libraries   = new Map()
    /** debounce window (ms) before a dirty library triggers scanLibrary */
    this.debounceMs  = 30_000
    /** chokidar polling interval (ms) — must be high enough that recursive
     *  stat() loops don't peg disk + DB pool. 5s was way too aggressive on
     *  large libraries. 30s is sane for typical "drop a file" workflows. */
    this.pollIntervalMs = 30_000
    /** master enable flag */
    this.enabled     = true
  }

  /** Read settings and (re)build watchers for every library. */
  async start() {
    const settings = await getSettings(this.db).catch(() => ({}))
    this.enabled        = settings['watcher.enabled'] !== false           // default ON
    this.debounceMs     = (settings['watcher.debounce_secs']     ?? 30) * 1000
    this.pollIntervalMs = (settings['watcher.poll_interval_secs'] ?? 30) * 1000
    const usePolling    = settings['watcher.use_polling'] !== false      // default ON for Docker safety

    if (!this.enabled) {
      this.log.info('[watcher] disabled via settings — directory watching off')
      return
    }

    const { rows: libraries } = await this.db.query('SELECT * FROM libraries')
    for (const lib of libraries) {
      this.#addLibrary(lib, usePolling)
    }
    this.log.info(`[watcher] watching ${this.watchers.size} libraries (polling=${usePolling}, interval=${this.pollIntervalMs}ms, debounce=${this.debounceMs}ms)`)
  }

  /** Tear down every watcher. Awaitable so shutdown can wait for clean close. */
  async stop() {
    for (const timer of this.timers.values()) clearTimeout(timer)
    this.timers.clear()
    await Promise.all([...this.watchers.values()].map(w => w.close().catch(() => {})))
    this.watchers.clear()
    this.libraries.clear()
  }

  /** Call after a library row was inserted/updated. Rebuilds that library's watcher. */
  async refreshLibrary(libraryId) {
    if (!this.enabled) return
    const { rows } = await this.db.query('SELECT * FROM libraries WHERE id=$1', [libraryId])
    this.#removeLibrary(libraryId)
    if (rows[0]) {
      const settings = await getSettings(this.db).catch(() => ({}))
      const usePolling = settings['watcher.use_polling'] !== false
      this.#addLibrary(rows[0], usePolling)
    }
  }

  /** Call when a library row is deleted. */
  removeLibrary(libraryId) {
    this.#removeLibrary(libraryId)
  }

  // ─── internals ──────────────────────────────────────────────────────────

  #addLibrary(library, usePolling) {
    if (!library.paths?.length) return
    const watcher = chokidar.watch(library.paths, {
      ignoreInitial:   true,    // don't fire 'add' for every existing file at startup
      persistent:      true,
      usePolling,
      interval:        this.pollIntervalMs,
      binaryInterval:  this.pollIntervalMs,
      awaitWriteFinish: {
        stabilityThreshold: 5_000, // wait for the file to stop growing for 5s
        pollInterval:       1_000,
      },
      depth:           10,
    })

    const onEvent = (event, path) => {
      const ext = extname(path).toLowerCase()
      if (!VIDEO_EXTENSIONS.has(ext) && !NFO_EXTENSIONS.has(ext)) return
      this.log.debug(`[watcher] ${library.name}: ${event} ${path}`)
      this.#markDirty(library.id)
    }

    watcher
      .on('add',    p => onEvent('add', p))
      .on('change', p => onEvent('change', p))
      .on('unlink', p => onEvent('unlink', p))
      .on('error',  err => this.log.warn(`[watcher] ${library.name}: ${err.message}`))

    this.watchers.set(library.id, watcher)
    this.libraries.set(library.id, library)
    this.log.info(`[watcher] watching "${library.name}" → ${library.paths.join(', ')}`)
  }

  #removeLibrary(libraryId) {
    const w = this.watchers.get(libraryId)
    if (w) w.close().catch(() => {})
    const t = this.timers.get(libraryId)
    if (t) clearTimeout(t)
    this.watchers.delete(libraryId)
    this.timers.delete(libraryId)
    this.libraries.delete(libraryId)
  }

  /** Schedule a debounced scan. Multiple events within the window collapse into one scan. */
  #markDirty(libraryId) {
    const existing = this.timers.get(libraryId)
    if (existing) clearTimeout(existing)
    const timer = setTimeout(() => this.#triggerScan(libraryId), this.debounceMs)
    this.timers.set(libraryId, timer)
  }

  async #triggerScan(libraryId) {
    this.timers.delete(libraryId)
    const library = this.libraries.get(libraryId)
    if (!library) return

    // Skip if a scan is already running — chokidar events arriving during
    // a scan will re-mark the library dirty and another scan will fire.
    const { rows } = await this.db.query(
      'SELECT scan_status FROM libraries WHERE id=$1',
      [libraryId]
    )
    if (rows[0]?.scan_status === 'scanning') {
      this.log.info(`[watcher] "${library.name}" already scanning — deferring`)
      this.#markDirty(libraryId) // reschedule
      return
    }

    this.log.info(`[watcher] "${library.name}" — change detected, starting scan`)
    try {
      await scanLibrary(this.db, library, this.log, this.broadcaster)
    } catch (err) {
      this.log.error({ err }, `[watcher] scan failed for "${library.name}"`)
    }
  }
}
