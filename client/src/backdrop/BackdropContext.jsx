import { createContext, useCallback, useContext, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import styles from './Backdrop.module.css'

/**
 * Session-persistent full-app backdrop, matching jellyfin-web's
 * components/backdrop/backdrop.js.
 *
 * This is a DIFFERENT mechanism from the item-detail-page hero (see
 * MovieDetail.jsx) — Jellyfin itself uses two separate systems:
 *   - this one: a body-level, z-index:-1 layer behind the entire app chrome
 *     (nav, top bar, content), used while browsing Home/libraries. It
 *     persists across navigation until a page explicitly sets or clears it.
 *   - the item detail page's own local .itemBackdrop element: a fixed-height,
 *     background-attachment:fixed strip local to that page, not routed
 *     through this context.
 *
 * Rendered via a portal to document.body (matching Jellyfin's own
 * `document.body.insertBefore(backdropContainer, document.body.firstChild)`)
 * so it sits behind everything regardless of where in the component tree a
 * page calls setBackdrop — a fixed z-index:-1 element only reliably stays
 * behind its siblings if nothing between it and <body> creates its own
 * stacking context (the rail/top bar's backdrop-filter does exactly that),
 * so it can't just be a sibling of <Layout> in the normal tree.
 */
const BackdropCtx = createContext(null)

export function BackdropProvider({ children }) {
  // Two-layer crossfade: "current" stays visible while "incoming" fades in
  // on top, then becomes current. Jellyfin stacks a new .backdropImage div
  // per change and never prunes until clearBackdrop(); capping this at two
  // gets the same cross-fade without unbounded DOM growth over a session.
  const [current, setCurrent] = useState(null)
  const [incoming, setIncoming] = useState(null)
  const lastUrlRef = useRef(null)

  const setBackdrop = useCallback((url) => {
    if (!url || url === lastUrlRef.current) return
    lastUrlRef.current = url

    // Preload so the fade-in starts once the image can actually paint,
    // matching backdrop.js's `img.onload` gate.
    const img = new Image()
    img.onload = () => {
      // With no animation there's no animationend to promote incoming ->
      // current, so do it immediately instead of leaving incoming stuck on
      // top of a stale current forever.
      if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) {
        setCurrent(url)
        setIncoming(null)
      } else {
        setIncoming(url)
      }
    }
    img.src = url
  }, [])

  const clearBackdrop = useCallback(() => {
    lastUrlRef.current = null
    setCurrent(null)
    setIncoming(null)
  }, [])

  const onIncomingFadeEnd = useCallback(() => {
    setCurrent(incoming)
    setIncoming(null)
  }, [incoming])

  return (
    <BackdropCtx.Provider value={{ setBackdrop, clearBackdrop }}>
      {children}
      {createPortal(
        <div className={styles.container} aria-hidden="true">
          {current && (
            <div className={styles.layer} style={{ backgroundImage: `url(${current})` }} />
          )}
          {incoming && (
            <div
              key={incoming}
              className={`${styles.layer} ${styles.fadeIn}`}
              style={{ backgroundImage: `url(${incoming})` }}
              onAnimationEnd={onIncomingFadeEnd}
            />
          )}
        </div>,
        document.body
      )}
    </BackdropCtx.Provider>
  )
}

/**
 * @returns {{ setBackdrop: (url: string) => void, clearBackdrop: () => void }}
 */
export function useBackdrop() {
  const ctx = useContext(BackdropCtx)
  if (!ctx) throw new Error('useBackdrop must be used within BackdropProvider')
  return ctx
}
