import { useState, useEffect } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
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
  const [item, setItem]           = useState(null)
  const [playing, setPlaying]     = useState(null) // { episodeId?, mediaItemId?, title }
  const [openSeason, setOpenSeason] = useState(null)
  const [error, setError]         = useState(null)

  useEffect(() => {
    api.get(`/media/${id}`)
      .then(r => {
        setItem(r.data)
        // Default to first season open for series
        if (r.data.type === 'series' && r.data.episodes?.length) {
          setOpenSeason(r.data.episodes[0].season_number)
        }
      })
      .catch(() => setError('Could not load this title.'))
  }, [id])

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
        <div style={{ flex: 1, height: 0 }}>
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

              {item.type !== 'series' && (
                <button
                  className={`primary ${styles.playBtn}`}
                  onClick={() => setPlaying({ mediaItemId: item.id, title: item.title })}
                >
                  ▶ Play
                </button>
              )}
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
