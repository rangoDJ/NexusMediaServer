import { useEffect, useRef, useState } from 'react'
import { Link, NavLink, useNavigate } from 'react-router-dom'
import { api } from '../api/client.js'
import styles from './TopNav.module.css'

export default function TopNav() {
  const navigate = useNavigate()
  const [libraries, setLibraries] = useState([])
  const [menuOpen, setMenuOpen]   = useState(false)
  const [libsOpen, setLibsOpen]   = useState(false)
  const [query, setQuery]         = useState('')
  const menuRef = useRef(null)
  const libsRef = useRef(null)

  const user = JSON.parse(localStorage.getItem('nexus_user') || '{}')
  const initial = (user.username?.[0] ?? '?').toUpperCase()

  useEffect(() => {
    api.get('/libraries').then(r => setLibraries(r.data)).catch(() => {})
  }, [])

  // Close dropdowns on outside click
  useEffect(() => {
    function onClick(e) {
      if (menuRef.current && !menuRef.current.contains(e.target)) setMenuOpen(false)
      if (libsRef.current && !libsRef.current.contains(e.target)) setLibsOpen(false)
    }
    document.addEventListener('mousedown', onClick)
    return () => document.removeEventListener('mousedown', onClick)
  }, [])

  function signOut() {
    localStorage.removeItem('nexus_token')
    localStorage.removeItem('nexus_refresh_token')
    localStorage.removeItem('nexus_user')
    navigate('/login')
  }

  function onSearchSubmit(e) {
    e.preventDefault()
    const q = query.trim()
    if (q) navigate(`/search?q=${encodeURIComponent(q)}`)
  }

  return (
    <header className={styles.nav}>
      <div className={styles.left}>
        <Link to="/" className={styles.logo}>Nexus</Link>

        <NavLink to="/" end className={({ isActive }) =>
          `${styles.navLink} ${isActive ? styles.active : ''}`
        }>
          Home
        </NavLink>

        {libraries.length > 0 && (
          <div className={styles.libsWrap} ref={libsRef}>
            <button
              className={`${styles.navLink} ${libsOpen ? styles.active : ''}`}
              onClick={() => setLibsOpen(o => !o)}
            >
              Libraries ▾
            </button>
            {libsOpen && (
              <div className={styles.libsMenu}>
                {libraries.map(lib => (
                  <button
                    key={lib.id}
                    className={styles.libItem}
                    onClick={() => { setLibsOpen(false); navigate(`/library/${lib.id}`) }}
                  >
                    <span className={styles.libName}>{lib.name}</span>
                    <span className={styles.libType}>{lib.type}</span>
                  </button>
                ))}
              </div>
            )}
          </div>
        )}
      </div>

      <form className={styles.search} onSubmit={onSearchSubmit} role="search">
        <span className={styles.searchIcon} aria-hidden>⌕</span>
        <input
          type="search"
          placeholder="Search movies, series…"
          value={query}
          onChange={e => setQuery(e.target.value)}
          className={styles.searchInput}
        />
      </form>

      <div className={styles.right} ref={menuRef}>
        <button
          className={styles.avatar}
          onClick={() => setMenuOpen(o => !o)}
          aria-label="User menu"
        >
          {initial}
        </button>
        {menuOpen && (
          <div className={styles.userMenu}>
            <div className={styles.userInfo}>
              <p className={styles.userName}>{user.username ?? 'Unknown'}</p>
              <p className={styles.userRole}>{user.role ?? ''}</p>
            </div>
            <div className={styles.menuDivider} />
            {user.role === 'admin' && (
              <button className={styles.menuItem} onClick={() => { setMenuOpen(false); navigate('/settings') }}>
                Settings
              </button>
            )}
            <button className={styles.menuItem} onClick={signOut}>
              Sign out
            </button>
          </div>
        )}
      </div>
    </header>
  )
}
