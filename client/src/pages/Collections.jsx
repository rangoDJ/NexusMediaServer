import { useState, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { api } from '../api/client.js'
import styles from './Collections.module.css'

export default function Collections() {
  const [collections, setCollections] = useState([])
  const [loading, setLoading]         = useState(true)
  const navigate = useNavigate()

  useEffect(() => {
    api.get('/collections')
      .then(r => setCollections(r.data))
      .catch(() => {})
      .finally(() => setLoading(false))
  }, [])

  if (loading) {
    return (
      <div className={styles.main}>
        <h1 className={styles.title}>Collections</h1>
        <div className={styles.grid}>
          {Array.from({ length: 12 }).map((_, i) => (
            <div key={i} className={styles.card}>
              <div className={`${styles.poster} ${styles.skeleton}`} />
              <div className={`${styles.skelLine} ${styles.skeleton}`} style={{ width: '70%' }} />
            </div>
          ))}
        </div>
      </div>
    )
  }

  return (
    <div className={styles.main}>
      <h1 className={styles.title}>Collections</h1>
      {collections.length === 0 ? (
        <div className={styles.empty}>
          No collections found. Collections are built automatically from TMDB data when movies are scanned.
        </div>
      ) : (
        <div className={styles.grid}>
          {collections.map(col => (
            <button
              key={col.id}
              className={styles.card}
              onClick={() => navigate(`/collections/${col.id}`)}
            >
              <div className={styles.poster}>
                {col.poster_url
                  ? <img src={col.poster_url} alt={col.name} loading="lazy" />
                  : <div className={styles.posterPlaceholder}>{col.name[0]}</div>
                }
                <span className={styles.badge}>{col.movie_count}</span>
              </div>
              <div className={styles.cardTitle}>{col.name}</div>
              <div className={styles.cardSub}>{col.movie_count} film{col.movie_count !== 1 ? 's' : ''}</div>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
