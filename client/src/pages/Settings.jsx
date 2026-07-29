import { useState, useEffect, useCallback, Fragment } from 'react'
import { useNavigate } from 'react-router-dom'
import { api } from '../api/client.js'
import styles from './Settings.module.css'

const TABS = [
  { id: 'overview',    label: 'Overview' },
  { id: 'activity',    label: 'Activity' },
  { id: 'general',     label: 'General' },
  { id: 'metadata',    label: 'Metadata' },
  { id: 'library',     label: 'Libraries' },
  { id: 'transcoding', label: 'Transcoding' },
  { id: 'transcoders', label: 'Transcoder Nodes' },
  { id: 'tasks',       label: 'Scheduled Tasks' },
  { id: 'stats',       label: 'Playback Stats' },
  { id: 'plugins',     label: 'Plugins' },
  { id: 'users',       label: 'Users' },
  { id: 'sessions',    label: 'My Sessions' },
]

export default function Settings() {
  const [activeTab, setActiveTab] = useState('overview')
  const [settings, setSettings] = useState(null)
  const [toast, setToast] = useState(null)
  const navigate = useNavigate()

  const user = JSON.parse(localStorage.getItem('nexus_user') ?? '{}')

  const showToast = useCallback((msg, type = 'success') => {
    setToast({ msg, type })
    setTimeout(() => setToast(null), 3000)
  }, [])

  useEffect(() => {
    api.get('/settings')
      .then(r => setSettings(r.data))
      .catch(() => showToast('Failed to load settings', 'error'))
  }, [showToast])

  async function save(updates) {
    try {
      await api.put('/settings', updates)
      setSettings(prev => {
        const next = { ...prev }
        for (const [key, value] of Object.entries(updates)) {
          // A setting's key prefix (e.g. "auth.", "tmdb.") doesn't necessarily
          // match its actual category (e.g. category='general'/'metadata') —
          // search every category's rows instead of guessing from the key.
          for (const cat of Object.keys(next)) {
            if (!Array.isArray(next[cat])) continue
            const idx = next[cat].findIndex(s => s.key === key)
            if (idx !== -1) {
              next[cat] = [...next[cat]]
              next[cat][idx] = { ...next[cat][idx], value }
              break
            }
          }
        }
        return next
      })
      showToast('Settings saved')
    } catch {
      showToast('Failed to save settings', 'error')
    }
  }

  function logout() {
    localStorage.clear()
    navigate('/login')
  }

  if (!settings) {
    return <div className={styles.loading}>Loading settings…</div>
  }

  return (
    <div className={styles.layout}>
      <aside className={styles.sidebar}>
        <div className={styles.brand}>
          <span className={styles.brandName}>Nexus</span>
          <span className={styles.brandSub}>Admin</span>
        </div>
        <nav>
          {TABS.map(tab => (
            <button
              key={tab.id}
              className={`${styles.navBtn} ${activeTab === tab.id ? styles.active : ''}`}
              onClick={() => setActiveTab(tab.id)}
            >
              {tab.label}
            </button>
          ))}
        </nav>
        <div className={styles.sidebarFooter}>
          <span className={styles.userChip}>{user.username}</span>
          <button className="ghost" onClick={logout}>Sign out</button>
        </div>
      </aside>

      <main className={styles.main}>
        <header className={styles.header}>
          <h2>{TABS.find(t => t.id === activeTab)?.label}</h2>
        </header>

        <div className={styles.content}>
          {activeTab === 'overview'    && <OverviewTab onNavigate={setActiveTab} />}
          {activeTab === 'activity'    && <ActivityTab />}
          {activeTab === 'general'     && <GeneralTab     rows={settings.general ?? []}     save={save} />}
          {activeTab === 'metadata'    && <MetadataTab    rows={settings.metadata ?? []}    save={save} />}
          {activeTab === 'library'     && <LibraryTab     rows={settings.library ?? []}     save={save} />}
          {activeTab === 'transcoding' && <TranscodingTab rows={settings.transcoding ?? []} save={save} />}
          {activeTab === 'transcoders' && <TranscoderNodes />}
          {activeTab === 'tasks'       && <TasksTab />}
          {activeTab === 'stats'       && <StatsTab />}
          {activeTab === 'plugins'     && <PluginsTab />}
          {activeTab === 'users'       && <UsersTab />}
          {activeTab === 'sessions'    && <SessionsTab />}
        </div>
      </main>

      {toast && (
        <div className={`${styles.toast} ${styles[toast.type]}`}>
          {toast.msg}
        </div>
      )}
    </div>
  )
}

// ─── Generic form builder ────────────────────────────────────────────────────

function SettingsForm({ rows, save }) {
  const initial = Object.fromEntries(rows.map(r => [r.key, r.value]))
  const [values, setValues] = useState(initial)
  const [dirty, setDirty] = useState(false)

  function set(key, value) {
    setValues(v => ({ ...v, [key]: value }))
    setDirty(true)
  }

  function submit(e) {
    e.preventDefault()
    save(values).then(() => setDirty(false))
  }

  return (
    <form className={styles.form} onSubmit={submit}>
      {rows.map(row => (
        <SettingRow key={row.key} row={row} value={values[row.key]} onChange={v => set(row.key, v)} />
      ))}
      <div className={styles.formFooter}>
        <button className="primary" type="submit" disabled={!dirty}>Save changes</button>
      </div>
    </form>
  )
}

function SettingRow({ row, value, onChange }) {
  const type = inferType(row.key, value)

  return (
    <div className={styles.row}>
      <div className={styles.rowMeta}>
        <label className={styles.rowLabel} htmlFor={row.key}>{row.label}</label>
        {row.description && <p className={styles.rowDesc}>{row.description}</p>}
      </div>
      <div className={styles.rowControl}>
        {type === 'boolean' && (
          <Toggle id={row.key} checked={value} onChange={onChange} />
        )}
        {type === 'select' && (
          <select id={row.key} value={value} onChange={e => onChange(e.target.value)}>
            {getOptions(row.key).map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
        )}
        {type === 'password' && (
          <input id={row.key} type="password" value={value ?? ''} placeholder="(unchanged)"
            onChange={e => onChange(e.target.value)} autoComplete="new-password" />
        )}
        {type === 'number' && (
          <input id={row.key} type="number" value={value ?? ''} onChange={e => onChange(e.target.value === '' ? null : Number(e.target.value))} />
        )}
        {type === 'text' && (
          <input id={row.key} type="text" value={value ?? ''} onChange={e => onChange(e.target.value)} />
        )}
      </div>
    </div>
  )
}

function Toggle({ id, checked, onChange }) {
  return (
    <label className={styles.toggle}>
      <input id={id} type="checkbox" checked={!!checked} onChange={e => onChange(e.target.checked)} />
      <span className={styles.toggleTrack} />
    </label>
  )
}

function inferType(key, value) {
  if (typeof value === 'boolean') return 'boolean'
  if (key.includes('api_key') || key.includes('secret')) return 'password'
  if (SELECT_KEYS.has(key)) return 'select'
  if (typeof value === 'number' || value === null) return 'number'
  return 'text'
}

const SELECT_KEYS = new Set([
  'auth.default_role',
  'transcoding.default_codec',
  'transcoding.default_resolution',
])

function getOptions(key) {
  switch (key) {
    case 'auth.default_role':           return [{ value: 'viewer', label: 'Viewer' }, { value: 'admin', label: 'Admin' }]
    case 'transcoding.default_codec':   return [{ value: 'h264', label: 'H.264 (broad compatibility)' }, { value: 'h265', label: 'H.265 (smaller files)' }]
    case 'transcoding.default_resolution': return ['4k', '1080p', '720p', '480p', '360p'].map(v => ({ value: v, label: v }))
    default: return []
  }
}

// ─── Tab components ──────────────────────────────────────────────────────────

function GeneralTab({ rows, save }) {
  return <SettingsForm rows={rows} save={save} />
}

function MetadataTab({ rows, save }) {
  return <SettingsForm rows={rows} save={save} />
}

const LIBRARY_TYPES = [
  { value: 'movies', label: 'Movies' },
  { value: 'series', label: 'TV Series' },
  { value: 'music',  label: 'Music' },
]

function LibraryTab({ rows, save }) {
  const [libraries, setLibraries] = useState([])
  const [form,      setForm]      = useState({ name: '', type: 'movies', paths: [''] })
  const [adding,    setAdding]    = useState(false)
  const [error,     setError]     = useState(null)

  useEffect(() => {
    loadLibraries()
  }, [])

  // Poll every 3 s while any library is scanning so the UI stays live.
  useEffect(() => {
    const anyScanning = libraries.some(l => l.scan_status === 'scanning')
    if (!anyScanning) return
    const timer = setTimeout(loadLibraries, 3000)
    return () => clearTimeout(timer)
  }, [libraries])

  async function loadLibraries() {
    const { data } = await api.get('/libraries')
    setLibraries(data)
  }

  async function triggerScan(id) {
    // Optimistically mark as scanning so the button disables immediately.
    setLibraries(ls => ls.map(l => l.id === id ? { ...l, scan_status: 'scanning' } : l))
    try {
      await api.post(`/libraries/${id}/scan`)
    } catch {
      // Revert on error; next poll will get the real state.
      loadLibraries()
    }
  }

  async function deleteLibrary(id, name) {
    if (!confirm(`Delete library "${name}"?\n\nMedia items will be removed from the database. Your files will not be deleted.`)) return
    await api.delete(`/libraries/${id}`)
    setLibraries(ls => ls.filter(l => l.id !== id))
  }

  async function addLibrary(e) {
    e.preventDefault()
    setError(null)
    setAdding(true)
    try {
      const paths = form.paths.map(p => p.trim()).filter(Boolean)
      if (!paths.length) { setError('At least one path is required'); return }
      await api.post('/libraries', { name: form.name.trim(), type: form.type, paths })
      setForm({ name: '', type: 'movies', paths: [''] })
      loadLibraries()
    } catch (err) {
      setError(err.response?.data?.error ?? 'Failed to add library')
    } finally {
      setAdding(false)
    }
  }

  function setPath(i, value) {
    setForm(f => { const paths = [...f.paths]; paths[i] = value; return { ...f, paths } })
  }

  function ScanBadge({ lib }) {
    if (lib.scan_status === 'scanning') return <span style={badge('#f0a500')}>scanning…</span>
    if (lib.scan_status === 'error')    return <span style={badge('#e05555')}>scan error — check server logs</span>
    if (lib.last_scanned_at)            return <span style={badge('#4caf7d')}>ready</span>
    return null
  }

  function LibStats({ lib }) {
    const count = lib.item_count ?? 0
    if (count === 0) return <span>No items scanned yet</span>
    if (lib.type === 'movies') return <span>{count} movie{count !== 1 ? 's' : ''}</span>
    if (lib.type === 'series' || lib.type === 'tv') {
      const eps = lib.episode_count ?? 0
      return <span>{count} series · {eps} episode{eps !== 1 ? 's' : ''}</span>
    }
    return <span>{count} item{count !== 1 ? 's' : ''}</span>
  }

  return (
    <div className={styles.section}>
      {/* ── Scan settings ───────────────────────────────────────────────── */}
      <SettingsForm rows={rows} save={save} />

      <div className={styles.divider} />

      {/* ── Existing libraries ──────────────────────────────────────────── */}
      <h3 className={styles.subheading}>Your libraries</h3>

      {libraries.length === 0
        ? <p className={styles.empty}>No libraries added yet.</p>
        : (
          <div className={styles.nodeList}>
            {libraries.map(lib => (
              <div key={lib.id} className={styles.nodeCard}>
                <div className={styles.nodeInfo}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                    <strong>{lib.name}</strong>
                    <span style={badge('#7c6af7')}>{lib.type}</span>
                    <ScanBadge lib={lib} />
                  </div>
                  <span className={styles.nodeUrl}>{lib.paths?.join('  ·  ')}</span>
                  <span className={styles.nodeMeta}>
                    <LibStats lib={lib} />
                    {lib.last_scanned_at && (
                      <> · Last scanned {new Date(lib.last_scanned_at).toLocaleString()}</>
                    )}
                  </span>
                </div>
                <div className={styles.nodeActions}>
                  <button
                    className="ghost"
                    disabled={lib.scan_status === 'scanning'}
                    onClick={() => triggerScan(lib.id)}
                  >
                    {lib.scan_status === 'scanning' ? 'Scanning…' : 'Scan now'}
                  </button>
                  <button className="danger" onClick={() => deleteLibrary(lib.id, lib.name)}>Delete</button>
                </div>
              </div>
            ))}
          </div>
        )
      }

      {/* ── Add library ─────────────────────────────────────────────────── */}
      <div className={styles.card}>
        <h3>Add library</h3>
        {error && <div className={styles.inlineError}>{error}</div>}
        <form className={styles.form} onSubmit={addLibrary}>
          <div className={styles.row}>
            <div className={styles.rowMeta}>
              <label className={styles.rowLabel}>Name</label>
            </div>
            <div className={styles.rowControl}>
              <input
                placeholder="e.g. Movies"
                value={form.name}
                onChange={e => setForm(f => ({ ...f, name: e.target.value }))}
                required
              />
            </div>
          </div>

          <div className={styles.row}>
            <div className={styles.rowMeta}>
              <label className={styles.rowLabel}>Type</label>
            </div>
            <div className={styles.rowControl}>
              <select
                value={form.type}
                onChange={e => setForm(f => ({ ...f, type: e.target.value }))}
                style={{ width: 'auto' }}
              >
                {LIBRARY_TYPES.map(t => <option key={t.value} value={t.value}>{t.label}</option>)}
              </select>
            </div>
          </div>

          <div className={styles.row}>
            <div className={styles.rowMeta}>
              <label className={styles.rowLabel}>Paths</label>
              <p className={styles.rowDesc}>Container-side paths to scan. Add multiple if your media is spread across directories.</p>
            </div>
            <div className={styles.rowControl}>
              {form.paths.map((p, i) => (
                <div key={i} style={{ display: 'flex', gap: 8, marginBottom: 8 }}>
                  <input
                    placeholder="/media/movies"
                    value={p}
                    onChange={e => setPath(i, e.target.value)}
                    required={i === 0}
                  />
                  {form.paths.length > 1 && (
                    <button
                      type="button" className="ghost"
                      style={{ flexShrink: 0, padding: '8px 12px' }}
                      onClick={() => setForm(f => ({ ...f, paths: f.paths.filter((_, j) => j !== i) }))}
                    >✕</button>
                  )}
                </div>
              ))}
              <button
                type="button" className="ghost"
                style={{ width: 'auto', fontSize: 13 }}
                onClick={() => setForm(f => ({ ...f, paths: [...f.paths, ''] }))}
              >
                + Add path
              </button>
            </div>
          </div>

          <div className={styles.formFooter}>
            <button className="primary" type="submit" disabled={adding}>
              {adding ? 'Adding…' : 'Add library'}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}

function TranscodingTab({ rows, save }) {
  return <SettingsForm rows={rows} save={save} />
}

// ─── Transcoder nodes ────────────────────────────────────────────────────────

const HW_ACCEL_COLORS = {
  nvenc: '#76b900',   // NVIDIA green
  vaapi: '#0071c5',   // Intel blue
  qsv:   '#0071c5',   // Intel blue
  cpu:   '#888',
}
const HW_ACCEL_LABELS = { nvenc: 'NVENC', vaapi: 'VAAPI', qsv: 'QSV', cpu: 'CPU' }

function HwAccelBadge({ hw }) {
  const color = HW_ACCEL_COLORS[hw] ?? '#888'
  const label = HW_ACCEL_LABELS[hw] ?? (hw ?? 'CPU').toUpperCase()
  return (
    <span style={{
      background: color + '22', border: `1px solid ${color}`,
      borderRadius: 4, padding: '1px 7px', fontSize: 11, color,
      fontWeight: 600, letterSpacing: '0.03em',
    }}>
      {label}
    </span>
  )
}

function TranscoderNodes() {
  const [nodes, setNodes] = useState([])
  const [form, setForm] = useState({ name: '', url: '', hw_accel: 'cpu', priority: '' })
  const [error, setError] = useState(null)
  const [editingPriority, setEditingPriority] = useState({})  // id → draft value

  useEffect(() => { loadNodes() }, [])

  async function loadNodes() {
    const { data } = await api.get('/transcoders')
    setNodes(data)
  }

  async function add(e) {
    e.preventDefault()
    setError(null)
    try {
      const payload = { name: form.name, url: form.url, hw_accel: form.hw_accel }
      if (form.priority !== '') payload.priority = parseInt(form.priority)
      await api.post('/transcoders', payload)
      setForm({ name: '', url: '', hw_accel: 'cpu', priority: '' })
      loadNodes()
    } catch (err) {
      setError(err.response?.data?.error ?? 'Failed to add node')
    }
  }

  async function toggle(node) {
    await api.patch(`/transcoders/${node.id}`, { is_enabled: !node.is_enabled })
    loadNodes()
  }

  async function remove(id) {
    if (!confirm('Remove this transcoder node?')) return
    await api.delete(`/transcoders/${id}`)
    loadNodes()
  }

  async function checkHealth(id) {
    try {
      const { data } = await api.get(`/transcoders/${id}/health`)
      alert(`Healthy — ${data.active_sessions} active session(s) · ${(data.hw_accel ?? 'cpu').toUpperCase()}`)
    } catch {
      alert('Node is unreachable')
    }
  }

  async function savePriority(node) {
    const val = editingPriority[node.id]
    if (val === undefined || val === String(node.priority)) {
      setEditingPriority(p => { const n = { ...p }; delete n[node.id]; return n })
      return
    }
    await api.patch(`/transcoders/${node.id}`, { priority: parseInt(val) })
    setEditingPriority(p => { const n = { ...p }; delete n[node.id]; return n })
    loadNodes()
  }

  return (
    <div className={styles.section}>
      <p className={styles.sectionDesc}>
        Transcoder nodes process your media into HLS streams. They auto-register on startup.
        Higher-priority nodes are preferred for new sessions. The built-in CPU transcoder
        always runs inside the app container as a fallback.
      </p>

      <div className={styles.nodeList}>
        {nodes.length === 0 && <p className={styles.empty}>No transcoder nodes registered.</p>}
        {nodes.map(node => (
          <div key={node.id} className={`${styles.nodeCard} ${!node.is_enabled ? styles.disabled : ''}`}>
            <div className={styles.nodeInfo}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <strong>{node.name}</strong>
                <HwAccelBadge hw={node.hw_accel} />
                {node.is_builtin && (
                  <span style={{ ...badge('#888'), fontSize: 10 }}>built-in</span>
                )}
              </div>
              <span className={styles.nodeUrl}>{node.url}</span>
              <span className={styles.nodeMeta}>
                {node.active_sessions ?? 0} active sessions
                {node.last_seen_at && ` · last seen ${new Date(node.last_seen_at).toLocaleString()}`}
              </span>
            </div>

            <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
              <label style={{ fontSize: 12, color: 'var(--text-muted)', display: 'flex', alignItems: 'center', gap: 6 }}>
                Priority
                <input
                  type="number"
                  style={{ width: 56, textAlign: 'center' }}
                  value={editingPriority[node.id] ?? node.priority ?? 0}
                  onChange={e => setEditingPriority(p => ({ ...p, [node.id]: e.target.value }))}
                  onBlur={() => savePriority(node)}
                  onKeyDown={e => e.key === 'Enter' && savePriority(node)}
                />
              </label>

              <div className={styles.nodeActions}>
                <button className="ghost" onClick={() => checkHealth(node.id)}>Ping</button>
                <button className="ghost" onClick={() => toggle(node)}>
                  {node.is_enabled ? 'Disable' : 'Enable'}
                </button>
                {!node.is_builtin && (
                  <button className="danger" onClick={() => remove(node.id)}>Remove</button>
                )}
              </div>
            </div>
          </div>
        ))}
      </div>

      <div className={styles.card}>
        <h3>Add node manually</h3>
        {error && <div className={styles.inlineError}>{error}</div>}
        <form className={styles.inlineForm} onSubmit={add}>
          <input
            placeholder="Name (e.g. remote-gpu-1)"
            value={form.name}
            onChange={e => setForm(f => ({ ...f, name: e.target.value }))}
            required
          />
          <input
            placeholder="URL (e.g. http://192.168.1.50:3001)"
            value={form.url}
            onChange={e => setForm(f => ({ ...f, url: e.target.value }))}
            required
          />
          <select
            value={form.hw_accel}
            onChange={e => setForm(f => ({ ...f, hw_accel: e.target.value }))}
            style={{ width: 'auto' }}
          >
            <option value="cpu">CPU (software)</option>
            <option value="nvenc">NVENC (NVIDIA)</option>
            <option value="vaapi">VAAPI (Intel/AMD)</option>
            <option value="qsv">QuickSync (Intel)</option>
          </select>
          <input
            type="number"
            placeholder="Priority (optional)"
            value={form.priority}
            onChange={e => setForm(f => ({ ...f, priority: e.target.value }))}
            style={{ width: 120 }}
          />
          <button className="primary" type="submit">Add</button>
        </form>
      </div>
    </div>
  )
}

// ─── Scheduled tasks ─────────────────────────────────────────────────────────

// Task execution results come from two sources with different casing: a task
// that just ran this process lifetime carries an in-memory camelCase result
// (taskScheduler.js #execute), while one loaded from DB after a restart is
// snake_case (task_results columns). Normalize once so the UI doesn't care.
function normalizeResult(r) {
  if (!r) return null
  return {
    status:       r.status,
    startedAt:    r.startedAt    ?? r.started_at,
    endedAt:      r.endedAt      ?? r.ended_at,
    durationMs:   r.durationMs   ?? r.duration_ms,
    errorMessage: r.errorMessage ?? r.error_message,
  }
}

const TASK_STATUS_COLOR = { completed: '#4caf7d', failed: '#e05555', cancelled: '#888' }

function TasksTab() {
  const [tasks, setTasks]     = useState([])
  const [loading, setLoading] = useState(true)
  const [editing, setEditing] = useState(null) // task id currently expanded for schedule editing

  const load = useCallback(() => {
    return api.get('/tasks').then(r => setTasks(r.data)).catch(() => {})
  }, [])

  useEffect(() => {
    load().finally(() => setLoading(false))
    // Poll while this tab is mounted — cheap for an admin-only, low-traffic
    // view, and avoids wiring a dedicated SSE channel for task state.
    const interval = setInterval(load, 3000)
    return () => clearInterval(interval)
  }, [load])

  async function run(id) {
    try { await api.post(`/tasks/${id}/run`); load() }
    catch (err) { alert(err.response?.data?.error ?? 'Failed to start task') }
  }

  async function cancel(id) {
    try { await api.delete(`/tasks/${id}/run`); load() }
    catch (err) { alert(err.response?.data?.error ?? 'Failed to cancel task') }
  }

  if (loading) return <p className={styles.empty}>Loading tasks…</p>

  const byCategory = tasks.reduce((acc, t) => {
    (acc[t.category] ??= []).push(t)
    return acc
  }, {})

  return (
    <div className={styles.section}>
      <p className={styles.sectionDesc}>
        Background maintenance jobs — library scans, metadata refresh, session cleanup.
        Triggers run automatically; you can also start or cancel any task manually.
      </p>

      {Object.entries(byCategory).map(([category, categoryTasks]) => (
        <div key={category} className={styles.taskCategory}>
          <h3 className={styles.taskCategoryTitle}>{category}</h3>
          <div className={styles.nodeList}>
            {categoryTasks.map(task => (
              <TaskRow
                key={task.id}
                task={task}
                onRun={() => run(task.id)}
                onCancel={() => cancel(task.id)}
                editing={editing === task.id}
                onToggleEdit={() => setEditing(e => e === task.id ? null : task.id)}
                onSaved={load}
              />
            ))}
          </div>
        </div>
      ))}
    </div>
  )
}

function TaskRow({ task, onRun, onCancel, editing, onToggleEdit, onSaved }) {
  const running = task.status === 'running' || task.status === 'cancelling'
  const result  = normalizeResult(task.last_result)

  return (
    <div className={`${styles.nodeCard} ${!task.is_enabled ? styles.disabled : ''}`} style={{ flexDirection: 'column', alignItems: 'stretch', gap: 10 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12 }}>
        <div className={styles.nodeInfo}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <strong>{task.name}</strong>
            {running && <span style={badge('#7c6af7')}>{task.status}</span>}
            {!task.is_enabled && <span style={badge('#888')}>disabled</span>}
          </div>
          <span className={styles.nodeMeta}>{task.description}</span>
          <span className={styles.nodeMeta}>
            {describeTriggers(task.triggers)}
            {result && (
              <>
                {' · last run '}
                <span style={{ color: TASK_STATUS_COLOR[result.status] ?? 'inherit' }}>{result.status}</span>
                {' '}{timeAgo(result.endedAt)}
                {result.durationMs != null && ` (${(result.durationMs / 1000).toFixed(1)}s)`}
                {result.status === 'failed' && result.errorMessage && ` — ${result.errorMessage}`}
              </>
            )}
          </span>
        </div>

        <div className={styles.nodeActions} style={{ alignItems: 'flex-start' }}>
          <button className="ghost" onClick={onToggleEdit}>{editing ? 'Close' : 'Schedule'}</button>
          {running ? (
            <button className="danger" onClick={onCancel} disabled={task.status === 'cancelling'}>
              {task.status === 'cancelling' ? 'Cancelling…' : 'Cancel'}
            </button>
          ) : (
            <button className="primary" onClick={onRun}>Run now</button>
          )}
        </div>
      </div>

      {task.status === 'running' && (
        <div className={styles.taskProgressTrack}>
          <div
            className={styles.taskProgressFill}
            style={{ width: task.progress != null ? `${task.progress}%` : '100%' }}
          />
        </div>
      )}

      {editing && <TaskScheduleEditor task={task} onSaved={() => { onSaved(); onToggleEdit() }} />}
    </div>
  )
}

function describeTriggers(triggers) {
  if (!triggers?.length) return 'No triggers — manual only'
  return triggers.map(t => {
    if (t.type === 'startup')  return 'On startup'
    if (t.type === 'interval') return `Every ${(t.intervalMs / 3_600_000).toFixed(1).replace(/\.0$/, '')}h`
    if (t.type === 'daily')    return `Daily at ${t.timeOfDay}`
    return t.type
  }).join(' · ')
}

function TaskScheduleEditor({ task, onSaved }) {
  const initialInterval = task.triggers?.find(t => t.type === 'interval')
  const initialDaily     = task.triggers?.find(t => t.type === 'daily')

  const [onStartup, setOnStartup]     = useState(!!task.triggers?.find(t => t.type === 'startup'))
  const [intervalOn, setIntervalOn]   = useState(!!initialInterval)
  const [intervalHrs, setIntervalHrs] = useState(initialInterval ? initialInterval.intervalMs / 3_600_000 : 12)
  const [dailyOn, setDailyOn]         = useState(!!initialDaily)
  const [timeOfDay, setTimeOfDay]     = useState(initialDaily?.timeOfDay ?? '03:00')
  const [enabled, setEnabled]         = useState(task.is_enabled)
  const [saving, setSaving]           = useState(false)
  const [error, setError]             = useState(null)

  async function save(e) {
    e.preventDefault()
    setSaving(true)
    setError(null)
    const triggers = []
    if (onStartup)  triggers.push({ type: 'startup' })
    if (intervalOn) triggers.push({ type: 'interval', intervalMs: Math.round(Number(intervalHrs) * 3_600_000) })
    if (dailyOn)    triggers.push({ type: 'daily', timeOfDay })
    try {
      await api.put(`/tasks/${task.id}/triggers`, { triggers, is_enabled: enabled })
      onSaved()
    } catch (err) {
      setError(err.response?.data?.error ?? 'Failed to save schedule')
      setSaving(false)
    }
  }

  return (
    <form className={styles.card} style={{ marginTop: 0 }} onSubmit={save}>
      {error && <div className={styles.inlineError}>{error}</div>}

      <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13 }}>
        <input type="checkbox" checked={enabled} onChange={e => setEnabled(e.target.checked)} />
        Enabled — allow triggers to fire automatically
      </label>

      <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13 }}>
        <input type="checkbox" checked={onStartup} onChange={e => setOnStartup(e.target.checked)} />
        Run on startup
      </label>

      <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13 }}>
        <input type="checkbox" checked={intervalOn} onChange={e => setIntervalOn(e.target.checked)} />
        Run every
        <input
          type="number" min="0.5" step="0.5" style={{ width: 64 }}
          value={intervalHrs} disabled={!intervalOn}
          onChange={e => setIntervalHrs(e.target.value)}
        />
        hours
      </label>

      <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13 }}>
        <input type="checkbox" checked={dailyOn} onChange={e => setDailyOn(e.target.checked)} />
        Run daily at
        <input
          type="time" style={{ width: 110 }}
          value={timeOfDay} disabled={!dailyOn}
          onChange={e => setTimeOfDay(e.target.value)}
        />
      </label>

      <div className={styles.formFooter}>
        <button className="primary" type="submit" disabled={saving}>
          {saving ? 'Saving…' : 'Save schedule'}
        </button>
      </div>
    </form>
  )
}

// ─── Overview ────────────────────────────────────────────────────────────────

const ACTIVITY_SEVERITY_COLOR = { info: '#7c6af7', warning: '#f0a500', error: '#e05555' }

function OverviewTab({ onNavigate }) {
  const [serverInfo, setServerInfo] = useState(null)
  const [counts, setCounts]         = useState(null)
  const [tasks, setTasks]           = useState([])
  const [nodes, setNodes]           = useState([])
  const [activity, setActivity]     = useState([])
  const [scanning, setScanning]     = useState(false)

  const load = useCallback(() => {
    Promise.all([
      api.get('/server/info'),
      api.get('/media/counts'),
      api.get('/tasks'),
      api.get('/transcoders'),
      api.get('/activity', { params: { limit: 7 } }),
    ]).then(([info, cnt, taskList, nodeList, activityList]) => {
      setServerInfo(info.data)
      setCounts(cnt.data)
      setTasks(taskList.data)
      setNodes(nodeList.data)
      setActivity(activityList.data)
    }).catch(() => {})
  }, [])

  useEffect(() => {
    load()
    const interval = setInterval(load, 5000)
    return () => clearInterval(interval)
  }, [load])

  async function scanAllLibraries() {
    const scanTask = tasks.find(t => t.id === 'scan-libraries')
    if (!scanTask) return
    setScanning(true)
    try { await api.post(`/tasks/${scanTask.id}/run`); load() }
    catch { /* button just stops spinning; task list poll will show the real state */ }
    finally { setScanning(false) }
  }

  const runningTasks   = tasks.filter(t => t.status === 'running')
  const nodesOnline    = nodes.filter(n => n.is_enabled && n.last_seen_at && (Date.now() - new Date(n.last_seen_at)) < 120_000).length
  const activeSessions = nodes.reduce((sum, n) => sum + (n.active_sessions ?? 0), 0)

  return (
    <div className={styles.sectionWide}>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: 20 }}>
        {/* Server info */}
        <div className={styles.card}>
          <h3>Server</h3>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 13 }}>
            <span><strong>{serverInfo?.name ?? '—'}</strong></span>
            <span className={styles.nodeMeta}>Version {serverInfo?.version ?? '—'} · API {serverInfo?.api_version ?? '—'}</span>
            <span className={styles.nodeMeta}>{serverInfo?.transcoder_nodes_online ?? 0} transcoder node(s) online</span>
          </div>
          <button className="primary" onClick={scanAllLibraries} disabled={scanning} style={{ alignSelf: 'flex-start' }}>
            {scanning ? 'Starting…' : 'Scan All Libraries'}
          </button>
        </div>

        {/* Item counts */}
        <div className={styles.card}>
          <h3>Library</h3>
          <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
            <StatsTile label="Movies"   value={counts?.movies   ?? '—'} accent="#7c6af7" />
            <StatsTile label="Series"   value={counts?.series   ?? '—'} accent="#4caf7d" />
            <StatsTile label="Episodes" value={counts?.episodes ?? '—'} accent="#f0a500" />
          </div>
        </div>

        {/* Transcoders at a glance */}
        <div className={styles.card}>
          <h3>Transcoders</h3>
          <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
            <StatsTile label="Online" value={`${nodesOnline}/${nodes.length}`} accent="#4caf7d" />
            <StatsTile label="Active sessions" value={activeSessions} accent="#7c6af7" />
          </div>
          <button className="ghost" style={{ alignSelf: 'flex-start' }} onClick={() => onNavigate('transcoders')}>
            View nodes →
          </button>
        </div>

        {/* Running tasks */}
        <div className={styles.card}>
          <h3>Running Tasks</h3>
          {runningTasks.length === 0 ? (
            <p className={styles.empty}>Nothing running right now.</p>
          ) : (
            <div className={styles.nodeList}>
              {runningTasks.map(t => (
                <div key={t.id} style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                  <span style={{ fontSize: 13 }}>{t.name}</span>
                  <div className={styles.taskProgressTrack}>
                    <div className={styles.taskProgressFill} style={{ width: t.progress != null ? `${t.progress}%` : '100%' }} />
                  </div>
                </div>
              ))}
            </div>
          )}
          <button className="ghost" style={{ alignSelf: 'flex-start' }} onClick={() => onNavigate('tasks')}>
            View all tasks →
          </button>
        </div>
      </div>

      {/* Recent activity */}
      <div className={styles.card}>
        <h3>Recent Activity</h3>
        {activity.length === 0 ? (
          <p className={styles.empty}>Nothing to show yet.</p>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            {activity.map(a => <ActivityLine key={a.id} entry={a} />)}
          </div>
        )}
        <button className="ghost" style={{ alignSelf: 'flex-start' }} onClick={() => onNavigate('activity')}>
          View all activity →
        </button>
      </div>
    </div>
  )
}

function ActivityLine({ entry }) {
  const color = ACTIVITY_SEVERITY_COLOR[entry.severity] ?? ACTIVITY_SEVERITY_COLOR.info
  return (
    <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10, fontSize: 13 }}>
      <span style={{ width: 8, height: 8, borderRadius: '50%', background: color, marginTop: 5, flexShrink: 0 }} />
      <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
        <span>{entry.message}</span>
        <span className={styles.nodeMeta}>{timeAgo(entry.created_at)}</span>
      </div>
    </div>
  )
}

// ─── Activity ────────────────────────────────────────────────────────────────

function ActivityTab() {
  const [entries, setEntries] = useState([])
  const [loading, setLoading] = useState(true)
  const [hasMore, setHasMore] = useState(true)

  const loadFirst = useCallback(() => {
    setLoading(true)
    api.get('/activity', { params: { limit: 30 } })
      .then(r => { setEntries(r.data); setHasMore(r.data.length === 30) })
      .catch(() => {})
      .finally(() => setLoading(false))
  }, [])

  useEffect(() => { loadFirst() }, [loadFirst])

  async function loadMore() {
    const before = entries[entries.length - 1]?.created_at
    if (!before) return
    const { data } = await api.get('/activity', { params: { limit: 30, before } })
    setEntries(prev => [...prev, ...data])
    setHasMore(data.length === 30)
  }

  return (
    <div className={styles.section}>
      <p className={styles.sectionDesc}>
        Server audit trail — logins, library scans, plugin and user changes, failed scheduled tasks.
      </p>
      {loading ? (
        <p className={styles.empty}>Loading…</p>
      ) : entries.length === 0 ? (
        <p className={styles.empty}>No activity recorded yet.</p>
      ) : (
        <>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
            {entries.map(entry => <ActivityLine key={entry.id} entry={entry} />)}
          </div>
          {hasMore && (
            <button className="ghost" style={{ alignSelf: 'flex-start' }} onClick={loadMore}>
              Load more
            </button>
          )}
        </>
      )}
    </div>
  )
}

// ─── Plugins ─────────────────────────────────────────────────────────────────

function PluginsTab() {
  const [plugins, setPlugins] = useState([])
  const [expanded, setExpanded] = useState(null)
  const [saving, setSaving] = useState(null)
  const [busy, setBusy] = useState(null)
  const [showCatalog, setShowCatalog] = useState(false)

  const loadPlugins = useCallback(() => { api.get('/plugins').then(r => setPlugins(r.data)) }, [])
  useEffect(loadPlugins, [loadPlugins])

  async function toggleEnabled(plugin) {
    const next = !plugin.is_enabled
    const { data } = await api.patch(`/plugins/${plugin.id}/enabled`, { enabled: next })
    setPlugins(ps => ps.map(p => p.id === plugin.id
      ? { ...p, is_enabled: next, loaded: next && !data.restart_required }
      : p
    ))
  }

  async function reload(plugin) {
    setBusy(plugin.id)
    try {
      await api.post(`/plugins/${plugin.id}/reload`)
      loadPlugins()
    } finally {
      setBusy(null)
    }
  }

  async function uninstall(plugin) {
    if (!confirm(`Uninstall "${plugin.name}"? This deletes its files and settings.`)) return
    setBusy(plugin.id)
    try {
      await api.delete(`/plugins/${plugin.id}`)
      setPlugins(ps => ps.filter(p => p.id !== plugin.id))
    } finally {
      setBusy(null)
    }
  }

  async function saveSettings(plugin, settings) {
    setSaving(plugin.id)
    try {
      const { data } = await api.put(`/plugins/${plugin.id}/settings`, { settings })
      setPlugins(ps => ps.map(p => p.id === plugin.id ? { ...p, settings: data.settings } : p))
    } finally {
      setSaving(null)
    }
  }

  return (
    <div className={styles.section}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 16 }}>
        <p className={styles.sectionDesc}>
          Plugins are loaded from the <code>PLUGINS_DIR</code> directory on the host.
          Enable, disable, install, and settings changes all take effect immediately, without a restart.
        </p>
        <button className="ghost" style={{ whiteSpace: 'nowrap' }} onClick={() => setShowCatalog(s => !s)}>
          {showCatalog ? 'Hide catalog' : 'Browse & install…'}
        </button>
      </div>

      {showCatalog && <PluginCatalogPanel onInstalled={loadPlugins} />}

      {!plugins.length && (
        <div className={styles.card} style={{ fontFamily: 'monospace', fontSize: 13, lineHeight: 1.8, marginTop: 16 }}>
          <strong>Plugin directory structure:</strong>
          <pre style={{ marginTop: 8, color: 'var(--text-muted)' }}>{`plugins/
├── my-plugin/
│   └── index.js     ← exports manifest + hooks
└── single-file.js   ← also valid`}</pre>
        </div>
      )}

      {plugins.map(plugin => (
        <div key={plugin.id} className={`${styles.nodeCard} ${!plugin.is_enabled ? styles.disabled : ''}`}
             style={{ flexDirection: 'column', alignItems: 'stretch', gap: 12, marginTop: 16 }}>

          <div style={{ display: 'flex', alignItems: 'flex-start', gap: 16 }}>
            <div className={styles.nodeInfo} style={{ flex: 1 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <strong>{plugin.name}</strong>
                {plugin.version && <span className={styles.nodeMeta}>v{plugin.version}</span>}
                {plugin.author  && <span className={styles.nodeMeta}>by {plugin.author}</span>}
                <PluginStatusBadge plugin={plugin} />
              </div>
              {plugin.description && <p className={styles.rowDesc} style={{ marginTop: 4 }}>{plugin.description}</p>}
              {plugin.hooks?.length > 0 && (
                <div style={{ marginTop: 6, display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                  {plugin.hooks.map(h => <HookChip key={h} name={h} />)}
                </div>
              )}
              {plugin.error && (
                <p style={{ color: 'var(--danger)', fontSize: 12, marginTop: 6 }}>
                  Load error: {plugin.error}
                </p>
              )}
            </div>

            <div className={styles.nodeActions}>
              {plugin.settings_schema && Object.keys(plugin.settings_schema).length > 0 && (
                <button className="ghost" onClick={() => setExpanded(e => e === plugin.id ? null : plugin.id)}>
                  {expanded === plugin.id ? 'Hide settings' : 'Settings'}
                </button>
              )}
              <button className="ghost" disabled={busy === plugin.id} onClick={() => reload(plugin)}>
                Reload
              </button>
              <button className="ghost" onClick={() => toggleEnabled(plugin)}>
                {plugin.is_enabled ? 'Disable' : 'Enable'}
              </button>
              <button className="danger" disabled={busy === plugin.id} onClick={() => uninstall(plugin)}>
                Uninstall
              </button>
            </div>
          </div>

          {expanded === plugin.id && plugin.settings_schema && (
            <PluginSettingsForm
              plugin={plugin}
              onSave={settings => saveSettings(plugin, settings)}
              saving={saving === plugin.id}
            />
          )}
        </div>
      ))}
    </div>
  )
}

// ── Catalog: repositories + browsable/installable plugins ────────────────────

function PluginCatalogPanel({ onInstalled }) {
  const [sources, setSources] = useState([])
  const [catalog, setCatalog] = useState([])
  const [loading, setLoading] = useState(true)
  const [newSource, setNewSource] = useState({ name: '', url: '' })
  const [manualInstall, setManualInstall] = useState({ downloadUrl: '', pluginName: '' })
  const [installing, setInstalling] = useState(null)
  const [error, setError] = useState(null)

  const load = useCallback(() => {
    setLoading(true)
    Promise.all([api.get('/plugins/catalog/sources'), api.get('/plugins/catalog')])
      .then(([srcRes, catRes]) => { setSources(srcRes.data); setCatalog(catRes.data) })
      .catch(() => setError('Failed to load catalog'))
      .finally(() => setLoading(false))
  }, [])
  useEffect(load, [load])

  async function addSource(e) {
    e.preventDefault()
    if (!newSource.name || !newSource.url) return
    try {
      await api.post('/plugins/catalog/sources', newSource)
      setNewSource({ name: '', url: '' })
      load()
    } catch (err) {
      setError(err.response?.data?.error ?? 'Failed to add source')
    }
  }

  async function removeSource(id) {
    await api.delete(`/plugins/catalog/sources/${id}`)
    load()
  }

  async function installPlugin(downloadUrl, pluginName) {
    setInstalling(pluginName)
    setError(null)
    try {
      await api.post('/plugins/install', { downloadUrl, pluginName })
      onInstalled?.()
      load()
    } catch (err) {
      setError(err.response?.data?.error ?? 'Install failed')
    } finally {
      setInstalling(null)
    }
  }

  async function installFromUrl(e) {
    e.preventDefault()
    if (!manualInstall.downloadUrl) return
    await installPlugin(manualInstall.downloadUrl, manualInstall.pluginName || undefined)
    setManualInstall({ downloadUrl: '', pluginName: '' })
  }

  return (
    <div className={styles.card} style={{ marginTop: 16, display: 'flex', flexDirection: 'column', gap: 20 }}>
      {error && <p style={{ color: 'var(--danger)', fontSize: 13 }}>{error}</p>}

      {/* Repositories */}
      <div>
        <strong style={{ fontSize: 13 }}>Catalog sources</strong>
        {sources.length === 0 && <p className={styles.rowDesc} style={{ marginTop: 4 }}>No catalog sources configured.</p>}
        {sources.map(s => (
          <div key={s.id} style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 8 }}>
            <span style={{ flex: 1, fontSize: 13 }}>{s.name} — <span style={{ color: 'var(--text-muted)' }}>{s.url}</span></span>
            <button className="ghost" onClick={() => removeSource(s.id)}>Remove</button>
          </div>
        ))}
        <form onSubmit={addSource} style={{ display: 'flex', gap: 8, marginTop: 10 }}>
          <input placeholder="Repository name" value={newSource.name}
                 onChange={e => setNewSource(s => ({ ...s, name: e.target.value }))} />
          <input placeholder="https://example.com/catalog.json" style={{ flex: 1 }} value={newSource.url}
                 onChange={e => setNewSource(s => ({ ...s, url: e.target.value }))} />
          <button className="ghost" type="submit">Add source</button>
        </form>
      </div>

      {/* Catalog listing */}
      <div>
        <strong style={{ fontSize: 13 }}>Available plugins</strong>
        {loading && <p className={styles.rowDesc} style={{ marginTop: 4 }}>Loading catalog…</p>}
        {!loading && catalog.every(s => !s.plugins?.length) && (
          <p className={styles.rowDesc} style={{ marginTop: 4 }}>
            No plugins available — add a catalog source above.
          </p>
        )}
        {catalog.map(source => (
          source.plugins?.length > 0 && (
            <div key={source.sourceId} style={{ marginTop: 10 }}>
              <div className={styles.nodeMeta} style={{ marginBottom: 6 }}>{source.repositoryName}</div>
              {source.plugins.map(p => {
                const latest = p.versions?.[0]
                return (
                  <div key={p.id} style={{ display: 'flex', alignItems: 'flex-start', gap: 12, padding: '8px 0', borderTop: '1px solid var(--border)' }}>
                    <div style={{ flex: 1 }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                        <strong style={{ fontSize: 13 }}>{p.name}</strong>
                        {latest?.version && <span className={styles.nodeMeta}>v{latest.version}</span>}
                        {p.author && <span className={styles.nodeMeta}>by {p.author}</span>}
                      </div>
                      {p.description && <p className={styles.rowDesc} style={{ marginTop: 2 }}>{p.description}</p>}
                    </div>
                    <button
                      className="ghost"
                      disabled={!latest?.downloadUrl || installing === p.id}
                      onClick={() => installPlugin(latest.downloadUrl, p.id)}
                    >
                      {installing === p.id ? 'Installing…' : 'Install'}
                    </button>
                  </div>
                )
              })}
            </div>
          )
        ))}
      </div>

      {/* Manual install */}
      <div>
        <strong style={{ fontSize: 13 }}>Install from URL</strong>
        <form onSubmit={installFromUrl} style={{ display: 'flex', gap: 8, marginTop: 10 }}>
          <input placeholder="https://.../plugin.js" style={{ flex: 1 }} value={manualInstall.downloadUrl}
                 onChange={e => setManualInstall(s => ({ ...s, downloadUrl: e.target.value }))} />
          <input placeholder="Filename (optional)" value={manualInstall.pluginName}
                 onChange={e => setManualInstall(s => ({ ...s, pluginName: e.target.value }))} />
          <button className="ghost" type="submit" disabled={installing === manualInstall.pluginName}>Install</button>
        </form>
      </div>
    </div>
  )
}

function PluginStatusBadge({ plugin }) {
  if (plugin.error)        return <span style={badge('#e05555')}>error</span>
  if (!plugin.is_enabled)  return <span style={badge('#555')}>disabled</span>
  if (!plugin.loaded)      return <span style={badge('#888')}>restart required</span>
  return                          <span style={badge('#4caf7d')}>active</span>
}

function HookChip({ name }) {
  return (
    <span style={{ background: 'var(--surface2)', border: '1px solid var(--border)',
      borderRadius: 4, padding: '1px 7px', fontSize: 11, color: 'var(--text-muted)',
      fontFamily: 'monospace' }}>
      {name}
    </span>
  )
}

const badge = (color) => ({
  background: color + '22', border: `1px solid ${color}`,
  borderRadius: 10, padding: '1px 8px', fontSize: 11, color,
})

function PluginSettingsForm({ plugin, onSave, saving }) {
  const schema = plugin.settings_schema ?? {}
  const [values, setValues] = useState(() => {
    const initial = { ...plugin.settings }
    for (const [key, rule] of Object.entries(schema)) {
      if (initial[key] === undefined && rule.default !== undefined) initial[key] = rule.default
    }
    return initial
  })
  const [errors, setErrors] = useState([])

  function labelFor(key, rule) {
    return rule.title || key.replace(/([A-Z])/g, ' $1').replace(/^./, s => s.toUpperCase())
  }

  function set(key, value) {
    setValues(v => ({ ...v, [key]: value }))
  }

  async function handleSubmit(e) {
    e.preventDefault()
    setErrors([])
    try {
      await onSave(values)
    } catch (err) {
      setErrors(err.response?.data?.error ? [err.response.data.error] : ['Failed to save settings'])
    }
  }

  return (
    <form className={styles.form} style={{ borderTop: '1px solid var(--border)', paddingTop: 16 }}
          onSubmit={handleSubmit}>
      {Object.entries(schema).map(([key, rule]) => (
        <div key={key} className={styles.row}>
          <div className={styles.rowMeta}>
            <label className={styles.rowLabel}>
              {labelFor(key, rule)}{rule.required && ' *'}
            </label>
          </div>
          <div className={styles.rowControl}>
            {rule.type === 'boolean' ? (
              <label className={styles.toggle}>
                <input type="checkbox" checked={!!values[key]} onChange={e => set(key, e.target.checked)} />
                <span className={styles.toggleTrack} />
              </label>
            ) : rule.enum ? (
              <select value={values[key] ?? ''} onChange={e => set(key, e.target.value)}>
                <option value="" disabled>Select…</option>
                {rule.enum.map(opt => <option key={opt} value={opt}>{opt}</option>)}
              </select>
            ) : rule.type === 'number' ? (
              <input
                type="number" min={rule.minimum} max={rule.maximum}
                value={values[key] ?? ''}
                onChange={e => set(key, e.target.value === '' ? '' : Number(e.target.value))}
              />
            ) : rule.secret ? (
              <input type="password" value={values[key] ?? ''} onChange={e => set(key, e.target.value)} autoComplete="new-password" />
            ) : (
              <input
                type="text" minLength={rule.minLength} maxLength={rule.maxLength}
                value={values[key] ?? ''} onChange={e => set(key, e.target.value)}
              />
            )}
          </div>
        </div>
      ))}
      {errors.length > 0 && (
        <div style={{ color: 'var(--danger)', fontSize: 12, marginTop: 4 }}>
          {errors.map((e, i) => <div key={i}>{e}</div>)}
        </div>
      )}
      <div className={styles.formFooter}>
        <button className="primary" type="submit" disabled={saving}>
          {saving ? 'Saving…' : 'Save plugin settings'}
        </button>
      </div>
    </form>
  )
}

// ─── Playback stats ──────────────────────────────────────────────────────────

function formatDuration(secs) {
  if (!secs || secs < 0) return '—'
  const h = Math.floor(secs / 3600)
  const m = Math.floor((secs % 3600) / 60)
  const s = secs % 60
  if (h > 0) return `${h}h ${m}m`
  if (m > 0) return `${m}m ${s}s`
  return `${s}s`
}

function formatBitrate(kbps) {
  if (!kbps) return '—'
  return kbps >= 1000 ? `${(kbps / 1000).toFixed(1)} Mbps` : `${kbps} kbps`
}

function timeAgo(ts) {
  if (!ts) return '—'
  const diff = Math.floor((Date.now() - new Date(ts)) / 1000)
  if (diff < 60) return `${diff}s ago`
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`
  return new Date(ts).toLocaleDateString()
}

function StreamModeBadge({ hw }) {
  const colors = { nvenc: '#76b900', vaapi: '#0071c5', qsv: '#0071c5', cpu: '#888' }
  const labels = { nvenc: 'NVENC', vaapi: 'VAAPI', qsv: 'QSV', cpu: 'CPU' }
  const color  = colors[hw] ?? '#888'
  const label  = labels[hw]  ?? (hw ?? 'CPU').toUpperCase()
  return (
    <span style={{
      background: color + '22', border: `1px solid ${color}`,
      borderRadius: 4, padding: '1px 6px', fontSize: 11,
      color, fontWeight: 600, whiteSpace: 'nowrap',
    }}>
      {label}
    </span>
  )
}

function StatsTab() {
  const [data, setData] = useState(null)
  const [error, setError] = useState(null)
  const [loading, setLoading] = useState(true)

  async function load() {
    try {
      const { data: d } = await api.get('/stream/stats')
      setData(d)
      setError(null)
    } catch (e) {
      setError(e.response?.data?.error ?? e.message)
    } finally {
      setLoading(false)
    }
  }

  // Initial load + auto-refresh every 10 s while the tab is open
  useEffect(() => {
    load()
    const t = setInterval(load, 10_000)
    return () => clearInterval(t)
  }, [])

  if (loading) return <div className={styles.loading}>Loading stats…</div>
  if (error)   return <div className={styles.inlineError}>Failed to load stats: {error}</div>

  const { active_sessions, recent_sessions, totals, node_stats, play_ratio, top_users } = data

  // Direct/transcode ratio calculations
  const totalAll   = Number(play_ratio.direct_all)   + Number(play_ratio.transcode_all)
  const totalToday = Number(play_ratio.direct_today)  + Number(play_ratio.transcode_today)
  const directPct  = totalAll ? Math.round(Number(play_ratio.direct_all)   / totalAll   * 100) : 0
  const directPctToday = totalToday ? Math.round(Number(play_ratio.direct_today) / totalToday * 100) : 0

  return (
    <div className={styles.sectionWide}>

      {/* ── Summary tiles ─────────────────────────────────────────────── */}
      <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap' }}>
        <StatsTile label="Active streams"    value={totals.active}   accent="#7c6af7" />
        <StatsTile label="Transcode today"   value={totals.today}    accent="#4caf7d" />
        <StatsTile label="All-time transcode" value={totals.all_time} accent="#888" />
        <StatsTile label="Plays today"       value={totalToday}      accent="#f0a500" />
      </div>

      {/* ── Direct / Transcode ratio ───────────────────────────────────── */}
      <div>
        <h3 className={styles.subheading}>Play type ratio</h3>
        <div style={{ marginTop: 8, display: 'flex', gap: 32, alignItems: 'center', flexWrap: 'wrap' }}>
          <RatioBar label="Today"    direct={Number(play_ratio.direct_today)}    transcode={Number(play_ratio.transcode_today)} />
          <RatioBar label="All time" direct={Number(play_ratio.direct_all)}      transcode={Number(play_ratio.transcode_all)} />
        </div>
      </div>

      {/* ── Active streams ────────────────────────────────────────────── */}
      <div>
        <h3 className={styles.subheading}>
          Active streams
          {active_sessions.length > 0 && (
            <span style={{ marginLeft: 8, ...badge('#4caf7d') }}>{active_sessions.length} live</span>
          )}
        </h3>

        {active_sessions.length === 0 ? (
          <p className={styles.empty}>No active streams right now.</p>
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table className={styles.table}>
              <thead>
                <tr>
                  <th>User</th><th>Title</th><th>Codec</th><th>Resolution</th>
                  <th>Bitrate</th><th>Node</th><th>FPS</th><th>Speed</th><th>Timemark</th><th>Running</th>
                </tr>
              </thead>
              <tbody>
                {active_sessions.map(s => (
                  <tr key={s.id}>
                    <td>{s.username}</td>
                    <td style={{ maxWidth: 220, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {s.title ?? '—'}
                    </td>
                    <td style={{ textTransform: 'uppercase', fontSize: 12 }}>{s.codec}</td>
                    <td style={{ fontSize: 12 }}>{s.resolution ?? '—'}</td>
                    <td style={{ fontSize: 12 }}>{formatBitrate(s.bitrate)}</td>
                    <td>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                        <StreamModeBadge hw={s.hw_accel} />
                        <span className={styles.muted} style={{ fontSize: 12 }}>{s.node_name}</span>
                      </div>
                    </td>
                    <td className={styles.muted} style={{ fontSize: 12 }}>
                      {s.metrics?.fps != null ? `${Math.round(s.metrics.fps)} fps` : '—'}
                    </td>
                    <td style={{ fontSize: 12, color: speedColor(s.metrics?.speed) }}>
                      {s.metrics?.speed != null ? `${s.metrics.speed.toFixed(1)}×` : '—'}
                    </td>
                    <td className={styles.muted} style={{ fontSize: 12, fontFamily: 'monospace' }}>
                      {s.metrics?.timemark ?? '—'}
                    </td>
                    <td className={styles.muted} style={{ fontSize: 12 }}>
                      {formatDuration(s.duration_secs)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* ── Per-node 7-day stats ──────────────────────────────────────── */}
      <div>
        <h3 className={styles.subheading}>Transcoder nodes — last 7 days</h3>
        {node_stats.length === 0 ? (
          <p className={styles.empty}>No transcoder nodes registered.</p>
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table className={styles.table}>
              <thead>
                <tr>
                  <th>Node</th><th>Live</th><th>Sessions (7d)</th>
                  <th>Successful</th><th>Errors</th><th>Error rate</th>
                  <th>Avg duration</th><th>All-time</th>
                </tr>
              </thead>
              <tbody>
                {node_stats.map(n => {
                  const sessions7d = Number(n.sessions_7d)
                  const errors7d   = Number(n.errors_7d)
                  const errorRate  = sessions7d ? Math.round(errors7d / sessions7d * 100) : 0
                  return (
                    <tr key={n.id}>
                      <td>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                          <StreamModeBadge hw={n.hw_accel} />
                          <span>{n.name}</span>
                        </div>
                      </td>
                      <td>
                        {Number(n.live) > 0
                          ? <span style={badge('#4caf7d')}>{n.live} active</span>
                          : <span className={styles.muted}>—</span>}
                      </td>
                      <td>{sessions7d}</td>
                      <td style={{ color: '#4caf7d' }}>{n.successful_7d}</td>
                      <td style={{ color: errors7d > 0 ? '#e05555' : 'inherit' }}>{errors7d}</td>
                      <td>
                        {sessions7d === 0 ? <span className={styles.muted}>—</span>
                          : <span style={{ color: errorRate > 10 ? '#e05555' : errorRate > 0 ? '#f0a500' : 'inherit' }}>
                              {errorRate}%
                            </span>}
                      </td>
                      <td className={styles.muted} style={{ fontSize: 12 }}>
                        {formatDuration(n.avg_duration_secs_7d)}
                      </td>
                      <td className={styles.muted}>{n.total_sessions}</td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* ── Top users (30 days) ───────────────────────────────────────── */}
      <div>
        <h3 className={styles.subheading}>Top users — last 30 days</h3>
        {top_users.length === 0 ? (
          <p className={styles.empty}>No playback recorded yet.</p>
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table className={styles.table}>
              <thead>
                <tr>
                  <th>User</th><th>Sessions</th><th>Direct</th><th>Transcoded</th><th>Avg watch time</th>
                </tr>
              </thead>
              <tbody>
                {top_users.map((u, i) => (
                  <tr key={u.username}>
                    <td>
                      <span style={{ color: 'var(--text-muted)', marginRight: 8, fontSize: 12 }}>#{i + 1}</span>
                      {u.username}
                    </td>
                    <td style={{ fontWeight: 600 }}>{u.session_count}</td>
                    <td className={styles.muted}>{u.direct_count}</td>
                    <td className={styles.muted}>{u.transcode_count}</td>
                    <td className={styles.muted} style={{ fontSize: 12 }}>
                      {formatDuration(u.avg_duration_secs)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* ── Recent history ────────────────────────────────────────────── */}
      <div>
        <h3 className={styles.subheading}>Recent transcode history</h3>
        {recent_sessions.length === 0 ? (
          <p className={styles.empty}>No completed sessions yet.</p>
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table className={styles.table}>
              <thead>
                <tr>
                  <th>User</th><th>Title</th><th>Codec</th><th>Resolution</th>
                  <th>Bitrate</th><th>Node</th><th>Duration</th><th>Started</th><th>Status</th>
                </tr>
              </thead>
              <tbody>
                {recent_sessions.map(s => (
                  <tr key={s.id}>
                    <td>{s.username}</td>
                    <td style={{ maxWidth: 220, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {s.title ?? '—'}
                    </td>
                    <td style={{ textTransform: 'uppercase', fontSize: 12 }}>{s.codec}</td>
                    <td style={{ fontSize: 12 }}>{s.resolution ?? '—'}</td>
                    <td style={{ fontSize: 12 }}>{formatBitrate(s.bitrate)}</td>
                    <td>
                      {s.hw_accel
                        ? <StreamModeBadge hw={s.hw_accel} />
                        : <span className={styles.muted}>—</span>}
                    </td>
                    <td className={styles.muted} style={{ fontSize: 12 }}>{formatDuration(s.duration_secs)}</td>
                    <td className={styles.muted} style={{ fontSize: 12 }}>{timeAgo(s.created_at)}</td>
                    <td>
                      <span style={badge(s.status === 'error' ? '#e05555' : '#4caf7d')}>
                        {s.status}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

    </div>
  )
}

// Speed multiplier colour: red <0.5×, amber 0.5–1×, green >1×
function speedColor(speed) {
  if (speed == null) return 'inherit'
  if (speed < 0.5)   return '#e05555'
  if (speed < 1.0)   return '#f0a500'
  return '#4caf7d'
}

function RatioBar({ label, direct, transcode }) {
  const total = direct + transcode
  const directPct = total ? Math.round(direct / total * 100) : 0
  return (
    <div style={{ minWidth: 220 }}>
      <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 6 }}>
        <strong style={{ color: 'var(--text)' }}>{label}</strong>
        {'  '}
        <span style={{ color: '#4caf7d' }}>Direct {directPct}%</span>
        {'  ·  '}
        <span style={{ color: '#7c6af7' }}>Transcode {100 - directPct}%</span>
        {'  '}
        <span style={{ color: 'var(--text-muted)' }}>({total} total)</span>
      </div>
      <div style={{ height: 8, borderRadius: 4, background: '#7c6af744', overflow: 'hidden', width: '100%' }}>
        <div style={{
          height: '100%',
          width: `${directPct}%`,
          background: '#4caf7d',
          borderRadius: 4,
          transition: 'width 0.4s ease',
        }} />
      </div>
    </div>
  )
}

function StatsTile({ label, value, accent }) {
  return (
    <div style={{
      background: 'var(--surface)',
      border: `1px solid ${accent}44`,
      borderRadius: 10,
      padding: '16px 24px',
      minWidth: 140,
      textAlign: 'center',
    }}>
      <div style={{ fontSize: 32, fontWeight: 700, color: accent, lineHeight: 1.1 }}>{value}</div>
      <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 6 }}>{label}</div>
    </div>
  )
}

// ─── Users ───────────────────────────────────────────────────────────────────

// ─── Sessions ────────────────────────────────────────────────────────────────

const DEVICE_ICONS = { ios: '📱', android: '🤖', web: '🌐', other: '💻' }

function SessionsTab() {
  const [sessions, setSessions] = useState([])

  useEffect(() => { api.get('/auth/devices').then(r => setSessions(r.data)) }, [])

  async function revoke(id) {
    await api.delete(`/auth/devices/${id}`)
    setSessions(s => s.filter(x => x.id !== id))
  }

  async function revokeAll() {
    if (!confirm('Sign out all other devices?')) return
    await api.delete('/auth/devices')
    setSessions([])
  }

  return (
    <div className={styles.section}>
      <p className={styles.sectionDesc}>
        Active sessions for your account. Revoke any device you no longer recognise.
      </p>
      <div className={styles.nodeList}>
        {sessions.length === 0 && <p className={styles.empty}>No active sessions.</p>}
        {sessions.map(s => (
          <div key={s.id} className={styles.nodeCard}>
            <div className={styles.nodeInfo}>
              <strong>{DEVICE_ICONS[s.device_type] ?? '💻'} {s.device_name ?? 'Unknown device'}</strong>
              <span className={styles.nodeMeta}>
                {s.device_type ?? 'unknown type'}
                {s.ip_address && ` · ${s.ip_address}`}
                {` · last active ${new Date(s.last_used_at).toLocaleString()}`}
              </span>
            </div>
            <div className={styles.nodeActions}>
              <button className="danger" onClick={() => revoke(s.id)}>Revoke</button>
            </div>
          </div>
        ))}
      </div>
      {sessions.length > 1 && (
        <button className="ghost" style={{ alignSelf: 'flex-start' }} onClick={revokeAll}>
          Revoke all sessions
        </button>
      )}
    </div>
  )
}

// ─── Users ───────────────────────────────────────────────────────────────────

function UsersTab() {
  const [users, setUsers] = useState([])
  const [expanded, setExpanded] = useState(null)
  const currentUser = JSON.parse(localStorage.getItem('nexus_user') ?? '{}')

  useEffect(() => { api.get('/users').then(r => setUsers(r.data)) }, [])

  async function changeRole(id, role) {
    await api.patch(`/users/${id}/role`, { role })
    setUsers(u => u.map(x => x.id === id ? { ...x, role } : x))
  }

  async function remove(id) {
    if (!confirm('Delete this user? This cannot be undone.')) return
    await api.delete(`/users/${id}`)
    setUsers(u => u.filter(x => x.id !== id))
  }

  return (
    <div className={styles.section}>
      <p className={styles.sectionDesc}>
        Manage user accounts. Toggle open registration in General settings. Use
        "Libraries" to restrict a viewer to specific libraries — leaving none
        selected means they can see everything.
      </p>
      <table className={styles.table}>
        <thead>
          <tr><th>Username</th><th>Email</th><th>Role</th><th>Joined</th><th /></tr>
        </thead>
        <tbody>
          {users.map(u => (
            <Fragment key={u.id}>
              <tr>
                <td>{u.username}{u.id === currentUser.id && <span className={styles.badge}>you</span>}</td>
                <td className={styles.muted}>{u.email}</td>
                <td>
                  <select
                    value={u.role}
                    onChange={e => changeRole(u.id, e.target.value)}
                    disabled={u.id === currentUser.id}
                    style={{ width: 'auto' }}
                  >
                    <option value="viewer">Viewer</option>
                    <option value="admin">Admin</option>
                  </select>
                </td>
                <td className={styles.muted}>{new Date(u.created_at).toLocaleDateString()}</td>
                <td style={{ display: 'flex', gap: 8 }}>
                  {u.role !== 'admin' && (
                    <button className="ghost" onClick={() => setExpanded(e => e === u.id ? null : u.id)}>
                      {expanded === u.id ? 'Hide libraries' : 'Libraries'}
                    </button>
                  )}
                  <button className="danger" onClick={() => remove(u.id)} disabled={u.id === currentUser.id}>
                    Delete
                  </button>
                </td>
              </tr>
              {expanded === u.id && u.role !== 'admin' && (
                <tr>
                  <td colSpan={5}><UserLibraryAccess userId={u.id} /></td>
                </tr>
              )}
            </Fragment>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function UserLibraryAccess({ userId }) {
  const [libraries, setLibraries] = useState([])
  const [selected, setSelected] = useState(new Set())
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    setLoading(true)
    Promise.all([api.get('/libraries'), api.get(`/users/${userId}/libraries`)])
      .then(([libRes, accessRes]) => {
        setLibraries(libRes.data)
        setSelected(new Set(accessRes.data.library_ids))
      })
      .finally(() => setLoading(false))
  }, [userId])

  function toggle(libId) {
    setSelected(s => {
      const next = new Set(s)
      next.has(libId) ? next.delete(libId) : next.add(libId)
      return next
    })
  }

  async function save() {
    setSaving(true)
    try {
      await api.put(`/users/${userId}/libraries`, { library_ids: [...selected] })
    } finally {
      setSaving(false)
    }
  }

  if (loading) return <p className={styles.rowDesc}>Loading…</p>

  return (
    <div style={{ padding: '8px 0', display: 'flex', flexDirection: 'column', gap: 8 }}>
      {libraries.length === 0 && <p className={styles.rowDesc}>No libraries configured yet.</p>}
      {libraries.map(lib => (
        <label key={lib.id} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13 }}>
          <input type="checkbox" checked={selected.has(lib.id)} onChange={() => toggle(lib.id)} />
          {lib.name} <span className={styles.nodeMeta}>({lib.type})</span>
        </label>
      ))}
      <div>
        <button className="primary" onClick={save} disabled={saving}>
          {saving ? 'Saving…' : 'Save access'}
        </button>
        {selected.size === 0 && libraries.length > 0 && (
          <span className={styles.rowDesc} style={{ marginLeft: 8 }}>No restriction — sees all libraries</span>
        )}
      </div>
    </div>
  )
}
