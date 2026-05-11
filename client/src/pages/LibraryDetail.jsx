import { useEffect, useState } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { api } from '../api/client.js'
import styles from './LibraryDetail.module.css'

const SORT_OPTIONS = [
  { value: 'recently_added', label: 'Recently Added' },
  { value: 'alphabetical',   label: 'A → Z' },
  { value: 'year_desc',      label: 'Newest first' },
  { value: 'rating',         label: 'Top rated' },
  { value: 'random',         label: 'Shuffled' },
]

const PAGE_SIZE = 50

export default function LibraryDetail() {
  const { id } = useParams()
  const navigate = useNavigate()

  const [library, setLibrary] = useState(null)
  const [items, setItems]     = useState([])
  const [genres, setGenres]   = useState([])
  const [genre, setGenre]     = useState('')
  const [sort, setSort]       = useState('recently_added')
  const [page, setPage]       = useState(1)
  const [hasMore, setHasMore] = useState(true)
  const [loading, setLoading] = useState(true)

  // One-time: library info + genre list for this library
  useEffect(() => {
    api.get('/libraries').then(r => {
      setLibrary(r.data.find(l => l.id === id) ?? null)
    }).catch(() => {})
    api.get('/media/genres', { params: { library_id: id } })
      .then(r => setGenres(r.data))
      .catch(() => setGenres([]))
  }, [id])

  // Refetch items whenever filters change (resets to page 1)
  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setPage(1)
    api.get('/media', {
      params: { library_id: id, sort, genre: genre || undefined, page: 1, limit: PAGE_SIZE }
    })
    .then(r => {
      if (cancelled) return
      setItems(r.data)
      setHasMore(r.data.length === PAGE_SIZE)
    })
    .catch(() => { if (!cancelled) setItems([]) })
    .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [id, sort, genre])

  async function loadMore() {
    const next = page + 1
    const r = await api.get('/media', {
      params: { library_id: id, sort, genre: genre || undefined, page: next, limit: PAGE_SIZE }
    })
    setItems(prev => [...prev, ...r.data])
    setPage(next)
    setHasMore(r.data.length === PAGE_SIZE)
  }

  return (
    <main className={styles.main}>
      <header className={styles.header}>
        <button className={styles.backBtn} onClick={() => navigate(-1)}>&#8592; Back</button>
        <h1 className={styles.title}>{library?.name ?? 'Library'}</h1>
        {library && (
          <p className={styles.subline}>
            {library.type} · {items.length}{hasMore ? '+' : ''} item{items.length === 1 ? '' : 's'}
          </p>
        )}
      </header>

      <div className={styles.filters}>
        <div className={styles.filterGroup}>
          <label className={styles.label}>Sort</label>
          <select
            value={sort}
            onChange={e => setSort(e.target.value)}
            className={styles.select}
          >
            {SORT_OPTIONS.map(o => (
              <option key={o.value} value={o.value}>{o.label}</option>
            ))}
          </select>
        </div>

        {genres.length > 0 && (
          <div className={styles.filterGroup}>
            <label className={styles.label}>Genre</label>
            <div className={styles.chips}>
              <Chip active={!genre} onClick={() => setGenre('')}>All</Chip>
              {genres.map(g => (
                <Chip key={g} active={genre === g} onClick={() => setGenre(g)}>{g}</Chip>
              ))}
            </div>
          </div>
        )}
      </div>

      {loading ? (
        <SkeletonGrid />
      ) : items.length === 0 ? (
        <p className={styles.empty}>No items match these filters.</p>
      ) : (
        <>
          <div className={styles.grid}>
            {items.map(item => (
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
                {item.year && <p className={styles.cardSub}>{item.year}</p>}
              </button>
            ))}
          </div>

          {hasMore && (
            <div className={styles.loadMoreWrap}>
              <button className="ghost" onClick={loadMore}>Load more</button>
            </div>
          )}
        </>
      )}
    </main>
  )
}

function Chip({ active, onClick, children }) {
  return (
    <button
      className={`${styles.chip} ${active ? styles.chipActive : ''}`}
      onClick={onClick}
    >
      {children}
    </button>
  )
}

function SkeletonGrid() {
  return (
    <div className={styles.grid}>
      {Array.from({ length: 18 }).map((_, i) => (
        <div key={i} className={styles.card} style={{ pointerEvents: 'none' }}>
          <div className={`${styles.poster} ${styles.skeleton}`} />
          <div className={`${styles.skeleton} ${styles.skelLine}`} style={{ width: '70%' }} />
          <div className={`${styles.skeleton} ${styles.skelLine}`} style={{ width: '30%', marginTop: 4 }} />
        </div>
      ))}
    </div>
  )
}
