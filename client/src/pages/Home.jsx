import { useState, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { api } from '../api/client.js'
import styles from './Home.module.css'

export default function Home() {
  const [libraries, setLibraries] = useState([])
  const [mediaByLibrary, setMediaByLibrary] = useState({})
  const [continueWatching, setContinueWatching] = useState([])
  const navigate = useNavigate()
  const user = JSON.parse(localStorage.getItem('nexus_user') || '{}')

  useEffect(() => {
    api.get('/libraries').then(r => {
      const libs = r.data
      setLibraries(libs)
      libs.forEach(lib => {
        api.get('/media', { params: { library_id: lib.id, limit: 40 } }).then(mr => {
          setMediaByLibrary(prev => ({ ...prev, [lib.id]: mr.data }))
        })
      })
    })
    api.get('/media/continue-watching')
      .then(r => setContinueWatching(r.data))
      .catch(() => {})
  }, [])

  function signOut() {
    localStorage.removeItem('nexus_token')
    localStorage.removeItem('nexus_refresh_token')
    localStorage.removeItem('nexus_user')
    navigate('/login')
  }

  const allEmpty = libraries.length > 0 &&
    libraries.every(lib => !(mediaByLibrary[lib.id]?.length))

  return (
    <div className={styles.page}>
      <header className={styles.header}>
        <span className={styles.logo}>Nexus</span>
        <nav className={styles.nav}>
          {user.role === 'admin' && (
            <button className="ghost" onClick={() => navigate('/settings')}>Settings</button>
          )}
          <button className="ghost" onClick={signOut}>Sign out</button>
        </nav>
      </header>

      <main className={styles.main}>
        {continueWatching.length > 0 && (
          <Section title="Continue Watching">
            {continueWatching.map(item => (
              <MediaCard key={item.id} item={item} showProgress />
            ))}
          </Section>
        )}

        {libraries.map(lib => {
          const items = mediaByLibrary[lib.id]
          if (!items?.length) return null
          return (
            <Section key={lib.id} title={lib.name}>
              {items.map(item => (
                <MediaCard key={item.id} item={item} />
              ))}
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
    </div>
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
