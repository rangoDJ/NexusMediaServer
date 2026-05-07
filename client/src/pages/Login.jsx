import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { api } from '../api/client.js'
import styles from './Login.module.css'

export default function Login() {
  const [form, setForm] = useState({ username: '', password: '' })
  const [error, setError] = useState(null)
  const [loading, setLoading] = useState(false)
  const navigate = useNavigate()

  async function submit(e) {
    e.preventDefault()
    setError(null)
    setLoading(true)
    try {
      const { data } = await api.post('/auth/login', {
        ...form,
        device_name: 'Web Browser',
        device_type: 'web',
      })
      localStorage.setItem('nexus_token', data.access_token)
      localStorage.setItem('nexus_refresh_token', data.refresh_token)
      localStorage.setItem('nexus_user', JSON.stringify(data.user))
      navigate('/settings')
    } catch (err) {
      setError(err.response?.data?.error ?? 'Login failed')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className={styles.wrap}>
      <form className={styles.card} onSubmit={submit}>
        <h1 className={styles.logo}>Nexus</h1>
        <p className={styles.sub}>Media Server</p>
        {error && <div className={styles.error}>{error}</div>}
        <label>Username
          <input value={form.username} onChange={e => setForm(f => ({ ...f, username: e.target.value }))} required autoFocus />
        </label>
        <label>Password
          <input type="password" value={form.password} onChange={e => setForm(f => ({ ...f, password: e.target.value }))} required />
        </label>
        <button className="primary" disabled={loading}>{loading ? 'Signing in…' : 'Sign in'}</button>
      </form>
    </div>
  )
}
