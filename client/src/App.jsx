import { useState, useEffect } from 'react'
import { Routes, Route, Navigate } from 'react-router-dom'
import axios from 'axios'
import Settings from './pages/Settings.jsx'
import Login from './pages/Login.jsx'
import Register from './pages/Register.jsx'
import Setup from './pages/Setup.jsx'
import Home from './pages/Home.jsx'
import MovieDetail from './pages/MovieDetail.jsx'
import Search from './pages/Search.jsx'
import Person from './pages/Person.jsx'
import LibraryDetail from './pages/LibraryDetail.jsx'
import Layout from './components/Layout.jsx'

function useAuth() {
  return !!localStorage.getItem('nexus_token')
}

function RequireAuth({ children }) {
  const authed = useAuth()
  if (!authed) return <Navigate to="/login" replace />
  return <Layout>{children}</Layout>
}

function RequireAdmin({ children }) {
  const authed = useAuth()
  if (!authed) return <Navigate to="/login" replace />
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
      <Routes>
        <Route
          path="/setup"
          element={<Setup onComplete={() => setSetupRequired(false)} />}
        />
        <Route path="*" element={<Navigate to="/setup" replace />} />
      </Routes>
    )
  }

  return (
    <Routes>
      <Route path="/login" element={<Login />} />
      <Route path="/register" element={<Register />} />
      <Route path="/" element={<RequireAuth><Home /></RequireAuth>} />
      <Route path="/movie/:id" element={<RequireAuth><MovieDetail /></RequireAuth>} />
      <Route path="/library/:id" element={<RequireAuth><LibraryDetail /></RequireAuth>} />
      <Route path="/search" element={<RequireAuth><Search /></RequireAuth>} />
      <Route path="/person/:tmdbId" element={<RequireAuth><Person /></RequireAuth>} />
      <Route path="/settings" element={<RequireAdmin><Settings /></RequireAdmin>} />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  )
}
