import { useEffect, useState } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { api } from '../api/client.js'
import styles from './Person.module.css'

export default function Person() {
  const { tmdbId } = useParams()
  const navigate = useNavigate()
  const [person, setPerson] = useState(null)
  const [error, setError]   = useState(null)

  useEffect(() => {
    api.get(`/people/${tmdbId}`)
      .then(r => setPerson(r.data))
      .catch(() => setError('Could not load this person.'))
  }, [tmdbId])

  if (error) {
    return (
      <div className={styles.errorPage}>
        <button className="ghost" onClick={() => navigate(-1)}>&#8592; Back</button>
        <p>{error}</p>
      </div>
    )
  }

  if (!person) return <div className={styles.loading}>Loading…</div>

  return (
    <main className={styles.main}>
      <button className={styles.backBtn} onClick={() => navigate(-1)}>&#8592; Back</button>

      <header className={styles.header}>
        <div className={styles.photoWrap}>
          {person.profile_url
            ? <img className={styles.photo} src={person.profile_url} alt={person.name} />
            : <div className={styles.photoPlaceholder}>{person.name[0]?.toUpperCase()}</div>
          }
        </div>
        <div className={styles.info}>
          <h1 className={styles.name}>{person.name}</h1>
          <p className={styles.subline}>
            {person.filmography.length} title{person.filmography.length === 1 ? '' : 's'} in your library
          </p>
        </div>
      </header>

      <h2 className={styles.filmoHeading}>Filmography</h2>
      <div className={styles.grid}>
        {person.filmography.map(item => (
          <button
            key={item.id}
            className={styles.card}
            onClick={() => navigate(`/movie/${item.id}`)}
            title={item.title}
          >
            <div className={styles.poster}>
              {item.poster_url
                ? <img src={item.poster_url} alt={item.title} loading="lazy" />
                : <div className={styles.posterPlaceholder}>{item.title[0]?.toUpperCase()}</div>
              }
              {item.type === 'series' && <div className={styles.badge}>SERIES</div>}
            </div>
            <p className={styles.cardTitle}>{item.title}</p>
            <p className={styles.cardSub}>
              {item.year && <span>{item.year}</span>}
              {item.character && <span className={styles.character}>· {item.character}</span>}
            </p>
          </button>
        ))}
      </div>
    </main>
  )
}
