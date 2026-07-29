import Rail from './Rail.jsx'
import TopBar from './TopBar.jsx'
import styles from './Layout.module.css'

/**
 * The single application shell.
 *
 * Every authenticated route renders inside this — including Settings, which
 * previously built its own sidebar and set height:100vh while already nested
 * inside the old TopNav, overflowing the viewport by the height of that nav.
 *
 * The rail is fixed and the window scrolls, so pages keep behaving like
 * ordinary documents (sticky headers, anchor links and scroll restoration all
 * work) and only need to respect the rail's offset.
 */
export default function Layout({ children }) {
  return (
    <div className={styles.shell}>
      <Rail />
      <div className={styles.main}>
        <TopBar />
        <div className={styles.content}>{children}</div>
      </div>
    </div>
  )
}
