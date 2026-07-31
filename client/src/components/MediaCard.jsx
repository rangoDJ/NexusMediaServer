import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { api } from '../api/client.js'
import Blurhash from './Blurhash.jsx'
import styles from './MediaCard.module.css'

// jellyfin-web's literal defaultCardBackground1..5, cycled by item id — see
// tokens.css. Used only when an item has no artwork at all; it is not a
// colour sampled from anything (that's the previous, Nexus-only design).
const FALLBACK_COUNT = 5

/** Deterministic 1..5 from an item id, stable across renders and reloads. */
export function fallbackIndex(id) {
  let h = 0
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0
  return (h % FALLBACK_COUNT) + 1
}

/**
 * Loading placeholder for a MediaCard.
 *
 * Lives in this module and reuses the card's own `.art` class so its aspect
 * ratio, radius and spacing cannot drift from the real card — the previous
 * skeleton restated all of that in Home.module.css and had already fallen out
 * of step with it.
 */
export function MediaCardSkeleton({ variant = 'poster', className = '' }) {
  return (
    <div className={`${styles.card} ${styles[variant]} ${styles.skeleton} ${className}`} aria-hidden="true">
      <div className={`${styles.art} ${styles.shimmer}`} />
      <div className={`${styles.shimmer} ${styles.skelLine}`} style={{ width: '78%' }} />
      <div className={`${styles.shimmer} ${styles.skelLine}`} style={{ width: '38%', marginTop: 6 }} />
    </div>
  )
}

/**
 * Shared media card, matching jellyfin-web's actual card behaviour rather
 * than the earlier per-item extracted-colour treatment: a blurhash decode
 * shown behind the poster while it loads (components/cardbuilder/
 * cardImage.ts), and — only for items with no artwork at all — one of 5
 * fixed fallback colours cycled by item id (defaultCardBackground1..5).
 * Every other coloured surface (hover ring, progress fill, badges) uses the
 * single app accent, matching Jellyfin's own indicators (itemProgressBarForeground/
 * playedIndicator/countIndicator all resolve to --jf-palette-primary-main).
 *
 * @param {object}  item             media row (see routes/media.js GET /)
 * @param {boolean} [showProgress]   force the progress bar (Continue Watching)
 * @param {'poster'|'wide'} [variant] 2:3 poster art, or a 16:9 still for
 *   in-progress content, where a half-watched episode is a different kind of
 *   object than a poster you have never opened
 * @param {string}  [className]      sizing from the caller — a fixed width in a
 *   scroll row, omitted to fill a grid cell
 */
export default function MediaCard({
  item,
  showProgress = false,
  variant = 'poster',
  className = '',
}) {
  const navigate = useNavigate()
  const [favorite, setFavorite] = useState(!!item.is_favorite)
  const [busy, setBusy] = useState(false)
  const [imgLoaded, setImgLoaded] = useState(false)

  const pct = (showProgress || item.position_secs > 0) && item.duration_secs > 0
    ? Math.min(100, Math.round((item.position_secs / item.duration_secs) * 100))
    : 0

  const isSeries = item.type === 'series'
  const showPlayedCheck = !isSeries && item.watched === true
  const showUnwatchedCount = isSeries && item.unwatched_count > 0

  function goToDetail() {
    navigate(`/movie/${item.id}`)
  }

  function playNow(e) {
    e.stopPropagation()
    // A series in a generic list carries no episode to resume, so it lands on
    // the detail page. Movies auto-start via ?play=1; Player resumes from
    // stored progress on its own.
    navigate(isSeries ? `/movie/${item.id}` : `/movie/${item.id}?play=1`)
  }

  async function toggleFavorite(e) {
    e.stopPropagation()
    if (busy) return
    const next = !favorite
    setFavorite(next)          // optimistic — the button is the only reader
    setBusy(true)
    try {
      if (next) await api.post(`/media/${item.id}/favorite`)
      else      await api.delete(`/media/${item.id}/favorite`)
    } catch {
      setFavorite(!next)       // put it back; the server disagreed
    } finally {
      setBusy(false)
    }
  }

  const meta = [
    item.year,
    isSeries && item.unwatched_count > 0 ? `${item.unwatched_count} new` : null,
  ].filter(Boolean).join(' · ')

  // Not a <button>: it contains nested interactive controls, which is invalid
  // inside one. role="button" plus key handling keeps it operable.
  return (
    <div
      className={`${styles.card} ${styles[variant]} ${className}`}
      role="button"
      tabIndex={0}
      onClick={goToDetail}
      onKeyDown={e => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); goToDetail() }
      }}
      title={item.title}
    >
      <div className={styles.art}>
        {item.poster_url ? (
          <>
            {/* Shown until the real image paints, then hidden — matches
                jellyfin-web's blurhash-behind-the-poster pattern. Skipped
                entirely (renders null) once there's no hash or the image has
                already loaded, so it doesn't sit in the DOM forever. */}
            {!imgLoaded && <Blurhash hash={item.blurhash} className={styles.blurhash} />}
            <img
              src={item.poster_url}
              alt=""
              loading="lazy"
              className={`${styles.poster} ${imgLoaded ? styles.posterLoaded : ''}`}
              onLoad={() => setImgLoaded(true)}
            />
          </>
        ) : (
          <div
            className={styles.placeholder}
            style={{ '--fallback': `var(--card-fallback-${fallbackIndex(item.id)})` }}
            aria-hidden="true"
          >
            {item.title[0]?.toUpperCase()}
          </div>
        )}

        <div className={styles.scrim}>
          <button
            className={styles.play}
            onClick={playNow}
            tabIndex={-1}
            aria-label={`Play ${item.title}`}
          >
            <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
              <path d="M8 5.5v13l11-6.5z" />
            </svg>
          </button>
          <button
            className={`${styles.fav} ${favorite ? styles.favOn : ''}`}
            onClick={toggleFavorite}
            tabIndex={-1}
            aria-label={favorite ? `Remove ${item.title} from favorites` : `Add ${item.title} to favorites`}
            aria-pressed={favorite}
          >
            <svg width="13" height="13" viewBox="0 0 24 24"
                 fill={favorite ? 'currentColor' : 'none'}
                 stroke="currentColor" strokeWidth="2" strokeLinejoin="round" aria-hidden="true">
              <path d="m12 4.3 2.4 4.9 5.4.8-3.9 3.8.9 5.4-4.8-2.5-4.8 2.5.9-5.4L4.2 10l5.4-.8z" />
            </svg>
          </button>
        </div>

        {isSeries && <div className={styles.typeBadge}>Series</div>}
        {showPlayedCheck && (
          <div className={styles.playedBadge} title="Watched" aria-label="Watched">
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                 strokeWidth="3.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="m5 13 5 5L20 7" />
            </svg>
          </div>
        )}
        {showUnwatchedCount && (
          <div className={styles.countBadge} title={`${item.unwatched_count} unwatched`}>
            {item.unwatched_count > 99 ? '99+' : item.unwatched_count}
          </div>
        )}

        {pct > 0 && (
          <div className={styles.progress}>
            <div className={styles.progressFill} style={{ width: `${pct}%` }} />
          </div>
        )}
      </div>

      <p className={styles.title}>{item.title}</p>
      {meta && <p className={styles.meta}>{meta}</p>}
    </div>
  )
}
