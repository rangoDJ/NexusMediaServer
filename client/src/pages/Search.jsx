import { useEffect, useState } from 'react'
import { useSearchParams, useNavigate } from 'react-router-dom'
import { api } from '../api/client.js'
import styles from './Search.module.css'

export default function Search() {
  const [params] = useSearchParams()
  const navigate = useNavigate()
  const q = params.get('q') ?? ''
  const [results, setResults] = useState(null)
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    if (q.trim().length < 2) {
      setResults({ movies: [], series: [], episodes: [], people: [] })
      return
    }
    let cancelled = false
    setLoading(true)
    api.get('/search', { params: { q } })
      .then(r => { if (!cancelled) setResults(r.data) })
      .catch(() => { if (!cancelled) setResults({ movies: [], series: [], episodes: [], people: [] }) })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [q])

  if (!q.trim()) {
    return (
      <main className={styles.main}>
        <p className={styles.hint}>Type a query in the search box above.</p>
      </main>
    )
  }

  if (loading || !results) {
    return (
      <main className={styles.main}>
        <h1 className={styles.heading}>Searching for "{q}"…</h1>
      </main>
    )
  }

  const totalCount = results.movies.length + results.series.length +
                     results.episodes.length + results.people.length

  if (totalCount === 0) {
    return (
      <main className={styles.main}>
        <h1 className={styles.heading}>No results for "{q}"</h1>
        <p className={styles.hint}>Try a different title, episode, or actor name.</p>
      </main>
    )
  }

  return (
    <main className={styles.main}>
      <h1 className={styles.heading}>Results for "{q}"</h1>

      {results.movies.length > 0 && (
        <Section title="Movies">
          {results.movies.map(m => (
            <PosterCard
              key={m.id}
              title={m.title}
              subtitle={m.year}
              poster={m.poster_url}
              onClick={() => navigate(`/movie/${m.id}`)}
            />
          ))}
        </Section>
      )}

      {results.series.length > 0 && (
        <Section title="Series">
          {results.series.map(s => (
            <PosterCard
              key={s.id}
              title={s.title}
              subtitle={s.year}
              poster={s.poster_url}
              badge="SERIES"
              onClick={() => navigate(`/movie/${s.id}`)}
            />
          ))}
        </Section>
      )}

      {results.episodes.length > 0 && (
        <Section title="Episodes">
          {results.episodes.map(e => (
            <PosterCard
              key={e.id}
              title={e.title ?? `Episode ${e.episode_number}`}
              subtitle={`${e.series_title} · S${pad(e.season_number)}E${pad(e.episode_number)}`}
              poster={e.poster_url}
              onClick={() => navigate(`/movie/${e.series_id}`)}
            />
          ))}
        </Section>
      )}

      {results.people.length > 0 && (
        <Section title="People">
          {results.people.map(p => (
            <PosterCard
              key={p.id}
              title={p.name}
              poster={p.profile_url}
              round
              onClick={() => navigate(`/person/${p.id}`)}
            />
          ))}
        </Section>
      )}
    </main>
  )
}

function pad(n) { return String(n).padStart(2, '0') }

function Section({ title, children }) {
  return (
    <section className={styles.section}>
      <h2 className={styles.sectionTitle}>{title}</h2>
      <div className={styles.grid}>{children}</div>
    </section>
  )
}

function PosterCard({ title, subtitle, poster, badge, round, onClick }) {
  return (
    <button className={styles.card} onClick={onClick} title={title}>
      <div className={`${styles.poster} ${round ? styles.round : ''}`}>
        {poster
          ? <img src={poster} alt={title} loading="lazy" />
          : <div className={styles.posterPlaceholder}>{title[0]?.toUpperCase()}</div>
        }
        {badge && <div className={styles.badge}>{badge}</div>}
      </div>
      <p className={styles.cardTitle}>{title}</p>
      {subtitle && <p className={styles.cardSub}>{subtitle}</p>}
    </button>
  )
}
