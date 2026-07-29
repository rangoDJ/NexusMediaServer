import styles from './RouteFallback.module.css'

/**
 * Shown while a lazily-loaded route chunk downloads.
 *
 * Deliberately quiet: on a local network the chunk usually arrives in a few
 * frames, and a spinner that flashes for 80ms reads as jank rather than
 * feedback. The bar fades in only after a short delay (CSS animation-delay),
 * so a fast load shows nothing at all.
 */
export default function RouteFallback() {
  return <div className={styles.bar} role="status" aria-label="Loading" />
}
