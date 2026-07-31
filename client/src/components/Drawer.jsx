import { useState, useEffect, useRef } from 'react'
import { NavLink, useNavigate } from 'react-router-dom'
import { api } from '../api/client.js'
import { isAdmin } from '../App.jsx'
import styles from './Drawer.module.css'

/* 24-unit grid, 1.75 stroke — matches the icon set the old Rail used. */
const ico = { width: 20, height: 20, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor',
              strokeWidth: 1.75, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true }

const IconHome = () => (
  <svg {...ico}><path d="M3 10.2 12 3l9 7.2" /><path d="M5 9.5V20h14V9.5" /></svg>
)
const IconFavorite = () => (
  <svg {...ico} fill="none"><path d="M12 20.3 4.6 13c-2-2-2-5.3 0-7.3 2-2 5.2-2 7.2 0l.2.2.2-.2c2-2 5.2-2 7.2 0 2 2 2 5.3 0 7.3L12 20.3Z" /></svg>
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
 * Slide-in navigation drawer, opened from the top bar's hamburger button.
 *
 * Matches jellyfin-web's actual nav pattern (MainDrawerContent.tsx) rather
 * than a persistent hover-expand rail: Home / Favorites at the top, then a
 * divider, then one entry per library with its icon — opened on demand and
 * dismissed by clicking the scrim, pressing Escape, or picking a link.
 */
export default function Drawer({ open, onClose }) {
  const [libraries, setLibraries] = useState([])
  const panelRef = useRef(null)
  const navigate = useNavigate()
  const admin = isAdmin()

  useEffect(() => {
    api.get('/libraries').then(r => setLibraries(r.data)).catch(() => {})
  }, [])

  useEffect(() => {
    if (!open) return
    function onKey(e) { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', onKey)
    // Matches the drawer's own visual containment: while it's open, the page
    // behind it shouldn't also scroll.
    const prevOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    panelRef.current?.querySelector('a,button')?.focus()
    return () => {
      document.removeEventListener('keydown', onKey)
      document.body.style.overflow = prevOverflow
    }
  }, [open, onClose])

  const linkClass = ({ isActive }) => `${styles.item} ${isActive ? styles.active : ''}`

  function go(path) {
    onClose()
    navigate(path)
  }

  return (
    <>
      <div
        className={`${styles.scrim} ${open ? styles.scrimOpen : ''}`}
        onClick={onClose}
        aria-hidden="true"
      />
      <nav
        ref={panelRef}
        className={`${styles.panel} ${open ? styles.panelOpen : ''}`}
        aria-label="Main"
        aria-hidden={!open}
        inert={!open}
      >
        <div className={styles.brand}>
          <span className={styles.mark} aria-hidden="true" />
          <span>Nexus</span>
        </div>

        <div className={styles.group}>
          <NavLink to="/" end className={linkClass} onClick={onClose}>
            <IconHome /><span>Home</span>
          </NavLink>
          <button className={styles.item} onClick={() => go('/?favorites=1')}>
            <IconFavorite /><span>Favorites</span>
          </button>
        </div>

        {libraries.length > 0 && (
          <>
            <div className={styles.divider} />
            <div className={styles.subheader}>Libraries</div>
            <div className={styles.group}>
              {libraries.map(lib => (
                <button key={lib.id} className={styles.item} onClick={() => go(`/library/${lib.id}`)}>
                  <IconLibrary /><span>{lib.name}</span>
                </button>
              ))}
              <NavLink to="/collections" className={linkClass} onClick={onClose}>
                <IconCollections /><span>Collections</span>
              </NavLink>
            </div>
          </>
        )}

        <div className={styles.spacer} />

        <div className={styles.divider} />
        <div className={styles.group}>
          <NavLink to="/search" className={linkClass} onClick={onClose}>
            <IconSearch /><span>Search</span>
          </NavLink>
          {admin && (
            <NavLink to="/settings" className={linkClass} onClick={onClose}>
              <IconSettings /><span>Settings</span>
            </NavLink>
          )}
        </div>
      </nav>
    </>
  )
}
