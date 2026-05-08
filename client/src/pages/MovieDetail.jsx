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

export default function MovieDetail() {
  const { id } = useParams()
  const navigate = useNavigate()
  const [item, setItem]       = useState(null)
  const [playing, setPlaying] = useState(false)
  const [error, setError]     = useState(null)

  useEffect(() => {
    api.get(`/media/${id}`)
      .then(r => setItem(r.data))
      .catch(() => setError('Could not load this title.'))
  }, [id])

  if (playing && item) {
    return (
      <div className={styles.playerOverlay}>
        <div className={styles.playerBar}>
          <button className="ghost" onClick={() => setPlaying(false)}>&#8592; Back</button>
          <span className={styles.playerTitle}>{item.title}</span>
        </div>
        <Player mediaItemId={item.id} />
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
                {item.duration_secs && <span>{fmt(item.duration_secs)}</span>}
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
                <button className={`primary ${styles.playBtn}`} onClick={() => setPlaying(true)}>
                  ▶ Play
                </button>
              )}
            </div>
          </div>
        </div>
      </div>

      {/* ── Cast & Crew ────────────────────────────────────────────────── */}
      {cast.length > 0 && (
        <div className={styles.castSection}>
          <h2 className={styles.castHeading}>Cast &amp; Crew</h2>
          <div className={styles.castRow}>
            {cast.map(person => (
              <div key={person.id} className={styles.castCard}>
                {person.profile_url
                  ? <img className={styles.castPhoto} src={person.profile_url} alt={person.name} loading="lazy" />
                  : <div className={styles.castPhotoPlaceholder}>{person.name[0]}</div>
                }
                <p className={styles.castName}>{person.name}</p>
                {person.character && <p className={styles.castRole}>{person.character}</p>}
              </div>
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
