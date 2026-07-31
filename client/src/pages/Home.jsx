import { useState, useEffect, useMemo } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { api } from '../api/client.js'
import MediaCard, { MediaCardSkeleton } from '../components/MediaCard.jsx'
import Row from '../components/Row.jsx'
import styles from './Home.module.css'

// Library types jellyfin-web's own recentlyAdded.ts excludes from "Latest"
// rows — playlists/boxsets/channels aren't browsable content shelves the way
// a movie or series library is, and 'folders' is a raw-filesystem view with
// no consistent item shape to card-ify. Nexus's library types are currently
// just movies/series/tv (see routes/libraries.js), so this is a no-op today
// — kept so a future library type doesn't silently need to rediscover this.
const EXCLUDED_LATEST_TYPES = new Set(['playlists', 'boxsets', 'channels', 'folders'])

function pad(n) { return String(n).padStart(2, '0') }

/**
 * Home.
 *
 * Stacked, largely-fixed sections rather than a hero banner — matching
 * jellyfin-web's actual home screen (components/homesections/homesections.js),
 * which has NO spotlight/carousel by default. Default section order there is
 * library tiles, Resume, next-up, then one "Latest from [Library]" row per
 * library (recentlyAdded.ts genuinely renders one row per view, not a single
 * merged row) — reproduced here, minus the audio/book/live-tv resume rows
 * Nexus has no equivalent content for.
 *
 * Jellyfin's own home sections are also user-configurable (up to 10
 * reorderable slots, homesection0..9). That per-user ordering UI is out of
 * scope here — this ships Jellyfin's own *default* order as a fixed one.
 *
 * Favorites is a separate TAB in Jellyfin, not a home section (see
 * hometab.js's getTabs()) — reflected here as a `?favorites=1` view that
 * replaces the sections entirely rather than being one more row among them.
 */
export default function Home() {
  const [searchParams] = useSearchParams()
  const showFavorites = searchParams.get('favorites') === '1'

  const [libraries, setLibraries]             = useState([])
  const [continueWatching, setContinueWatching] = useState([])
  const [nextUp, setNextUp]                   = useState([])
  const [recentByLibrary, setRecentByLibrary] = useState({})
  const [favorites, setFavorites]             = useState([])
  const [loading, setLoading]                 = useState(true)
  const navigate = useNavigate()
  const user = JSON.parse(localStorage.getItem('nexus_user') || '{}')

  useEffect(() => {
    let cancelled = false

    async function load() {
      try {
        const [libsRes, cwRes, nextUpRes, favRes] = await Promise.all([
          api.get('/libraries').catch(() => ({ data: [] })),
          api.get('/media/continue-watching').catch(() => ({ data: [] })),
          api.get('/media/next-up').catch(() => ({ data: [] })),
          api.get('/media/favorites').catch(() => ({ data: [] })),
        ])
        if (cancelled) return

        const libs = libsRes.data.filter(l => !EXCLUDED_LATEST_TYPES.has(l.type))
        setLibraries(libs)
        setContinueWatching(cwRes.data)
        setNextUp(nextUpRes.data)
        setFavorites(favRes.data)

        const results = await Promise.all(
          libs.map(lib =>
            api.get('/media', { params: { library_id: lib.id, sort: 'recently_added', limit: 16 } })
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

  if (showFavorites) {
    return (
      <main className={styles.main}>
        {favorites.length > 0 ? (
          <div className={styles.grid}>
            {favorites.map(item => <MediaCard key={item.id} item={item} />)}
          </div>
        ) : (
          <div className={styles.empty}><p>No favorites yet.</p></div>
        )}
      </main>
    )
  }

  return (
    <main className={styles.main}>
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

      {libraries.map(lib => {
        const recent = recentByLibrary[lib.id]
        if (!recent?.length) return null
        return (
          <Row key={lib.id} title={`Latest ${lib.name}`} linkTo={`/library/${lib.id}`}>
            {recent.map(item => (
              <MediaCard key={item.id} item={item} className={styles.slot} />
            ))}
          </Row>
        )
      })}
    </main>
  )
}

/**
 * An episode in progress. Uses the wide card's shape but carries episode
 * numbering and its series' blurhash, since episodes have no artwork of
 * their own (see migration 024/025).
 */
function NextUpCard({ item }) {
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
        blurhash: item.blurhash,
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
