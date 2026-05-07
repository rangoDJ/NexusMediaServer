import { Routes, Route, Navigate } from 'react-router-dom'
import Settings from './pages/Settings.jsx'
import Login from './pages/Login.jsx'

function useAuth() {
  return !!localStorage.getItem('nexus_token')
}

function RequireAdmin({ children }) {
  const authed = useAuth()
  if (!authed) return <Navigate to="/login" replace />
  return children
}

export default function App() {
  return (
    <Routes>
      <Route path="/login" element={<Login />} />
      <Route path="/settings" element={<RequireAdmin><Settings /></RequireAdmin>} />
      <Route path="*" element={<Navigate to="/settings" replace />} />
    </Routes>
  )
}
