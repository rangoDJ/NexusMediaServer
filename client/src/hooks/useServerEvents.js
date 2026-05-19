import { useEffect, useRef } from 'react'

/**
 * useServerEvents — subscribe to the server's SSE event stream.
 *
 * Calls handlers[event.type](event) for each message received.
 * Automatically reconnects on drop (exponential back-off, max 30 s).
 *
 * @param {Record<string, (event: object) => void>} handlers
 *
 * @example
 * useServerEvents({
 *   'refresh.progress': (e) => setProgress(p => ({ ...p, [e.libraryId]: e })),
 *   'library.changed':  (e) => refreshLibrary(e.libraryId),
 *   'scan.error':       (e) => showToast(`Scan failed: ${e.errorMessage}`),
 * })
 */
export function useServerEvents(handlers) {
  // Keep handlers in a ref so the effect doesn't re-run when they change
  const handlersRef = useRef(handlers)
  useEffect(() => { handlersRef.current = handlers })

  useEffect(() => {
    let es = null
    let retryDelay = 1_000
    let stopped = false

    function connect() {
      if (stopped) return
      const token = localStorage.getItem('nexus_token')
      if (!token) return   // not logged in — don't connect

      es = new EventSource(`/api/v1/events?token=${encodeURIComponent(token)}`)

      es.onopen = () => {
        retryDelay = 1_000  // reset back-off on successful connection
      }

      es.onmessage = (raw) => {
        try {
          const event = JSON.parse(raw.data)
          handlersRef.current?.[event.type]?.(event)
        } catch { /* ignore malformed messages */ }
      }

      es.onerror = () => {
        es.close()
        es = null
        if (!stopped) {
          setTimeout(connect, retryDelay)
          retryDelay = Math.min(retryDelay * 2, 30_000)
        }
      }
    }

    connect()

    return () => {
      stopped = true
      es?.close()
    }
  }, []) // empty deps — connect once per mount, handlers tracked via ref
}
