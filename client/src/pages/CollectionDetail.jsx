import { useState, useEffect } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { api } from '../api/client.js'
import styles from './CollectionDetail.module.css'

function fmt(secs) {
  if (!secs) return null
  const h = Math.floor(secs / 3600)
  const m = Math.floor((secs % 3600) / 60)
  return h > 0 ? `${h}h ${m}m` : `${m}m`
}

export default function CollectionDetail() {
  const { id } = useParams()
  const navigate = useNavigate()
  const [col, setCol] = useState(null)
  const [error, setError] = useState(null)

  useEffect(() => {
    api.get(`/collections/${id}`)
      .then(r => setCol(r.data))
      .catch(() => setError('Collection not found.'))
  }, [id])

  if (error) {
    return (
      <div className={styles.main}>
        <button className={styles.backBtn} onClick={() => navigate('/collections')}>← Collections</button>
        <p className={styles.error}>{error}</p>
      </div>
    )
  }

  if (!col) return null

  return (
    <div className={styles.main}>
      {/* Backdrop hero */}
      {col.backdrop_url && (
        <div className={styles.hero} style={{ backgroundImage: `url(${col.backdrop_url})` }}>
          <div className={styles.heroOverlay} />
        </div>
      )}

      <div className={styles.content}>
        <button className={styles.backBtn} onClick={() => navigate('/collections')}>← Collections</button>

        <div className={styles.header}>
          {col.poster_url && (
            <img className={styles.poster} src={col.poster_url} alt={col.name} />
          )}
          <div className={styles.meta}>
            <h1 className={styles.title}>{col.name}</h1>
            <div className={styles.subline}>{col.movies.length} film{col.movies.length !== 1 ? 's' : ''}</div>
            {col.overview && <p className={styles.overview}>{col.overview}</p>}
          </div>
        </div>

        <div className={styles.grid}>
          {col.movies.map(movie => (
            <button
              key={movie.id}
              className={styles.card}
              onClick={() => navigate(`/movie/${movie.id}`)}
            >
              <div className={styles.cardPoster}>
                {movie.poster_url
                  ? <img src={movie.poster_url} alt={movie.title} loading="lazy" />
                  : <div className={styles.cardPosterPlaceholder}>{movie.title[0]}</div>
                }
              </div>
              <div className={styles.cardTitle}>{movie.title}</div>
              <div className={styles.cardSub}>
                {[movie.year, fmt(movie.duration_secs)].filter(Boolean).join(' · ')}
              </div>
            </button>
          ))}
        </div>
      </div>
    </div>
  )
}
