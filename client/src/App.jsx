import { useState, useEffect, lazy, Suspense } from 'react'
import { Routes, Route, Navigate } from 'react-router-dom'
import axios from 'axios'
import Layout from './components/Layout.jsx'
import RouteFallback from './components/RouteFallback.jsx'

// Home and Login stay eager — they are the two first-paint destinations, and
// code-splitting them would only trade a smaller bundle for a spinner on the
// very first screen.
import Home from './pages/Home.jsx'
import Login from './pages/Login.jsx'

// Everything else loads on demand. The big wins:
//   MovieDetail → pulls in Player → pulls in hls.js (the largest dependency)
//   Settings    → the biggest page in the app by a wide margin
//   Setup       → runs exactly once in a server's lifetime
const MovieDetail     = lazy(() => import('./pages/MovieDetail.jsx'))
const Settings        = lazy(() => import('./pages/Settings.jsx'))
const Setup           = lazy(() => import('./pages/Setup.jsx'))
const Register        = lazy(() => import('./pages/Register.jsx'))
const Search          = lazy(() => import('./pages/Search.jsx'))
const Person          = lazy(() => import('./pages/Person.jsx'))
const Libraries       = lazy(() => import('./pages/Libraries.jsx'))
const LibraryDetail   = lazy(() => import('./pages/LibraryDetail.jsx'))
const Collections     = lazy(() => import('./pages/Collections.jsx'))
const CollectionDetail = lazy(() => import('./pages/CollectionDetail.jsx'))

// Auth tokens live in httpOnly cookies now (see api/client.js) — invisible
// to JS by design. `nexus_user` is a non-sensitive UI-only marker set/cleared
// alongside login/logout; it's a hint for client-side routing, not a security
// boundary — every real request is still authorized server-side by the cookie.
function useAuth() {
  return !!localStorage.getItem('nexus_user')
}

export function isAdmin() {
  try {
    return JSON.parse(localStorage.getItem('nexus_user') || '{}').role === 'admin'
  } catch {
    return false
  }
}

function RequireAuth({ children }) {
  const authed = useAuth()
  if (!authed) return <Navigate to="/login" replace />
  return <Layout>{children}</Layout>
}

function RequireAdmin({ children }) {
  const authed = useAuth()
  if (!authed) return <Navigate to="/login" replace />
  if (!isAdmin()) return <Navigate to="/" replace />
  return <Layout>{children}</Layout>
}

export default function App() {
  // null = checking, true = required, false = done
  const [setupRequired, setSetupRequired] = useState(null)

  useEffect(() => {
    axios.get('/api/v1/setup/status')
      .then(r => setSetupRequired(r.data.required))
      .catch(() => setSetupRequired(false))  // on error assume setup is done
  }, [])

  // Blank screen while we check — avoids a flash of the login page
  if (setupRequired === null) return null

  if (setupRequired) {
    return (
      <Suspense fallback={<RouteFallback />}>
        <Routes>
          <Route
            path="/setup"
            element={<Setup onComplete={() => setSetupRequired(false)} />}
          />
          <Route path="*" element={<Navigate to="/setup" replace />} />
        </Routes>
      </Suspense>
    )
  }

  return (
    <Suspense fallback={<RouteFallback />}>
      <Routes>
        <Route path="/login" element={<Login />} />
        <Route path="/register" element={<Register />} />
        <Route path="/" element={<RequireAuth><Home /></RequireAuth>} />
        <Route path="/movie/:id" element={<RequireAuth><MovieDetail /></RequireAuth>} />
        <Route path="/libraries" element={<RequireAuth><Libraries /></RequireAuth>} />
        <Route path="/library/:id" element={<RequireAuth><LibraryDetail /></RequireAuth>} />
        <Route path="/search" element={<RequireAuth><Search /></RequireAuth>} />
        <Route path="/person/:tmdbId" element={<RequireAuth><Person /></RequireAuth>} />
        <Route path="/collections"    element={<RequireAuth><Collections /></RequireAuth>} />
        <Route path="/collections/:id" element={<RequireAuth><CollectionDetail /></RequireAuth>} />
        <Route path="/settings" element={<RequireAdmin><Settings /></RequireAdmin>} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </Suspense>
  )
}
