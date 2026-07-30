import { useState, useEffect, useRef } from 'react'
import { useNavigate, useLocation, useSearchParams } from 'react-router-dom'
import { api } from '../api/client.js'
import { useTheme } from '../hooks/useTheme.js'
import styles from './TopBar.module.css'

const THEME_LABEL = { system: 'Match system', dark: 'Dark', light: 'Light' }

function ThemeIcon({ resolved }) {
  const p = { width: 16, height: 16, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor',
              strokeWidth: 1.8, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true }
  return resolved === 'light'
    ? <svg {...p}><circle cx="12" cy="12" r="4.2" /><path d="M12 2.5v2M12 19.5v2M2.5 12h2M19.5 12h2M5.1 5.1l1.4 1.4M17.5 17.5l1.4 1.4M18.9 5.1l-1.4 1.4M6.5 17.5l-1.4 1.4" /></svg>
    : <svg {...p}><path d="M20 13.5A8 8 0 1 1 10.5 4a6.5 6.5 0 0 0 9.5 9.5Z" /></svg>
}

/* Routes that own their own hero/title. The bar stays transparent and
   title-less over these so it floats on the artwork instead of stacking a
   second heading above it. */
const IMMERSIVE = [/^\/movie\//, /^\/person\//, /^\/collections\/[^/]+$/]

const TITLES = [
  [/^\/$/,            'Home'],
  [/^\/libraries$/,   'Libraries'],
  [/^\/library\//,    'Library'],
  [/^\/collections$/, 'Collections'],
  [/^\/search$/,      'Search'],
  [/^\/settings$/,    'Settings'],
]

function titleFor(pathname) {
  return TITLES.find(([re]) => re.test(pathname))?.[1] ?? ''
}

/**
 * Contextual top bar.
 *
 * Transparent while the page is at rest, gaining a glass background and a
 * hairline once content scrolls under it. On immersive routes (detail pages)
 * it renders no title, so the page's own hero carries the heading.
 */
export default function TopBar() {
  const [scrolled, setScrolled] = useState(false)
  const [menuOpen, setMenuOpen] = useState(false)
  const [query, setQuery] = useState('')
  const menuRef = useRef(null)
  const { pref, resolved, cycle } = useTheme()
  const navigate = useNavigate()
  const { pathname } = useLocation()
  const [searchParams] = useSearchParams()

  const immersive = IMMERSIVE.some(re => re.test(pathname))
  const title = immersive ? '' : titleFor(pathname)

  const user = JSON.parse(localStorage.getItem('nexus_user') || '{}')
  const initial = (user.username?.[0] ?? '?').toUpperCase()

  // Keep the field in step with the URL so a search arrived at by link, or
  // cleared by navigating away, doesn't leave a stale term sitting in the box.
  useEffect(() => {
    setQuery(pathname === '/search' ? (searchParams.get('q') ?? '') : '')
  }, [pathname, searchParams])

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 8)
    onScroll()
    window.addEventListener('scroll', onScroll, { passive: true })
    return () => window.removeEventListener('scroll', onScroll)
  }, [])

  useEffect(() => {
    if (!menuOpen) return
    function onClick(e) {
      if (menuRef.current && !menuRef.current.contains(e.target)) setMenuOpen(false)
    }
    function onKey(e) { if (e.key === 'Escape') setMenuOpen(false) }
    document.addEventListener('mousedown', onClick)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onClick)
      document.removeEventListener('keydown', onKey)
    }
  }, [menuOpen])

  function onSearchSubmit(e) {
    e.preventDefault()
    const q = query.trim()
    if (q) navigate(`/search?q=${encodeURIComponent(q)}`)
  }

  function signOut() {
    api.post('/auth/logout').catch(() => {}).finally(() => {
      localStorage.removeItem('nexus_user')
      navigate('/login')
    })
  }

  return (
    <header className={`${styles.bar} ${scrolled ? styles.scrolled : ''} ${immersive ? styles.immersive : ''}`}>
      {title && <h1 className={styles.title}>{title}</h1>}

      <form className={styles.search} onSubmit={onSearchSubmit} role="search">
        <span className={styles.searchIcon} aria-hidden="true">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor"
               strokeWidth="2" strokeLinecap="round">
            <circle cx="11" cy="11" r="6.5" /><path d="m16 16 4.5 4.5" />
          </svg>
        </span>
        <input
          type="search"
          className={styles.searchInput}
          placeholder="Search movies, series…"
          value={query}
          onChange={e => setQuery(e.target.value)}
          aria-label="Search"
        />
      </form>

      <button
        className={styles.themeBtn}
        onClick={cycle}
        title={`Theme: ${THEME_LABEL[pref]}`}
        aria-label={`Theme: ${THEME_LABEL[pref]}. Activate to change.`}
      >
        <ThemeIcon resolved={resolved} />
        {/* 'system' is otherwise indistinguishable from whichever theme it
            currently resolves to. */}
        {pref === 'system' && <span className={styles.themeAuto} aria-hidden="true" />}
      </button>

      <div className={styles.user} ref={menuRef}>
        <button
          className={styles.avatar}
          onClick={() => setMenuOpen(o => !o)}
          aria-label="Account menu"
          aria-expanded={menuOpen}
          aria-haspopup="menu"
        >
          {initial}
        </button>
        {menuOpen && (
          <div className={styles.menu} role="menu">
            <div className={styles.userInfo}>
              <p className={styles.userName}>{user.username ?? 'Unknown'}</p>
              {user.role && <p className={styles.userRole}>{user.role}</p>}
            </div>
            <div className={styles.divider} />
            <button className={styles.menuItem} role="menuitem" onClick={signOut}>
              Sign out
            </button>
          </div>
        )}
      </div>
    </header>
  )
}
