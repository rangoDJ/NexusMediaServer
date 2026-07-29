import { useState, useEffect } from 'react'
import { NavLink, useNavigate } from 'react-router-dom'
import { api } from '../api/client.js'
import { isAdmin } from '../App.jsx'
import styles from './Rail.module.css'

/* Icons are inline so they inherit currentColor and cost no extra request.
   All drawn on a 24-unit grid with a 1.75 stroke to stay optically even. */
const ico = { width: 20, height: 20, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor',
              strokeWidth: 1.75, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true }

const IconHome = () => (
  <svg {...ico}><path d="M3 10.2 12 3l9 7.2" /><path d="M5 9.5V20h14V9.5" /></svg>
)
const IconLibrary = () => (
  <svg {...ico}><rect x="3" y="4" width="5" height="16" rx="1" /><rect x="10" y="4" width="5" height="16" rx="1" />
    <path d="m17.5 5.4 3.1 14.1" /></svg>
)
const IconCollections = () => (
  <svg {...ico}><path d="m12 3 8 4.5-8 4.5-8-4.5L12 3Z" /><path d="m4 12.5 8 4.5 8-4.5" /><path d="m4 16.8 8 4.5 8-4.5" /></svg>
)
const IconSearch = () => (
  <svg {...ico}><circle cx="11" cy="11" r="6.5" /><path d="m16 16 4.5 4.5" /></svg>
)
const IconSettings = () => (
  <svg {...ico}><circle cx="12" cy="12" r="3" />
    <path d="M19.4 15a1.6 1.6 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.6 1.6 0 0 0-2.7 1.1v.2a2 2 0 1 1-4 0v-.1A1.6 1.6 0 0 0 8 19.4a1.6 1.6 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.6 1.6 0 0 0-1.1-2.7H2a2 2 0 1 1 0-4h.1A1.6 1.6 0 0 0 3.7 8a1.6 1.6 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.6 1.6 0 0 0 2.7-1.1V2a2 2 0 1 1 4 0v.1A1.6 1.6 0 0 0 16 3.7a1.6 1.6 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.6 1.6 0 0 0 1.1 2.7h.2a2 2 0 1 1 0 4h-.1a1.6 1.6 0 0 0-1.4 1Z" /></svg>
)

/**
 * Persistent navigation rail.
 *
 * 64px of icons, expanding to 240px on hover or keyboard focus. It expands as
 * an overlay rather than pushing the page, so nothing reflows when the pointer
 * crosses it. Below 720px it flattens into a bottom tab bar.
 *
 * Replaces TopNav, which shipped two separate controls both labelled
 * "Libraries" — a link to the management page and a dropdown of the libraries
 * themselves. Here the icon goes to the management page and the individual
 * libraries are nested beneath it, so the relationship is visible instead of
 * being two competing entries.
 */
export default function Rail() {
  const [libraries, setLibraries] = useState([])
  const navigate = useNavigate()
  const admin = isAdmin()

  useEffect(() => {
    api.get('/libraries').then(r => setLibraries(r.data)).catch(() => {})
  }, [])

  const linkClass = ({ isActive }) =>
    `${styles.item} ${isActive ? styles.active : ''}`

  return (
    <nav className={styles.rail} aria-label="Main">
      <NavLink to="/" className={styles.brand} aria-label="Nexus home">
        <span className={styles.mark} aria-hidden="true" />
        <span className={styles.label}>Nexus</span>
      </NavLink>

      <div className={styles.group}>
        <NavLink to="/" end className={linkClass}>
          <IconHome />
          <span className={styles.label}>Home</span>
        </NavLink>

        <NavLink to="/libraries" className={linkClass}>
          <IconLibrary />
          <span className={styles.label}>Libraries</span>
        </NavLink>

        {/* Individual libraries, visible only once the rail is open. Hidden
            from assistive tech while collapsed so it isn't announced as a
            floating list of links with no context. */}
        {libraries.length > 0 && (
          <div className={styles.sublist}>
            {libraries.map(lib => (
              <button
                key={lib.id}
                className={styles.subitem}
                tabIndex={-1}
                onClick={() => navigate(`/library/${lib.id}`)}
              >
                <span className={styles.subdot} aria-hidden="true" />
                <span className={styles.label}>{lib.name}</span>
              </button>
            ))}
          </div>
        )}

        <NavLink to="/collections" className={linkClass}>
          <IconCollections />
          <span className={styles.label}>Collections</span>
        </NavLink>

        <NavLink to="/search" className={linkClass}>
          <IconSearch />
          <span className={styles.label}>Search</span>
        </NavLink>
      </div>

      {admin && (
        <div className={styles.footer}>
          <NavLink to="/settings" className={linkClass}>
            <IconSettings />
            <span className={styles.label}>Settings</span>
          </NavLink>
        </div>
      )}
    </nav>
  )
}
