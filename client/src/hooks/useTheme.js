import { useState, useEffect, useCallback } from 'react'

const KEY = 'nexus_theme'   // 'dark' | 'light' | 'system'

/** Resolve 'system' against the OS preference. */
function resolve(pref) {
  if (pref === 'dark' || pref === 'light') return pref
  return window.matchMedia?.('(prefers-color-scheme: light)').matches ? 'light' : 'dark'
}

/**
 * Applies the theme by stamping data-theme on <html>.
 *
 * tokens.css defines the palette twice — once as :root defaults and again
 * under [data-theme="light"] / [data-theme="dark"] — so an explicit stamp
 * always wins over the media query in both directions. That means a user who
 * prefers light at the OS level can still pin the app to dark, which matters
 * for a media app people watch in a dim room on a machine configured for
 * daytime work.
 */
export function applyTheme(pref) {
  document.documentElement.setAttribute('data-theme', resolve(pref))
}

/** Read the stored preference without subscribing. */
export function storedPreference() {
  try { return localStorage.getItem(KEY) ?? 'system' } catch { return 'system' }
}

export function useTheme() {
  const [pref, setPref] = useState(storedPreference)

  useEffect(() => {
    applyTheme(pref)
    try { localStorage.setItem(KEY, pref) } catch { /* private mode */ }
  }, [pref])

  // Follow the OS live, but only while the user hasn't pinned a theme.
  useEffect(() => {
    if (pref !== 'system') return
    const mq = window.matchMedia?.('(prefers-color-scheme: light)')
    if (!mq) return
    const onChange = () => applyTheme('system')
    mq.addEventListener('change', onChange)
    return () => mq.removeEventListener('change', onChange)
  }, [pref])

  const cycle = useCallback(() => {
    setPref(p => (p === 'system' ? 'dark' : p === 'dark' ? 'light' : 'system'))
  }, [])

  return { pref, resolved: resolve(pref), setPref, cycle }
}
