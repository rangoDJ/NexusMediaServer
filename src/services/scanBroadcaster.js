/**
 * ScanBroadcaster — real-time scan event fan-out over Server-Sent Events.
 *
 * Clients connect to GET /api/v1/events and receive a stream of JSON events:
 *
 *   { type: 'connected' }
 *   { type: 'refresh.progress', libraryId, libraryName, phase, progress, currentItem }
 *   { type: 'library.changed',  libraryId, libraryName, itemsAdded }
 *   { type: 'scan.error',       libraryId, libraryName, errorMessage }
 *
 * Newly-connected clients immediately receive one refresh.progress message for
 * every scan that is currently in-flight, so they can render correct state.
 *
 * LibraryChanged events are debounced by 2 s (matching Jellyfin) to batch
 * rapid item additions into a single notification.
 */
export class ScanBroadcaster {
  /** @type {Set<function>} send callbacks — one per SSE connection */
  #clients = new Set()

  /** @type {Map<string, {phase,progress,currentItem,libraryName}>} live scan state */
  #currentScans = new Map()

  /** @type {Map<string, {timer, itemsAdded: Array}>} pending library.changed batches */
  #pendingChanges = new Map()

  // ── Client management ────────────────────────────────────────────────────────

  /**
   * Register an SSE send function.  The caller is responsible for removing it
   * when the connection closes.
   * @param {function} send — accepts a plain object; serialises to JSON internally
   */
  addClient(send) {
    this.#clients.add(send)
    // Catch up new client on any scans already in progress
    for (const [libraryId, state] of this.#currentScans) {
      this.#sendOne(send, {
        type:        'refresh.progress',
        libraryId,
        libraryName: state.libraryName,
        phase:       state.phase,
        progress:    state.progress,
        currentItem: state.currentItem,
      })
    }
  }

  removeClient(send) {
    this.#clients.delete(send)
  }

  get clientCount() { return this.#clients.size }

  // ── Scan lifecycle events ─────────────────────────────────────────────────────

  /**
   * Call this periodically during a scan (max once per second is fine).
   * Also updates the DB columns so polling clients are covered.
   */
  emitProgress(libraryId, libraryName, phase, progress, currentItem = null) {
    this.#currentScans.set(libraryId, { libraryName, phase, progress, currentItem })
    this.#broadcast({
      type: 'refresh.progress',
      libraryId,
      libraryName,
      phase,
      progress,
      currentItem,
    })
  }

  /**
   * Call when a scan finishes successfully.
   * @param {string}  libraryId
   * @param {string}  libraryName
   * @param {Array}   itemsAdded  — [{id, title, type}]
   */
  emitScanComplete(libraryId, libraryName, itemsAdded = []) {
    this.#currentScans.delete(libraryId)
    this.#queueLibraryChanged(libraryId, libraryName, itemsAdded)
  }

  /** Call when a scan fails. */
  emitScanError(libraryId, libraryName, errorMessage) {
    this.#currentScans.delete(libraryId)
    this.#broadcast({ type: 'scan.error', libraryId, libraryName, errorMessage })
  }

  // ── Private ──────────────────────────────────────────────────────────────────

  /** Batch library.changed notifications within a 2-second window (Jellyfin pattern). */
  #queueLibraryChanged(libraryId, libraryName, itemsAdded) {
    const existing = this.#pendingChanges.get(libraryId)
    if (existing) {
      existing.itemsAdded.push(...itemsAdded)
      // Reset the debounce window
      clearTimeout(existing.timer)
      existing.timer = setTimeout(() => this.#flushLibraryChanged(libraryId, libraryName), 2_000)
    } else {
      const timer = setTimeout(() => this.#flushLibraryChanged(libraryId, libraryName), 2_000)
      this.#pendingChanges.set(libraryId, { timer, itemsAdded: [...itemsAdded] })
    }
  }

  #flushLibraryChanged(libraryId, libraryName) {
    const pending = this.#pendingChanges.get(libraryId)
    if (!pending) return
    this.#pendingChanges.delete(libraryId)
    this.#broadcast({
      type:        'library.changed',
      libraryId,
      libraryName,
      itemsAdded:  pending.itemsAdded,
    })
  }

  #broadcast(message) {
    const dead = []
    for (const send of this.#clients) {
      if (!this.#sendOne(send, message)) dead.push(send)
    }
    dead.forEach(s => this.#clients.delete(s))
  }

  /** Returns false if the send failed (broken pipe etc.). */
  #sendOne(send, message) {
    try { send(message); return true }
    catch { return false }
  }
}
