import { useNavigate } from 'react-router-dom'
import styles from './MediaCard.module.css'

/**
 * Shared poster card for movies/series — used by Home's rows and the
 * library browse grid. Mirrors Jellyfin's indicators.js: a played checkmark
 * for fully-watched items, an unwatched-episode-count badge for series with
 * remaining episodes, a progress bar for in-progress items, and a
 * hover-to-play overlay button (Jellyfin's CardOverlayButtons) that jumps
 * straight into playback instead of requiring a detail-page visit first.
 *
 * @param {object}  item           media_items row (list shape — see routes/media.js GET /)
 * @param {boolean} [showProgress] force-show the progress bar (Continue Watching rows)
 * @param {string}  [className]    sizing class from the caller — a fixed
 *   width for a horizontal-scroll row, or omitted to fill a grid cell at 100%
 */
export default function MediaCard({ item, showProgress = false, className = '' }) {
  const navigate = useNavigate()

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
    // Series cards in a generic list don't carry an episode to resume —
    // land on the detail page, same as clicking elsewhere on the card.
    // Movies auto-start via the ?play=1 flag; Player.jsx resumes from
    // stored progress on its own, so no position needs to be passed here.
    navigate(isSeries ? `/movie/${item.id}` : `/movie/${item.id}?play=1`)
  }

  // Not a <button> — it contains a nested interactive play button, which
  // isn't valid inside a native <button>. role="button" + a click/keydown
  // handler keeps it keyboard- and screen-reader-accessible instead.
  return (
    <div
      className={`${styles.card} ${className}`}
      role="button"
      tabIndex={0}
      onClick={goToDetail}
      onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); goToDetail() } }}
      title={item.title}
    >
      <div className={styles.poster}>
        {item.poster_url
          ? <img src={item.poster_url} alt={item.title} loading="lazy" />
          : <div className={styles.posterPlaceholder}>{item.title[0]?.toUpperCase()}</div>
        }

        <div className={styles.hoverScrim}>
          <button className={styles.playBtn} onClick={playNow} aria-label={`Play ${item.title}`}>
            ▶
          </button>
        </div>

        {isSeries && <div className={styles.typeBadge}>SERIES</div>}

        {showPlayedCheck && (
          <div className={styles.playedBadge} title="Watched">✓</div>
        )}
        {showUnwatchedCount && (
          <div className={styles.countBadge} title={`${item.unwatched_count} unwatched episode(s)`}>
            {item.unwatched_count > 99 ? '99+' : item.unwatched_count}
          </div>
        )}

        {pct > 0 && (
          <div className={styles.progressBar}>
            <div className={styles.progressFill} style={{ width: `${pct}%` }} />
          </div>
        )}
      </div>
      <p className={styles.cardTitle}>{item.title}</p>
      {item.year && <p className={styles.cardSub}>{item.year}</p>}
    </div>
  )
}
