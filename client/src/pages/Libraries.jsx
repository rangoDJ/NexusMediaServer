import { useState, useEffect, useCallback } from 'react'
import { api } from '../api/client.js'
import { useServerEvents } from '../hooks/useServerEvents.js'
import styles from './Libraries.module.css'

// ── Helpers ───────────────────────────────────────────────────────────────────

function relativeTime(isoStr) {
  if (!isoStr) return null
  const diff = Date.now() - new Date(isoStr).getTime()
  const mins  = Math.floor(diff / 60_000)
  const hours = Math.floor(diff / 3_600_000)
  const days  = Math.floor(diff / 86_400_000)
  if (mins  < 1)   return 'just now'
  if (mins  < 60)  return `${mins}m ago`
  if (hours < 24)  return `${hours}h ago`
  return `${days}d ago`
}

const TYPE_LABEL = { movies: 'Movies', series: 'TV Shows', tv: 'TV Shows', music: 'Music' }

// ── Component ─────────────────────────────────────────────────────────────────

export default function Libraries() {
  const [libraries, setLibraries]   = useState([])
  const [loading, setLoading]       = useState(true)
  /** @type {[Record<string,{phase,progress,currentItem,libraryName}>, Function]} */
  const [scanProgress, setScanProgress] = useState({})
  const [toasts, setToasts]         = useState([])
  const user = JSON.parse(localStorage.getItem('nexus_user') || '{}')
  const isAdmin = user.role === 'admin'

  // ── Data loading ────────────────────────────────────────────────────────────

  const loadLibraries = useCallback(async () => {
    try {
      const { data } = await api.get('/libraries')
      setLibraries(data)
      // Seed scanProgress from DB columns for libraries already scanning
      // (covers the case where user navigates here mid-scan without SSE history)
      setScanProgress(prev => {
        const next = { ...prev }
        for (const lib of data) {
          if (lib.scan_status === 'scanning' && !next[lib.id]) {
            next[lib.id] = {
              phase:       lib.scan_phase    ?? 'Scanning',
              progress:    lib.scan_progress ?? 0,
              currentItem: lib.scan_current  ?? null,
              libraryName: lib.name,
            }
          } else if (lib.scan_status !== 'scanning') {
            delete next[lib.id]
          }
        }
        return next
      })
    } catch { /* network error — keep stale data */ }
    finally   { setLoading(false) }
  }, [])

  useEffect(() => { loadLibraries() }, [loadLibraries])

  // ── Toast helpers ───────────────────────────────────────────────────────────

  const addToast = useCallback((message, variant = 'success') => {
    const id = Date.now() + Math.random()
    setToasts(prev => [...prev, { id, message, variant }])
    setTimeout(() => setToasts(prev => prev.filter(t => t.id !== id)), 5_000)
  }, [])

  // ── Live SSE events ─────────────────────────────────────────────────────────

  useServerEvents({
    'refresh.progress': (e) => {
      setScanProgress(prev => ({
        ...prev,
        [e.libraryId]: {
          phase:       e.phase,
          progress:    e.progress,
          currentItem: e.currentItem,
          libraryName: e.libraryName,
        },
      }))
      // Make sure this library shows as scanning in the list
      setLibraries(prev => prev.map(lib =>
        lib.id === e.libraryId ? { ...lib, scan_status: 'scanning' } : lib
      ))
    },

    'library.changed': (e) => {
      // Remove from progress map and refresh library row for updated counts
      setScanProgress(prev => {
        const next = { ...prev }
        delete next[e.libraryId]
        return next
      })
      const count = e.itemsAdded?.length ?? 0
      const msg   = count > 0
        ? `✓ ${e.libraryName} — scan complete · ${count} new item${count === 1 ? '' : 's'} added`
        : `✓ ${e.libraryName} — scan complete · no new items`
      addToast(msg)
      loadLibraries()
    },

    'scan.error': (e) => {
      setScanProgress(prev => {
        const next = { ...prev }
        delete next[e.libraryId]
        return next
      })
      addToast(`✗ ${e.libraryName} — scan failed: ${e.errorMessage}`, 'error')
      loadLibraries()
    },
  })

  // ── Scan trigger ────────────────────────────────────────────────────────────

  async function triggerScan(library) {
    try {
      await api.post(`/libraries/${library.id}/scan`)
      setLibraries(prev => prev.map(l =>
        l.id === library.id ? { ...l, scan_status: 'scanning' } : l
      ))
      setScanProgress(prev => ({
        ...prev,
        [library.id]: { phase: 'Starting', progress: 0, currentItem: null, libraryName: library.name },
      }))
    } catch (err) {
      addToast(`Failed to start scan: ${err.response?.data?.error ?? err.message}`, 'error')
    }
  }

  async function triggerScanAll() {
    await Promise.allSettled(
      libraries
        .filter(l => l.scan_status !== 'scanning')
        .map(l => triggerScan(l))
    )
  }

  // ── Render ──────────────────────────────────────────────────────────────────

  if (loading) return <LibrariesSkeleton />

  return (
    <main className={styles.main}>
      {/* ── Header ── */}
      <div className={styles.header}>
        <div>
          <h1 className={styles.title}>Libraries</h1>
          <p className={styles.subtitle}>
            {libraries.length} librar{libraries.length === 1 ? 'y' : 'ies'} ·{' '}
            {libraries.reduce((s, l) => s + (l.item_count ?? 0), 0).toLocaleString()} items
          </p>
        </div>
        {isAdmin && libraries.length > 1 && (
          <button
            className={styles.scanAllBtn}
            onClick={triggerScanAll}
            disabled={libraries.some(l => l.scan_status === 'scanning')}
          >
            Scan All
          </button>
        )}
      </div>

      {/* ── Library grid ── */}
      {libraries.length === 0 ? (
        <div className={styles.empty}>
          <p>No libraries configured.</p>
          {isAdmin && (
            <p className={styles.emptyHint}>Add a library in <a href="/settings">Settings</a>.</p>
          )}
        </div>
      ) : (
        <div className={styles.grid}>
          {libraries.map(lib => (
            <LibraryCard
              key={lib.id}
              library={lib}
              scanState={scanProgress[lib.id] ?? null}
              isAdmin={isAdmin}
              onScan={triggerScan}
            />
          ))}
        </div>
      )}

      {/* ── Toast stack ── */}
      <ToastStack toasts={toasts} onDismiss={id =>
        setToasts(prev => prev.filter(t => t.id !== id))
      } />
    </main>
  )
}

// ── LibraryCard ────────────────────────────────────────────────────────────────

function LibraryCard({ library, scanState, isAdmin, onScan }) {
  const isScanning  = library.scan_status === 'scanning'
  const isError     = library.scan_status === 'error'
  const progress    = scanState?.progress ?? 0
  const phase       = scanState?.phase    ?? ''
  const currentItem = scanState?.currentItem

  return (
    <div className={`${styles.card} ${isScanning ? styles.cardScanning : ''} ${isError ? styles.cardError : ''}`}>
      {/* Backdrop strip */}
      <div className={styles.backdrop}>
        <div className={styles.backdropOverlay} />
        <div className={styles.typeChip}>{TYPE_LABEL[library.type] ?? library.type}</div>
      </div>

      {/* Card body */}
      <div className={styles.body}>
        <h2 className={styles.libName}>{library.name}</h2>

        <div className={styles.meta}>
          <span className={styles.metaItem}>
            {(library.item_count ?? 0).toLocaleString()} item{library.item_count === 1 ? '' : 's'}
          </span>
          {library.type === 'series' || library.type === 'tv' ? (
            <span className={styles.metaItem}>
              {(library.episode_count ?? 0).toLocaleString()} episodes
            </span>
          ) : null}
        </div>

        {/* ── Scan progress (only while scanning) ── */}
        {isScanning ? (
          <div className={styles.scanInfo}>
            <div className={styles.progressRow}>
              <span className={styles.phaseLabel}>{phase || 'Scanning…'}</span>
              <span className={styles.progressPct}>{progress}%</span>
            </div>
            <div className={styles.progressTrack}>
              <div className={styles.progressFill} style={{ width: `${progress}%` }} />
            </div>
            {currentItem && (
              <p className={styles.currentItem} title={currentItem}>{currentItem}</p>
            )}
          </div>
        ) : (
          <div className={styles.statusRow}>
            {isError ? (
              <span className={`${styles.statusChip} ${styles.statusError}`}>Error</span>
            ) : library.last_scanned_at ? (
              <span className={`${styles.statusChip} ${styles.statusOk}`}>
                Scanned {relativeTime(library.last_scanned_at)}
              </span>
            ) : (
              <span className={`${styles.statusChip} ${styles.statusNever}`}>Never scanned</span>
            )}
          </div>
        )}

        {/* ── Actions ── */}
        <div className={styles.actions}>
          <a href={`/library/${library.id}`} className={styles.browseBtn}>Browse</a>
          {isAdmin && (
            <button
              className={styles.scanBtn}
              onClick={() => onScan(library)}
              disabled={isScanning}
            >
              {isScanning ? (
                <span className={styles.scanSpinner} aria-label="Scanning" />
              ) : 'Scan now'}
            </button>
          )}
        </div>
      </div>
    </div>
  )
}

// ── ToastStack ─────────────────────────────────────────────────────────────────

function ToastStack({ toasts, onDismiss }) {
  if (!toasts.length) return null
  return (
    <div className={styles.toastStack} role="status" aria-live="polite">
      {toasts.map(t => (
        <div
          key={t.id}
          className={`${styles.toast} ${t.variant === 'error' ? styles.toastError : styles.toastSuccess}`}
        >
          <span className={styles.toastMsg}>{t.message}</span>
          <button className={styles.toastClose} onClick={() => onDismiss(t.id)} aria-label="Dismiss">×</button>
        </div>
      ))}
    </div>
  )
}

// ── Skeleton ───────────────────────────────────────────────────────────────────

function LibrariesSkeleton() {
  return (
    <main className={styles.main}>
      <div className={styles.header}>
        <div>
          <div className={`${styles.skeleton} ${styles.skelTitle}`} />
          <div className={`${styles.skeleton} ${styles.skelSub}`} />
        </div>
      </div>
      <div className={styles.grid}>
        {[0, 1, 2].map(i => (
          <div key={i} className={`${styles.card} ${styles.skelCard}`}>
            <div className={`${styles.backdrop} ${styles.skeleton}`} />
            <div className={styles.body}>
              <div className={`${styles.skeleton} ${styles.skelName}`} />
              <div className={`${styles.skeleton} ${styles.skelMeta}`} />
            </div>
          </div>
        ))}
      </div>
    </main>
  )
}
