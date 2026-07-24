import { useState, useEffect } from 'react'
import { createPortal } from 'react-dom'
import { useParams, useNavigate, useSearchParams } from 'react-router-dom'
import { api } from '../api/client.js'
import Player from './Player.jsx'
import styles from './MovieDetail.module.css'

function fmt(secs) {
  if (!secs) return null
  const h = Math.floor(secs / 3600)
  const m = Math.floor((secs % 3600) / 60)
  return h > 0 ? `${h}h ${m}m` : `${m}m`
}

function pad(n) { return String(n).padStart(2, '0') }

export default function MovieDetail() {
  const { id } = useParams()
  const navigate = useNavigate()
  const [searchParams, setSearchParams] = useSearchParams()
  const user = JSON.parse(localStorage.getItem('nexus_user') || '{}')

  const [item, setItem]               = useState(null)
  const [playing, setPlaying]         = useState(null)
  const [openSeason, setOpenSeason]   = useState(null)
  const [error, setError]             = useState(null)
  const [isFavorite, setIsFavorite]   = useState(false)
  const [showRematch, setShowRematch] = useState(false)

  useEffect(() => {
    Promise.all([
      api.get(`/media/${id}`),
      api.get(`/media/${id}/favorite`).catch(() => ({ data: { is_favorite: false } })),
    ]).then(([mediaRes, favRes]) => {
      setItem(mediaRes.data)
      setIsFavorite(favRes.data.is_favorite)
      if (mediaRes.data.type === 'series' && mediaRes.data.episodes?.length) {
        setOpenSeason(mediaRes.data.episodes[0].season_number)
      }
      // Hover-play from a MediaCard lands here with ?play=1 for movies —
      // auto-start playback (Player resumes from stored progress on its own).
      if (searchParams.get('play') === '1' && mediaRes.data.type !== 'series') {
        setPlaying({ mediaItemId: mediaRes.data.id, title: mediaRes.data.title })
        setSearchParams(prev => { prev.delete('play'); return prev }, { replace: true })
      }
    }).catch(() => setError('Could not load this title.'))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id])

  async function toggleFavorite() {
    try {
      if (isFavorite) {
        await api.delete(`/media/${id}/favorite`)
        setIsFavorite(false)
      } else {
        await api.post(`/media/${id}/favorite`)
        setIsFavorite(true)
      }
    } catch {
      // ignore — UI stays in sync with last known state
    }
  }

  function handleRematchDone(updated) {
    setItem(prev => ({ ...prev, ...updated }))
    setShowRematch(false)
  }

  // When an episode finishes, auto-advance to the next one in the series
  // (next episode this season, else first episode of the next season).
  function advanceToNextEpisode() {
    if (!playing?.episodeId || !item?.episodes?.length) {
      setPlaying(null)
      return
    }
    const idx  = item.episodes.findIndex(e => e.id === playing.episodeId)
    const next = idx >= 0 ? item.episodes[idx + 1] : null
    if (!next) {
      setPlaying(null) // end of series
      return
    }
    setPlaying({
      episodeId: next.id,
      title: `${item.title} · S${pad(next.season_number)}E${pad(next.episode_number)}${next.title ? ` — ${next.title}` : ''}`,
    })
  }

  if (playing && item) {
    return (
      <div className={styles.playerOverlay}>
        <div className={styles.playerBar}>
          <button className="ghost" onClick={() => setPlaying(null)}>&#8592; Back</button>
          <span className={styles.playerTitle}>{playing.title}</span>
        </div>
        <div style={{ flex: 1, minHeight: 0 }}>
          <Player
            key={playing.episodeId ?? playing.mediaItemId}
            mediaItemId={playing.mediaItemId}
            episodeId={playing.episodeId}
            title={playing.title}
            onEnded={advanceToNextEpisode}
          />
        </div>
      </div>
    )
  }

  if (error) {
    return (
      <div className={styles.errorPage}>
        <button className="ghost" onClick={() => navigate(-1)}>&#8592; Back</button>
        <p>{error}</p>
      </div>
    )
  }

  if (!item) return <div className={styles.loading}>Loading…</div>

  const meta     = item.metadata ?? {}
  const cast     = meta.cast     ?? []
  const director = meta.director ?? null
  const writer   = meta.writer   ?? null
  const studios  = meta.studios  ?? null
  const genres   = item.genres   ?? meta.genres ?? null

  // Group episodes by season for series
  const seasons = item.type === 'series' && item.episodes
    ? [...new Set(item.episodes.map(e => e.season_number))].sort((a, b) => a - b)
    : []
  const episodesBySeason = (item.episodes ?? []).reduce((acc, ep) => {
    if (!acc[ep.season_number]) acc[ep.season_number] = []
    acc[ep.season_number].push(ep)
    return acc
  }, {})

  return (
  <>
    <div className={styles.page}>
      {/* ── Hero with blurred backdrop ─────────────────────────────────── */}
      <div className={styles.hero}>
        {item.backdrop_url && (
          <div
            className={styles.backdrop}
            style={{ backgroundImage: `url(${item.backdrop_url})` }}
          />
        )}
        <div className={styles.heroGradient} />

        <div className={styles.heroInner}>
          <button className={styles.backBtn} onClick={() => navigate(-1)}>
            &#8592; Back
          </button>

          <div className={styles.heroContent}>
            {/* Poster */}
            <div className={styles.posterWrap}>
              {item.poster_url
                ? <img className={styles.poster} src={item.poster_url} alt={item.title} />
                : <div className={styles.posterPlaceholder}>{item.title[0]}</div>
              }
            </div>

            {/* Info */}
            <div className={styles.info}>
              <h1 className={styles.title}>{item.title}</h1>
              {meta.tagline && <p className={styles.tagline}>{meta.tagline}</p>}

              <div className={styles.metaRow}>
                {item.year      && <span>{item.year}</span>}
                {item.type === 'series' && seasons.length > 0 && (
                  <span>{seasons.length} {seasons.length === 1 ? 'Season' : 'Seasons'}</span>
                )}
                {item.type !== 'series' && item.duration_secs && <span>{fmt(item.duration_secs)}</span>}
                {item.rating    && (
                  <span className={styles.rating}>★ {Number(item.rating).toFixed(1)}</span>
                )}
              </div>

              {item.plot && <p className={styles.plot}>{item.plot}</p>}

              <table className={styles.metaTable}>
                <tbody>
                  {genres?.length   > 0 && <MetaRow label="Genres"   value={genres.join(', ')} />}
                  {director          && <MetaRow label="Director" value={director} />}
                  {writer            && <MetaRow label="Writer"   value={writer} />}
                  {studios?.length  > 0 && <MetaRow label="Studios"  value={studios.join(', ')} />}
                  {item.video_codec  && <MetaRow label="Video"    value={[item.video_codec?.toUpperCase(), item.width && item.height ? `${item.width}×${item.height}` : null].filter(Boolean).join(' · ')} />}
                  {item.audio_codec  && <MetaRow label="Audio"    value={item.audio_codec?.toUpperCase()} />}
                </tbody>
              </table>

              <div className={styles.actionRow}>
                {item.type !== 'series' && (
                  <button
                    className={`primary ${styles.playBtn}`}
                    onClick={() => setPlaying({ mediaItemId: item.id, title: item.title })}
                  >
                    ▶ Play
                  </button>
                )}
                <button
                  className={`${styles.favoriteBtn} ${isFavorite ? styles.favoriteBtnActive : ''}`}
                  onClick={toggleFavorite}
                  title={isFavorite ? 'Remove from favorites' : 'Add to favorites'}
                >
                  {isFavorite ? '★' : '☆'}
                </button>
                {user.role === 'admin' && (
                  <button
                    className={styles.rematchBtn}
                    onClick={() => setShowRematch(true)}
                  >
                    Fix Match
                  </button>
                )}
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* ── Series episode browser ─────────────────────────────────────── */}
      {item.type === 'series' && seasons.length > 0 && (
        <div className={styles.episodeSection}>
          <h2 className={styles.castHeading}>Episodes</h2>
          {seasons.map(season => (
            <div key={season} className={styles.seasonGroup}>
              <button
                className={styles.seasonHeader}
                onClick={() => setOpenSeason(s => s === season ? null : season)}
              >
                <span>Season {season}</span>
                <span className={styles.seasonChevron}>
                  {openSeason === season ? '▲' : '▼'}
                </span>
                <span className={styles.seasonCount}>
                  {episodesBySeason[season]?.length ?? 0} episodes
                </span>
              </button>

              {openSeason === season && (
                <div className={styles.episodeList}>
                  {(episodesBySeason[season] ?? []).map(ep => (
                    <div key={ep.id} className={styles.episodeRow}>
                      <span className={styles.epNumber}>
                        S{pad(season)}E{pad(ep.episode_number)}
                      </span>
                      <div className={styles.epInfo}>
                        <p className={styles.epTitle}>{ep.title ?? `Episode ${ep.episode_number}`}</p>
                        {ep.duration_secs && (
                          <p className={styles.epMeta}>{fmt(ep.duration_secs)}</p>
                        )}
                      </div>
                      <button
                        className={`primary ${styles.epPlayBtn}`}
                        onClick={() => setPlaying({
                          episodeId: ep.id,
                          title: `${item.title} · S${pad(season)}E${pad(ep.episode_number)}${ep.title ? ` — ${ep.title}` : ''}`
                        })}
                      >
                        ▶
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {/* ── Cast & Crew ────────────────────────────────────────────────── */}
      {cast.length > 0 && (
        <div className={styles.castSection}>
          <h2 className={styles.castHeading}>Cast &amp; Crew</h2>
          <div className={styles.castRow}>
            {cast.map(person => (
              <button
                key={person.id}
                className={styles.castCard}
                onClick={() => navigate(`/person/${person.id}`)}
                title={person.name}
              >
                {person.profile_url
                  ? <img className={styles.castPhoto} src={person.profile_url} alt={person.name} loading="lazy" />
                  : <div className={styles.castPhotoPlaceholder}>{person.name[0]}</div>
                }
                <p className={styles.castName}>{person.name}</p>
                {person.character && <p className={styles.castRole}>{person.character}</p>}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>

    {/* Portal renders the dialog at document.body — avoids stacking-context
        and event-propagation issues from the deeply nested hero section. */}
    {showRematch && createPortal(
      <RematchDialog
        item={item}
        onDone={handleRematchDone}
        onClose={() => setShowRematch(false)}
      />,
      document.body
    )}
  </>
  )
}

function RematchDialog({ item, onDone, onClose }) {
  const [query, setQuery]       = useState(item.title)
  const [results, setResults]   = useState([])
  const [loading, setLoading]   = useState(false)
  const [applying, setApplying] = useState(null)
  const [error, setError]       = useState(null)

  async function search(e) {
    e.preventDefault()
    if (!query.trim()) return
    setLoading(true)
    setError(null)
    try {
      const r = await api.get(`/media/${item.id}/rematch`, { params: { query: query.trim() } })
      setResults(r.data)
    } catch {
      setError('Search failed — check your TMDB API key.')
    } finally {
      setLoading(false)
    }
  }

  async function applyMatch(tmdbId) {
    setApplying(tmdbId)
    setError(null)
    try {
      const r = await api.post(`/media/${item.id}/rematch`, { tmdb_id: tmdbId })
      onDone(r.data)
    } catch {
      setError('Could not apply match — try again.')
      setApplying(null)
    }
  }

  return (
    <div className={styles.rematchOverlay} onClick={e => e.target === e.currentTarget && onClose()}>
      <div className={styles.rematchDialog}>
        <div className={styles.rematchHeader}>
          <h3>Fix Match — {item.title}</h3>
          <button className="ghost" onClick={onClose}>✕</button>
        </div>
        <form onSubmit={search} className={styles.rematchSearch}>
          <input
            className={styles.rematchInput}
            value={query}
            onChange={e => setQuery(e.target.value)}
            placeholder="Search TMDB…"
            autoFocus
          />
          <button className="primary" type="submit" disabled={loading}>
            {loading ? '…' : 'Search'}
          </button>
        </form>
        {error && <p className={styles.rematchError}>{error}</p>}
        {results.length > 0 && (
          <div className={styles.rematchGrid}>
            {results.map(r => (
              <button
                key={r.tmdb_id}
                className={styles.rematchCard}
                onClick={() => applyMatch(r.tmdb_id)}
                disabled={applying !== null}
              >
                <div className={styles.rematchPoster}>
                  {r.poster_url
                    ? <img src={r.poster_url} alt={r.title} loading="lazy" />
                    : <div className={styles.rematchPosterPlaceholder}>{r.title[0]}</div>
                  }
                  {applying === r.tmdb_id && (
                    <div className={styles.rematchApplying}>Applying…</div>
                  )}
                </div>
                <p className={styles.rematchTitle}>{r.title}</p>
                {r.year && <p className={styles.rematchYear}>{r.year}</p>}
                {r.rating > 0 && <p className={styles.rematchRating}>★ {Number(r.rating).toFixed(1)}</p>}
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

function MetaRow({ label, value }) {
  return (
    <tr>
      <td className={styles.metaLabel}>{label}</td>
      <td className={styles.metaValue}>{value}</td>
    </tr>
  )
}
