/**
 * ScanBroadcaster — real-time scan event fan-out over Server-Sent Events.
 *
 * Clients connect to GET /api/v1/events and receive a stream of JSON events:
 *
 *   { type: 'connected' }
 *   { type: 'refresh.progress', libraryId, libraryName, phase, progress, currentItem }
 *   { type: 'library.changed',  libraryId, libraryName, itemsAdded, itemsRemoved }
 *   { type: 'scan.error',       libraryId, libraryName, errorMessage }
 *   { type: 'scan.cancelled',   libraryId, libraryName }
 *
 * Newly-connected clients immediately receive one refresh.progress message for
 * every scan that is currently in-flight, so they can render correct state.
 *
 * LibraryChanged events are debounced by 2 s (matching Jellyfin) to batch
 * rapid item additions into a single notification.
 *
 * Robustness: connections are capped (globally and per user) and each client
 * may supply an allowed-library set so events for libraries a restricted user
 * can't access are never delivered.
 */
export class ScanBroadcaster {
  /** @type {Set<{send: Function, userId: string|null, libraryFilter: Set<string>|null}>} */
  #clients = new Set()

  /** @type {Map<string, number>} userId → open connection count (for per-user caps) */
  #perUser = new Map()

  /** @type {Map<string, {phase,progress,currentItem,libraryName}>} live scan state */
  #currentScans = new Map()

  /** @type {Map<string, {timer, itemsAdded: Array}>} pending library.changed batches */
  #pendingChanges = new Map()

  // ── Client management ────────────────────────────────────────────────────────

  /**
   * Ask whether a new connection would be admitted under the given caps.
   * Call before hijacking the response so an over-cap request can be rejected
   * with a clean error instead of a leaked open socket.
   */
  canAddClient({ maxTotal = Infinity, maxPerUser = Infinity, userId = null } = {}) {
    if (this.#clients.size >= maxTotal) return false
    if (userId != null && (this.#perUser.get(userId) ?? 0) >= maxPerUser) return false
    return true
  }

  /**
   * Register an SSE send function.  The caller is responsible for removing it
   * when the connection closes via removeClient(send).
   * @param {function} send — accepts a plain object; serialises to JSON internally
   * @param {{userId?: string, libraryFilter?: Set<string>|null}} [opts] — optional
   *   per-client library scoping; events for libraries not in the set are skipped.
   */
  addClient(send, { userId = null, libraryFilter = null } = {}) {
    this.#clients.add({ send, userId, libraryFilter })
    if (userId != null) {
      this.#perUser.set(userId, (this.#perUser.get(userId) ?? 0) + 1)
    }
    // Catch up new client on any scans already in progress (only allowed ones)
    for (const [libraryId, state] of this.#currentScans) {
      if (libraryFilter === null || libraryFilter.has(libraryId)) {
        this.#sendEntry({ send, userId, libraryFilter }, {
          type:        'refresh.progress',
          libraryId,
          libraryName: state.libraryName,
          phase:       state.phase,
          progress:    state.progress,
          currentItem: state.currentItem,
        })
      }
    }
  }

  removeClient(send) {
    for (const entry of this.#clients) {
      if (entry.send === send) {
        this.#clients.delete(entry)
        if (entry.userId != null) {
          const n = (this.#perUser.get(entry.userId) ?? 1) - 1
          if (n <= 0) this.#perUser.delete(entry.userId)
          else this.#perUser.set(entry.userId, n)
        }
        break
      }
    }
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
   * @param {Array}   itemsAdded    — [{id, title, type}]
   * @param {Array}   [itemsRemoved] — [{id, title, type}]
   */
  emitScanComplete(libraryId, libraryName, itemsAdded = [], itemsRemoved = []) {
    this.#currentScans.delete(libraryId)
    this.#queueLibraryChanged(libraryId, libraryName, itemsAdded, itemsRemoved)
  }

  /** Call when a scan fails. */
  emitScanError(libraryId, libraryName, errorMessage) {
    this.#currentScans.delete(libraryId)
    this.#broadcast({ type: 'scan.error', libraryId, libraryName, errorMessage })
  }

  /** Call when a scan is cancelled (never reaches error or complete). */
  emitScanCancelled(libraryId, libraryName) {
    this.#currentScans.delete(libraryId)
    this.#pendingChanges.delete(libraryId)
    this.#broadcast({ type: 'scan.cancelled', libraryId, libraryName })
  }

  // ── Private ──────────────────────────────────────────────────────────────────

  /** Batch library.changed notifications within a 2-second window (Jellyfin pattern). */
  #queueLibraryChanged(libraryId, libraryName, itemsAdded, itemsRemoved = []) {
    const existing = this.#pendingChanges.get(libraryId)
    if (existing) {
      existing.itemsAdded.push(...itemsAdded)
      existing.itemsRemoved.push(...itemsRemoved)
      // Reset the debounce window
      clearTimeout(existing.timer)
      existing.timer = setTimeout(() => this.#flushLibraryChanged(libraryId, libraryName), 2_000)
    } else {
      const timer = setTimeout(() => this.#flushLibraryChanged(libraryId, libraryName), 2_000)
      this.#pendingChanges.set(libraryId, { timer, itemsAdded: [...itemsAdded], itemsRemoved: [...itemsRemoved] })
    }
  }

  #flushLibraryChanged(libraryId, libraryName) {
    const pending = this.#pendingChanges.get(libraryId)
    if (!pending) return
    this.#pendingChanges.delete(libraryId)
    this.#broadcast({
      type:          'library.changed',
      libraryId,
      libraryName,
      itemsAdded:    pending.itemsAdded,
      itemsRemoved:  pending.itemsRemoved,
    })
  }

  #broadcast(message) {
    const dead = []
    for (const entry of this.#clients) {
      if (!this.#sendEntry(entry, message)) dead.push(entry.send)
    }
    dead.forEach(send => this.removeClient(send))
  }

  /** Returns false if the send failed (broken pipe etc.). */
  #sendEntry(entry, message) {
    // Skip events for libraries this client isn't allowed to see
    if (entry.libraryFilter != null && message.libraryId && !entry.libraryFilter.has(message.libraryId)) {
      return true
    }
    try { entry.send(message); return true }
    catch { return false }
  }
}