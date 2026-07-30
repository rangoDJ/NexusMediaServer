import { useState, useEffect, useMemo } from 'react'
import { useNavigate } from 'react-router-dom'
import { api } from '../api/client.js'
import MediaCard, { MediaCardSkeleton } from '../components/MediaCard.jsx'
import Row from '../components/Row.jsx'
import Spotlight from '../components/Spotlight.jsx'
import styles from './Home.module.css'

const POPULAR_GENRES = ['Action', 'Comedy', 'Drama', 'Sci-Fi', 'Horror', 'Thriller', 'Animation', 'Documentary']
const SPOTLIGHT_COUNT = 5

function pad(n) { return String(n).padStart(2, '0') }

export default function Home() {
  const [libraries, setLibraries]             = useState([])
  const [spotlight, setSpotlight]             = useState([])
  const [continueWatching, setContinueWatching] = useState([])
  const [nextUp, setNextUp]                   = useState([])
  const [favorites, setFavorites]             = useState([])
  const [recentByLibrary, setRecentByLibrary] = useState({})
  const [genres, setGenres]                   = useState([])
  const [activeGenre, setActiveGenre]         = useState(null)
  const [genreItems, setGenreItems]           = useState([])
  const [genreLoading, setGenreLoading]       = useState(false)
  const [loading, setLoading]                 = useState(true)
  const navigate = useNavigate()
  const user = JSON.parse(localStorage.getItem('nexus_user') || '{}')

  useEffect(() => {
    let cancelled = false

    async function load() {
      try {
        const [libsRes, cwRes, genresRes, nextUpRes, favRes, spotRes] = await Promise.all([
          api.get('/libraries').catch(() => ({ data: [] })),
          api.get('/media/continue-watching').catch(() => ({ data: [] })),
          api.get('/media/genres').catch(() => ({ data: [] })),
          api.get('/media/next-up').catch(() => ({ data: [] })),
          api.get('/media/favorites').catch(() => ({ data: [] })),
          // Highest-rated titles make the most defensible "featured" set
          // without a curation concept in the schema.
          api.get('/media', { params: { sort: 'rating', limit: SPOTLIGHT_COUNT } })
             .catch(() => ({ data: [] })),
        ])
        if (cancelled) return

        const libs = libsRes.data
        setLibraries(libs)
        setContinueWatching(cwRes.data)
        setNextUp(nextUpRes.data)
        setFavorites(favRes.data)
        setSpotlight(spotRes.data.filter(i => i.backdrop_url || i.poster_url))
        setGenres(POPULAR_GENRES.filter(g => genresRes.data.includes(g)).slice(0, 8))

        // One "recently added" row per library. The old page also rendered a
        // "random picks" row per library and a row per genre, which is how it
        // ended up with ten interchangeable strips; genres are a filter now.
        const results = await Promise.all(
          libs.map(lib =>
            api.get('/media', { params: { library_id: lib.id, sort: 'recently_added', limit: 20 } })
               .then(r => ({ libId: lib.id, data: r.data }))
               .catch(() => ({ libId: lib.id, data: [] }))
          )
        )
        if (cancelled) return
        setRecentByLibrary(Object.fromEntries(results.map(r => [r.libId, r.data])))
      } finally {
        if (!cancelled) setLoading(false)
      }
    }

    load()
    return () => { cancelled = true }
  }, [])

  // Genre selection filters in place rather than adding another permanent row.
  useEffect(() => {
    if (!activeGenre) { setGenreItems([]); return }
    let cancelled = false
    setGenreLoading(true)
    api.get('/media', { params: { genre: activeGenre, sort: 'rating', limit: 40 } })
      .then(r => { if (!cancelled) setGenreItems(r.data) })
      .catch(() => { if (!cancelled) setGenreItems([]) })
      .finally(() => { if (!cancelled) setGenreLoading(false) })
    return () => { cancelled = true }
  }, [activeGenre])

  const isEmpty = useMemo(
    () => !loading && !libraries.some(lib => recentByLibrary[lib.id]?.length),
    [loading, libraries, recentByLibrary]
  )

  if (loading) return <SkeletonHome />

  if (isEmpty) {
    return (
      <main className={styles.main}>
        <div className={styles.empty}>
          <p>No media found.</p>
          {user.role === 'admin' && (
            <button className="primary" onClick={() => navigate('/settings')}>
              Add a library in Settings
            </button>
          )}
        </div>
      </main>
    )
  }

  return (
    <main className={styles.main}>
      <Spotlight items={spotlight} />

      {genres.length > 0 && (
        <div className={styles.chips} role="group" aria-label="Filter by genre">
          <button
            className={`${styles.chip} ${!activeGenre ? styles.chipOn : ''}`}
            onClick={() => setActiveGenre(null)}
            aria-pressed={!activeGenre}
          >
            All
          </button>
          {genres.map(g => (
            <button
              key={g}
              className={`${styles.chip} ${activeGenre === g ? styles.chipOn : ''}`}
              onClick={() => setActiveGenre(activeGenre === g ? null : g)}
              aria-pressed={activeGenre === g}
            >
              {g}
            </button>
          ))}
        </div>
      )}

      {/* A genre selection replaces the rows rather than sitting above them —
          the point of filtering is to narrow what's on screen. */}
      {activeGenre ? (
        <Row title={activeGenre} eyebrow={`${genreItems.length} titles`}>
          {genreLoading
            ? Array.from({ length: 8 }).map((_, i) => (
                <MediaCardSkeleton key={i} className={styles.slot} />
              ))
            : genreItems.map(item => (
                <MediaCard key={item.id} item={item} className={styles.slot} />
              ))
          }
        </Row>
      ) : (
        <>
          {continueWatching.length > 0 && (
            <Row title="Continue Watching" eyebrow="in progress">
              {continueWatching.map(item => (
                <MediaCard key={item.id} item={item} showProgress variant="wide" className={styles.slotWide} />
              ))}
            </Row>
          )}

          {nextUp.length > 0 && (
            <Row title="Next Up" eyebrow="new episodes">
              {nextUp.map(item => <NextUpCard key={item.episode_id} item={item} />)}
            </Row>
          )}

          {favorites.length > 0 && (
            <Row title="My Favorites" eyebrow="starred">
              {favorites.map(item => (
                <MediaCard key={item.id} item={item} className={styles.slot} />
              ))}
            </Row>
          )}

          {libraries.map(lib => {
            const recent = recentByLibrary[lib.id]
            if (!recent?.length) return null
            return (
              <Row key={lib.id} title={lib.name} eyebrow="recently added">
                {recent.map(item => (
                  <MediaCard key={item.id} item={item} className={styles.slot} />
                ))}
              </Row>
            )
          })}
        </>
      )}
    </main>
  )
}

/**
 * An episode in progress. Uses the wide card's shape but carries episode
 * numbering and its series' artwork color, since episodes have no artwork of
 * their own (see migration 024).
 */
function NextUpCard({ item }) {
  const navigate = useNavigate()
  const pct = item.duration_secs > 0
    ? Math.min(100, Math.round((item.position_secs / item.duration_secs) * 100))
    : 0
  const label = `S${pad(item.season_number)}E${pad(item.episode_number)}`

  return (
    <MediaCard
      variant="wide"
      className={styles.slotWide}
      showProgress={pct > 0}
      item={{
        id: item.series_id,
        type: 'series',
        title: item.series_title,
        poster_url: item.poster_url,
        dominant_color: item.dominant_color,
        duration_secs: item.duration_secs,
        position_secs: item.position_secs,
        // Surfaced as the card's metadata line in place of a year.
        year: `${label}${item.episode_title ? ` · ${item.episode_title}` : ''}`,
      }}
    />
  )
}

function SkeletonHome() {
  return (
    <main className={styles.main}>
      <div className={styles.spotlightSkeleton} />
      {[0, 1, 2].map(i => (
        <section key={i} className={styles.skelRow}>
          <div className={styles.skelTitle} />
          <div className={styles.skelStrip}>
            {Array.from({ length: 8 }).map((_, j) => (
              <MediaCardSkeleton key={j} className={styles.slot} />
            ))}
          </div>
        </section>
      ))}
    </main>
  )
}
