import { useState, useEffect, useRef } from 'react'
import { useNavigate } from 'react-router-dom'
import styles from './Spotlight.module.css'

const ROTATE_MS = 9000

/**
 * The page's opening statement.
 *
 * Home previously began with ten interchangeable poster rows and no entry
 * point — nothing said where to start. This puts one title up front at full
 * bleed, tinted with its own artwork color, and rotates slowly through a
 * handful.
 *
 * Rotation pauses on hover and focus: a banner that swaps out from under a
 * pointer heading for the Play button is worse than no rotation at all.
 */
export default function Spotlight({ items = [] }) {
  const [index, setIndex] = useState(0)
  const [paused, setPaused] = useState(false)
  const navigate = useNavigate()
  const reduced = useRef(false)

  useEffect(() => {
    reduced.current = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false
  }, [])

  useEffect(() => {
    // Rotation is decorative motion. With reduced motion requested, show the
    // first item and leave it alone.
    if (items.length < 2 || paused || reduced.current) return
    const id = setInterval(() => setIndex(i => (i + 1) % items.length), ROTATE_MS)
    return () => clearInterval(id)
  }, [items.length, paused])

  // Guard against the list shrinking (a library scan finishing mid-view)
  // leaving the index past the end.
  useEffect(() => { setIndex(i => (i >= items.length ? 0 : i)) }, [items.length])

  if (!items.length) return null
  const item = items[index] ?? items[0]
  const art = item.dominant_color

  const backdrop = item.backdrop_url ?? item.poster_url
  const isSeries = item.type === 'series'

  return (
    <section
      className={styles.spotlight}
      style={art ? { '--art': art } : undefined}
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
      onFocusCapture={() => setPaused(true)}
      onBlurCapture={() => setPaused(false)}
      aria-label="Featured"
    >
      {backdrop && (
        <img className={styles.backdrop} src={backdrop} alt="" key={backdrop} />
      )}
      <div className={styles.wash} aria-hidden="true" />
      <div className={styles.scrim} aria-hidden="true" />

      <div className={styles.content}>
        {item.year && (
          <p className={styles.eyebrow}>
            {isSeries ? 'Series' : 'Film'} · {item.year}
          </p>
        )}
        <h2 className={styles.title}>{item.title}</h2>
        {item.plot && <p className={styles.plot}>{item.plot}</p>}

        <div className={styles.actions}>
          <button
            className={styles.play}
            onClick={() => navigate(isSeries ? `/movie/${item.id}` : `/movie/${item.id}?play=1`)}
          >
            <svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
              <path d="M8 5.5v13l11-6.5z" />
            </svg>
            Play
          </button>
          <button className={styles.more} onClick={() => navigate(`/movie/${item.id}`)}>
            More info
          </button>
        </div>
      </div>

      {items.length > 1 && (
        <div className={styles.ticks} role="tablist" aria-label="Featured titles">
          {items.map((it, i) => (
            <button
              key={it.id}
              className={`${styles.tick} ${i === index ? styles.tickOn : ''}`}
              onClick={() => setIndex(i)}
              role="tab"
              aria-selected={i === index}
              aria-label={it.title}
            />
          ))}
        </div>
      )}
    </section>
  )
}
