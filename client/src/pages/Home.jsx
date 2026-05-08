import { useState, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { api } from '../api/client.js'
import styles from './Home.module.css'

const POPULAR_GENRES = ['Action', 'Comedy', 'Drama', 'Sci-Fi', 'Horror', 'Thriller', 'Animation', 'Documentary']

export default function Home() {
  const [libraries, setLibraries]             = useState([])
  const [continueWatching, setContinueWatching] = useState([])
  const [recentByLibrary, setRecentByLibrary] = useState({})
  const [randomByLibrary, setRandomByLibrary] = useState({})
  const [genres, setGenres]                   = useState([])
  const [byGenre, setByGenre]                 = useState({})
  const [loading, setLoading]                 = useState(true)
  const navigate = useNavigate()
  const user = JSON.parse(localStorage.getItem('nexus_user') || '{}')

  useEffect(() => {
    let cancelled = false

    async function load() {
      try {
        const [libsRes, cwRes, genresRes] = await Promise.all([
          api.get('/libraries'),
          api.get('/media/continue-watching').catch(() => ({ data: [] })),
          api.get('/media/genres').catch(() => ({ data: [] })),
        ])
        if (cancelled) return

        const libs = libsRes.data
        setLibraries(libs)
        setContinueWatching(cwRes.data)

        // Pick the most popular genres that actually exist in this library
        const presentPopular = POPULAR_GENRES.filter(g => genresRes.data.includes(g)).slice(0, 4)
        setGenres(presentPopular)

        // Per-library recently-added + random rows in parallel
        const perLibPromises = libs.flatMap(lib => [
          api.get('/media', { params: { library_id: lib.id, sort: 'recently_added', limit: 20 } })
             .then(r => ({ kind: 'recent', libId: lib.id, data: r.data })),
          api.get('/media', { params: { library_id: lib.id, sort: 'random', limit: 20 } })
             .then(r => ({ kind: 'random', libId: lib.id, data: r.data })),
        ])

        const genrePromises = presentPopular.map(g =>
          api.get('/media', { params: { genre: g, sort: 'rating', limit: 20 } })
             .then(r => ({ kind: 'genre', genre: g, data: r.data }))
        )

        const results = await Promise.all([...perLibPromises, ...genrePromises])
        if (cancelled) return

        const recent = {}, random = {}, byG = {}
        for (const r of results) {
          if (r.kind === 'recent') recent[r.libId] = r.data
          else if (r.kind === 'random') random[r.libId] = r.data
          else if (r.kind === 'genre') byG[r.genre] = r.data
        }
        setRecentByLibrary(recent)
        setRandomByLibrary(random)
        setByGenre(byG)
      } finally {
        if (!cancelled) setLoading(false)
      }
    }

    load()
    return () => { cancelled = true }
  }, [])

  const allEmpty = !loading && libraries.length > 0 &&
    libraries.every(lib => !(recentByLibrary[lib.id]?.length))

  if (loading) return <SkeletonHome />

  return (
    <main className={styles.main}>
      {continueWatching.length > 0 && (
        <Section title="Continue Watching">
          {continueWatching.map(item => (
            <MediaCard key={item.id} item={item} showProgress />
          ))}
        </Section>
      )}

      {libraries.map(lib => {
        const recent = recentByLibrary[lib.id]
        if (!recent?.length) return null
        return (
          <Section key={`recent-${lib.id}`} title={`Recently Added · ${lib.name}`}>
            {recent.map(item => <MediaCard key={item.id} item={item} />)}
          </Section>
        )
      })}

      {libraries.map(lib => {
        const random = randomByLibrary[lib.id]
        if (!random?.length) return null
        return (
          <Section key={`random-${lib.id}`} title={`Random Picks · ${lib.name}`}>
            {random.map(item => <MediaCard key={item.id} item={item} />)}
          </Section>
        )
      })}

      {genres.map(g => {
        const items = byGenre[g]
        if (!items?.length) return null
        return (
          <Section key={`genre-${g}`} title={`Top ${g}`}>
            {items.map(item => <MediaCard key={item.id} item={item} />)}
          </Section>
        )
      })}

      {(libraries.length === 0 || allEmpty) && (
        <div className={styles.empty}>
          <p>No media found.</p>
          {user.role === 'admin' && (
            <button className="primary" onClick={() => navigate('/settings')}>
              Add a library in Settings
            </button>
          )}
        </div>
      )}
    </main>
  )
}

function Section({ title, children }) {
  return (
    <section className={styles.section}>
      <h2 className={styles.sectionTitle}>{title}</h2>
      <div className={styles.row}>{children}</div>
    </section>
  )
}

function MediaCard({ item, showProgress }) {
  const navigate = useNavigate()
  const pct = showProgress && item.duration_secs > 0
    ? Math.min(100, Math.round((item.position_secs / item.duration_secs) * 100))
    : 0

  return (
    <button
      className={styles.card}
      onClick={() => navigate(`/movie/${item.id}`)}
      title={item.title}
    >
      <div className={styles.poster}>
        {item.poster_url
          ? <img src={item.poster_url} alt={item.title} loading="lazy" />
          : <div className={styles.posterPlaceholder}>{item.title[0]?.toUpperCase()}</div>
        }
        {pct > 0 && (
          <div className={styles.progressBar}>
            <div className={styles.progressFill} style={{ width: `${pct}%` }} />
          </div>
        )}
        {item.type === 'series' && <div className={styles.seriesBadge}>SERIES</div>}
      </div>
      <p className={styles.cardTitle}>{item.title}</p>
      {item.year && <p className={styles.cardSub}>{item.year}</p>}
    </button>
  )
}

// Skeleton loader — keeps the row scaffolding so the layout doesn't shift in
function SkeletonHome() {
  return (
    <main className={styles.main}>
      {[0, 1, 2].map(i => (
        <section key={i} className={styles.section}>
          <div className={`${styles.sectionTitle} ${styles.skeleton}`} style={{ width: 220, height: 22 }} />
          <div className={styles.row}>
            {Array.from({ length: 8 }).map((_, j) => (
              <div key={j} className={`${styles.card} ${styles.skelCard}`}>
                <div className={`${styles.poster} ${styles.skeleton}`} />
                <div className={`${styles.skeleton} ${styles.skelLine}`} style={{ width: 120 }} />
                <div className={`${styles.skeleton} ${styles.skelLine}`} style={{ width: 50, marginTop: 4 }} />
              </div>
            ))}
          </div>
        </section>
      ))}
    </main>
  )
}
