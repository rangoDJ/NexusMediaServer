import { useRef, useState, useEffect, useCallback } from 'react'
import styles from './Row.module.css'

/**
 * Horizontal scroll row with edge affordances.
 *
 * The old rows were a bare `overflow-x: auto` flex strip: nothing indicated
 * there was more content, and reaching it meant a trackpad swipe or dragging
 * a 4px scrollbar. This fades whichever edge has content beyond it and offers
 * arrow buttons on hover.
 *
 * The fades are driven by real scroll position rather than shown permanently,
 * so a row that fits its container looks flat instead of pretending to
 * overflow.
 */
export default function Row({ title, eyebrow, children, className = '' }) {
  const scrollerRef = useRef(null)
  const [atStart, setAtStart] = useState(true)
  const [atEnd, setAtEnd] = useState(true)

  const measure = useCallback(() => {
    const el = scrollerRef.current
    if (!el) return
    // 1px slack absorbs subpixel rounding at the extremes, which otherwise
    // leaves a permanently half-lit arrow.
    setAtStart(el.scrollLeft <= 1)
    setAtEnd(el.scrollLeft + el.clientWidth >= el.scrollWidth - 1)
  }, [])

  useEffect(() => {
    const el = scrollerRef.current
    if (!el) return
    measure()
    el.addEventListener('scroll', measure, { passive: true })
    // Content arrives asynchronously and the viewport can change without a
    // scroll event, so observe the box as well as the scroll position.
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => {
      el.removeEventListener('scroll', measure)
      ro.disconnect()
    }
  }, [measure, children])

  function scrollBy(dir) {
    const el = scrollerRef.current
    if (!el) return
    // Leave a sliver of the outgoing card visible so the jump stays legible
    // as movement rather than a cut to unrelated content.
    el.scrollBy({ left: dir * el.clientWidth * 0.85, behavior: 'smooth' })
  }

  /**
   * Left/Right paging for keyboard users.
   *
   * The arrow buttons are pointer-only (they're aria-hidden and out of the tab
   * order), so without this a keyboard user's only way through a long row is
   * to tab every card in it. Home/End jump to either end.
   *
   * Only handled when focus is inside the row, and never when it's in a text
   * field, where arrow keys move the caret.
   */
  function onKeyDown(e) {
    const t = e.target
    if (t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement) return

    switch (e.key) {
      case 'ArrowRight': e.preventDefault(); scrollBy(1); break
      case 'ArrowLeft':  e.preventDefault(); scrollBy(-1); break
      case 'Home':
        e.preventDefault()
        scrollerRef.current?.scrollTo({ left: 0, behavior: 'smooth' })
        break
      case 'End': {
        e.preventDefault()
        const el = scrollerRef.current
        el?.scrollTo({ left: el.scrollWidth, behavior: 'smooth' })
        break
      }
      default: break
    }
  }

  return (
    <section className={`${styles.row} ${className}`}>
      <div className={styles.head}>
        <h2 className={styles.title}>{title}</h2>
        {eyebrow && <span className={styles.eyebrow}>{eyebrow}</span>}
      </div>

      <div className={styles.viewport} onKeyDown={onKeyDown}>
        <div
          className={`${styles.fade} ${styles.fadeStart} ${atStart ? styles.fadeOff : ''}`}
          aria-hidden="true"
        />
        <div
          className={`${styles.fade} ${styles.fadeEnd} ${atEnd ? styles.fadeOff : ''}`}
          aria-hidden="true"
        />

        {/* Arrows are supplementary: the row is already scrollable by wheel,
            trackpad, touch and keyboard, so they stay out of the tab order. */}
        <button
          className={`${styles.arrow} ${styles.arrowStart} ${atStart ? styles.arrowOff : ''}`}
          onClick={() => scrollBy(-1)}
          tabIndex={-1}
          aria-hidden="true"
        >
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor"
               strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
            <path d="m15 5-7 7 7 7" />
          </svg>
        </button>
        <button
          className={`${styles.arrow} ${styles.arrowEnd} ${atEnd ? styles.arrowOff : ''}`}
          onClick={() => scrollBy(1)}
          tabIndex={-1}
          aria-hidden="true"
        >
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor"
               strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
            <path d="m9 5 7 7-7 7" />
          </svg>
        </button>

        <div className={styles.scroller} ref={scrollerRef}>
          {children}
        </div>
      </div>
    </section>
  )
}
