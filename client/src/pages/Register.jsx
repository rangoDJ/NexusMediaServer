import { useState } from 'react'
import { useNavigate, Link } from 'react-router-dom'
import { api } from '../api/client.js'
import styles from './Login.module.css'

export default function Register() {
  const [form, setForm] = useState({ username: '', email: '', password: '', confirm: '' })
  const [error, setError] = useState(null)
  const [loading, setLoading] = useState(false)
  const navigate = useNavigate()

  function set(field) {
    return e => setForm(f => ({ ...f, [field]: e.target.value }))
  }

  async function submit(e) {
    e.preventDefault()
    if (form.password !== form.confirm) {
      setError('Passwords do not match')
      return
    }
    setError(null)
    setLoading(true)
    try {
      const { data } = await api.post('/auth/register', {
        username: form.username,
        email: form.email,
        password: form.password,
        device_name: 'Web Browser',
        device_type: 'web',
      })
      localStorage.setItem('nexus_token', data.access_token)
      localStorage.setItem('nexus_refresh_token', data.refresh_token)
      localStorage.setItem('nexus_user', JSON.stringify(data.user))
      navigate('/')
    } catch (err) {
      setError(err.response?.data?.error ?? 'Registration failed')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className={styles.wrap}>
      <form className={styles.card} onSubmit={submit}>
        <h1 className={styles.logo}>Nexus</h1>
        <p className={styles.sub}>Create Account</p>
        {error && <div className={styles.error}>{error}</div>}
        <label>Username
          <input value={form.username} onChange={set('username')} required autoFocus autoComplete="username" />
        </label>
        <label>Email
          <input type="email" value={form.email} onChange={set('email')} required autoComplete="email" />
        </label>
        <label>Password
          <input type="password" value={form.password} onChange={set('password')} required autoComplete="new-password" minLength={8} />
        </label>
        <label>Confirm Password
          <input type="password" value={form.confirm} onChange={set('confirm')} required autoComplete="new-password" />
        </label>
        <button className="primary" disabled={loading}>
          {loading ? 'Creating account…' : 'Create account'}
        </button>
        <p style={{ textAlign: 'center', fontSize: 13, color: 'var(--text-muted)', margin: 0 }}>
          Already have an account?{' '}
          <Link to="/login" style={{ color: 'var(--accent)' }}>Sign in</Link>
        </p>
      </form>
    </div>
  )
}
