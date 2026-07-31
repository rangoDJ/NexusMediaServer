import { useState, useEffect } from 'react'
import { useLocation } from 'react-router-dom'
import Drawer from './Drawer.jsx'
import TopBar from './TopBar.jsx'
import styles from './Layout.module.css'

/**
 * The single application shell.
 *
 * Every authenticated route renders inside this — including Settings, which
 * previously built its own sidebar and set height:100vh while already nested
 * inside the old TopNav, overflowing the viewport by the height of that nav.
 *
 * Navigation is a hamburger-triggered overlay drawer (see Drawer.jsx),
 * matching jellyfin-web's own nav pattern, rather than a permanent-space
 * sidebar — so there is no fixed offset for the content column to respect
 * and no rail width to reserve.
 */
export default function Layout({ children }) {
  const [drawerOpen, setDrawerOpen] = useState(false)
  const location = useLocation()

  // A route change is the user having picked a destination — the drawer's own
  // links already close it, but this also covers navigation that didn't go
  // through the drawer (e.g. a card click while it happened to be open), so
  // it's never left open behind the page that follows.
  useEffect(() => { setDrawerOpen(false) }, [location.pathname])

  return (
    <div className={styles.shell}>
      <Drawer open={drawerOpen} onClose={() => setDrawerOpen(false)} />
      <div className={styles.main}>
        <TopBar onMenuClick={() => setDrawerOpen(true)} />
        <div className={styles.content}>{children}</div>
      </div>
    </div>
  )
}
