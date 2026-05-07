import { useState, useEffect, useCallback } from 'react'
import axios from 'axios'
import styles from './Setup.module.css'

const STEPS = ['Welcome', 'Admin Account', 'Libraries', 'Metadata', 'Finish']

// ── Step indicator ────────────────────────────────────────────────────────────

function StepTrack({ current }) {
  return (
    <div className={styles.steps}>
      {STEPS.map((label, i) => (
        <div key={i} className={styles.stepItem}>
          {i > 0 && (
            <div className={`${styles.stepLine} ${i <= current ? styles.done : ''}`} />
          )}
          <div className={`${styles.stepDot} ${i === current ? styles.active : ''} ${i < current ? styles.done : ''}`}>
            {i < current ? '✓' : i + 1}
          </div>
          <span className={`${styles.stepLabel} ${i === current ? styles.active : ''}`}>
            {label}
          </span>
        </div>
      ))}
    </div>
  )
}

// ── Directory browser modal ───────────────────────────────────────────────────

function DirBrowser({ onSelect, onClose }) {
  const [path, setPath] = useState('/')
  const [dirs, setDirs] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)

  const browse = useCallback(async (target) => {
    setLoading(true)
    setError(null)
    try {
      const { data } = await axios.get('/api/v1/setup/browse', { params: { path: target } })
      setPath(data.path)
      setDirs(data.dirs)
    } catch {
      setError('Cannot read this directory')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { browse('/') }, [browse])

  // Build breadcrumb segments from path
  function breadcrumbs() {
    const parts = path.split('/').filter(Boolean)
    return [
      { label: '/', path: '/' },
      ...parts.map((p, i) => ({ label: p, path: '/' + parts.slice(0, i + 1).join('/') })),
    ]
  }

  return (
    <div className={styles.overlay} onClick={e => e.target === e.currentTarget && onClose()}>
      <div className={styles.browser}>
        <div className={styles.browserHeader}>
          <div className={styles.browserTitle}>Select folder</div>
          <div className={styles.browserPath}>
            {breadcrumbs().map((b, i) => (
              <span key={i}>
                {i > 0 && <span>/</span>}
                <button className={styles.breadcrumb} onClick={() => browse(b.path)}>
                  {b.label}
                </button>
              </span>
            ))}
          </div>
        </div>

        <div className={styles.browserBody}>
          {loading && <div className={styles.browserLoading}>Loading…</div>}
          {error && <div className={styles.emptyDir}>{error}</div>}
          {!loading && !error && dirs.length === 0 && (
            <div className={styles.emptyDir}>No subdirectories found</div>
          )}
          {!loading && !error && path !== '/' && (
            <div className={styles.dirItem} onClick={() => {
              const parent = path.split('/').slice(0, -1).join('/') || '/'
              browse(parent)
            }}>
              <span className={styles.dirIcon}>⬆</span>
              <span>..</span>
            </div>
          )}
          {!loading && dirs.map(d => (
            <div key={d.path} className={styles.dirItem} onClick={() => browse(d.path)}>
              <span className={styles.dirIcon}>📁</span>
              <span>{d.name}</span>
            </div>
          ))}
        </div>

        <div className={styles.browserFooter}>
          <span className={styles.selectedPath}>{path}</span>
          <button className="ghost" onClick={onClose}>Cancel</button>
          <button className="primary" onClick={() => onSelect(path)}>
            Select this folder
          </button>
        </div>
      </div>
    </div>
  )
}

// ── Step 0: Welcome ───────────────────────────────────────────────────────────

function WelcomeStep({ onNext }) {
  return (
    <>
      <div className={styles.welcomeIcon}>🎬</div>
      <div>
        <h2 className={styles.cardTitle}>Welcome to Nexus Media Server</h2>
        <p className={styles.cardDesc} style={{ marginTop: 8 }}>
          Let's get your server set up in a few quick steps. You'll create your admin account,
          add your media libraries, and optionally connect TMDB for rich metadata.
        </p>
      </div>
      <ul className={styles.featureList}>
        <li>Stream your movies and TV shows from anywhere</li>
        <li>Automatic metadata from TMDB and local NFO files</li>
        <li>Multi-user with role-based access control</li>
        <li>Hardware-accelerated transcoding (NVIDIA, Intel)</li>
        <li>Extensible with plugins</li>
      </ul>
      <div className={styles.nav}>
        <button className="primary" onClick={onNext}>Get started →</button>
      </div>
    </>
  )
}

// ── Step 1: Admin account ─────────────────────────────────────────────────────

function AccountStep({ form, setForm, error, onBack, onNext }) {
  function validate() {
    if (!form.username.trim()) return 'Username is required'
    if (!form.email.trim()) return 'Email is required'
    if (!form.email.includes('@')) return 'Enter a valid email address'
    if (form.password.length < 8) return 'Password must be at least 8 characters'
    if (form.password !== form.confirm) return 'Passwords do not match'
    return null
  }

  function handleNext() {
    const err = validate()
    if (err) { error.set(err); return }
    error.set(null)
    onNext()
  }

  const f = (field) => ({
    value: form[field],
    onChange: e => setForm(prev => ({ ...prev, [field]: e.target.value })),
  })

  return (
    <>
      <h2 className={styles.cardTitle}>Create admin account</h2>
      <p className={styles.cardDesc}>This account has full control over the server.</p>

      {error.value && <div className={styles.error}>{error.value}</div>}

      <div className={styles.field}>
        <label className={styles.fieldLabel}>Username <span>*</span></label>
        <input type="text" autoComplete="username" autoFocus {...f('username')} />
      </div>
      <div className={styles.field}>
        <label className={styles.fieldLabel}>Email <span>*</span></label>
        <input type="email" autoComplete="email" {...f('email')} />
      </div>
      <div className={styles.field}>
        <label className={styles.fieldLabel}>Password <span>*</span></label>
        <input type="password" autoComplete="new-password" {...f('password')} />
        <span className={styles.hint}>Minimum 8 characters</span>
      </div>
      <div className={styles.field}>
        <label className={styles.fieldLabel}>Confirm password <span>*</span></label>
        <input type="password" autoComplete="new-password" {...f('confirm')}
          onKeyDown={e => e.key === 'Enter' && handleNext()} />
      </div>

      <div className={styles.nav}>
        <button className="ghost" onClick={onBack}>← Back</button>
        <button className="primary" onClick={handleNext}>Next →</button>
      </div>
    </>
  )
}

// ── Step 2: Libraries ─────────────────────────────────────────────────────────

const LIB_TYPES = [
  { value: 'movies', label: 'Movies' },
  { value: 'tv',     label: 'TV Shows' },
  { value: 'music',  label: 'Music' },
]

function LibrariesStep({ libraries, setLibraries, onBack, onNext }) {
  const [showForm, setShowForm] = useState(false)
  const [showBrowser, setShowBrowser] = useState(false)
  const [activePath, setActivePath] = useState(null) // index into draft.paths for browser
  const [draft, setDraft] = useState({ name: '', type: 'movies', paths: [''] })

  function addPath() {
    setDraft(d => ({ ...d, paths: [...d.paths, ''] }))
  }

  function removePath(i) {
    setDraft(d => ({ ...d, paths: d.paths.filter((_, idx) => idx !== i) }))
  }

  function setPath(i, val) {
    setDraft(d => {
      const paths = [...d.paths]
      paths[i] = val
      return { ...d, paths }
    })
  }

  function openBrowser(i) {
    setActivePath(i)
    setShowBrowser(true)
  }

  function handleBrowseSelect(path) {
    setPath(activePath, path)
    setShowBrowser(false)
    setActivePath(null)
  }

  function saveLib() {
    const paths = draft.paths.map(p => p.trim()).filter(Boolean)
    if (!draft.name.trim() || paths.length === 0) return
    setLibraries(prev => [...prev, { ...draft, paths }])
    setDraft({ name: '', type: 'movies', paths: [''] })
    setShowForm(false)
  }

  function removeLib(i) {
    setLibraries(prev => prev.filter((_, idx) => idx !== i))
  }

  return (
    <>
      <h2 className={styles.cardTitle}>Add media libraries</h2>
      <p className={styles.cardDesc}>
        Tell Nexus where your media files live inside the container. Mount your host folders as
        Docker volumes (e.g. <code>-v /mnt/movies:/movies:ro</code>) then select those paths here.
        You can add more libraries any time from Settings.
      </p>

      <div className={styles.libList}>
        {libraries.length === 0 && !showForm && (
          <div className={styles.emptyLib}>No libraries added yet</div>
        )}
        {libraries.map((lib, i) => (
          <div key={i} className={styles.libCard}>
            <div className={styles.libCardHeader}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <span className={styles.libCardName}>{lib.name}</span>
                <span className={styles.libTypeBadge}>
                  {LIB_TYPES.find(t => t.value === lib.type)?.label ?? lib.type}
                </span>
              </div>
              <button className="ghost" style={{ fontSize: 12 }} onClick={() => removeLib(i)}>
                Remove
              </button>
            </div>
            <div className={styles.libPaths}>
              {lib.paths.map((p, j) => <div key={j} className={styles.libPath}>{p}</div>)}
            </div>
          </div>
        ))}

        {showForm && (
          <div className={styles.addLibForm}>
            <div className={styles.formRow}>
              <div className={styles.field}>
                <label className={styles.fieldLabel}>Library name</label>
                <input
                  type="text"
                  placeholder="My Movies"
                  autoFocus
                  value={draft.name}
                  onChange={e => setDraft(d => ({ ...d, name: e.target.value }))}
                />
              </div>
              <div className={styles.field}>
                <label className={styles.fieldLabel}>Type</label>
                <select
                  value={draft.type}
                  onChange={e => setDraft(d => ({ ...d, type: e.target.value }))}
                  style={{ width: '100%' }}
                >
                  {LIB_TYPES.map(t => (
                    <option key={t.value} value={t.value}>{t.label}</option>
                  ))}
                </select>
              </div>
            </div>

            <div className={styles.field}>
              <label className={styles.fieldLabel}>Folders</label>
              <div className={styles.pathList}>
                {draft.paths.map((p, i) => (
                  <div key={i} className={styles.pathRow}>
                    <input
                      type="text"
                      placeholder="/movies"
                      value={p}
                      onChange={e => setPath(i, e.target.value)}
                    />
                    <button className="ghost" onClick={() => openBrowser(i)}>Browse</button>
                    {draft.paths.length > 1 && (
                      <button className="ghost" onClick={() => removePath(i)}
                        style={{ color: 'var(--danger)', flexShrink: 0 }}>✕</button>
                    )}
                  </div>
                ))}
              </div>
              <button className="ghost" style={{ alignSelf: 'flex-start', marginTop: 4, fontSize: 12 }}
                onClick={addPath}>
                + Add another folder
              </button>
            </div>

            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
              <button className="ghost" onClick={() => setShowForm(false)}>Cancel</button>
              <button
                className="primary"
                onClick={saveLib}
                disabled={!draft.name.trim() || draft.paths.every(p => !p.trim())}
              >
                Add library
              </button>
            </div>
          </div>
        )}
      </div>

      {!showForm && (
        <button className="ghost" style={{ alignSelf: 'flex-start' }}
          onClick={() => setShowForm(true)}>
          + Add library
        </button>
      )}

      <div className={styles.nav}>
        <button className="ghost" onClick={onBack}>← Back</button>
        <button className="ghost" onClick={onNext}>Skip</button>
        <button className="primary" onClick={onNext}
          disabled={libraries.length === 0}>
          Next →
        </button>
      </div>

      {showBrowser && (
        <DirBrowser
          onSelect={handleBrowseSelect}
          onClose={() => { setShowBrowser(false); setActivePath(null) }}
        />
      )}
    </>
  )
}

// ── Step 3: Metadata ──────────────────────────────────────────────────────────

function MetadataStep({ tmdbKey, setTmdbKey, error, loading, onBack, onSubmit }) {
  return (
    <>
      <h2 className={styles.cardTitle}>Metadata</h2>
      <p className={styles.cardDesc}>
        Nexus fetches posters, descriptions, and ratings from The Movie Database (TMDB).
        This is optional — you can add the key later in Settings → Metadata.
      </p>

      {error && <div className={styles.error}>{error}</div>}

      <div className={styles.field}>
        <label className={styles.fieldLabel}>
          TMDB API key
          <a
            href="https://www.themoviedb.org/settings/api"
            target="_blank"
            rel="noreferrer"
            className={styles.tmdbLink}
            style={{ marginLeft: 8 }}
          >
            Get a free key →
          </a>
        </label>
        <input
          type="password"
          placeholder="Optional"
          autoComplete="off"
          value={tmdbKey}
          onChange={e => setTmdbKey(e.target.value)}
          onKeyDown={e => e.key === 'Enter' && onSubmit()}
        />
      </div>

      <div className={styles.nav}>
        <button className="ghost" onClick={onBack} disabled={loading}>← Back</button>
        <button className="ghost" onClick={onSubmit} disabled={loading}>
          {loading ? 'Setting up…' : 'Skip'}
        </button>
        <button className="primary" onClick={onSubmit} disabled={loading}>
          {loading ? 'Setting up…' : 'Finish setup →'}
        </button>
      </div>
    </>
  )
}

// ── Step 4: Finish ────────────────────────────────────────────────────────────

function FinishStep({ onComplete }) {
  return (
    <>
      <div className={styles.finishIcon}>✓</div>
      <div style={{ textAlign: 'center' }}>
        <h2 className={styles.cardTitle}>Setup complete</h2>
        <p className={styles.cardDesc} style={{ marginTop: 8 }}>
          Your Nexus Media Server is ready. Sign in with your admin account to get started.
        </p>
      </div>
      <div className={styles.nav} style={{ justifyContent: 'center' }}>
        <button className="primary" onClick={onComplete}>Go to login →</button>
      </div>
    </>
  )
}

// ── Wizard root ───────────────────────────────────────────────────────────────

export default function Setup({ onComplete }) {
  const [step, setStep] = useState(0)

  // Admin account form state
  const [adminForm, setAdminForm] = useState({ username: '', email: '', password: '', confirm: '' })
  const adminError = useFormError()

  // Libraries state
  const [libraries, setLibraries] = useState([])

  // TMDB state
  const [tmdbKey, setTmdbKey] = useState('')
  const [submitError, setSubmitError] = useState(null)
  const [loading, setLoading] = useState(false)

  function next() { setStep(s => Math.min(s + 1, STEPS.length - 1)) }
  function back() { setStep(s => Math.max(s - 1, 0)) }

  async function submit() {
    setLoading(true)
    setSubmitError(null)
    try {
      await axios.post('/api/v1/setup/complete', {
        admin: {
          username: adminForm.username,
          email:    adminForm.email,
          password: adminForm.password,
        },
        libraries,
        tmdb_api_key: tmdbKey,
      })
      next()  // → step 4 (Finish)
    } catch (err) {
      setSubmitError(err.response?.data?.error ?? 'Setup failed — check server logs')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className={styles.page}>
      <div className={styles.wizard}>
        <div className={styles.logo}>Nexus</div>

        {step < STEPS.length - 1 && <StepTrack current={step} />}

        <div className={styles.card}>
          {step === 0 && <WelcomeStep onNext={next} />}

          {step === 1 && (
            <AccountStep
              form={adminForm}
              setForm={setAdminForm}
              error={adminError}
              onBack={back}
              onNext={next}
            />
          )}

          {step === 2 && (
            <LibrariesStep
              libraries={libraries}
              setLibraries={setLibraries}
              onBack={back}
              onNext={next}
            />
          )}

          {step === 3 && (
            <MetadataStep
              tmdbKey={tmdbKey}
              setTmdbKey={setTmdbKey}
              error={submitError}
              loading={loading}
              onBack={back}
              onSubmit={submit}
            />
          )}

          {step === 4 && <FinishStep onComplete={onComplete} />}
        </div>
      </div>
    </div>
  )
}

// ── Helper hook ───────────────────────────────────────────────────────────────

function useFormError() {
  const [value, setError] = useState(null)
  return { value, set: setError }
}
