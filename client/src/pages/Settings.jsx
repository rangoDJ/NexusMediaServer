import { useState, useEffect, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import { api } from '../api/client.js'
import styles from './Settings.module.css'

const TABS = [
  { id: 'general',     label: 'General' },
  { id: 'metadata',    label: 'Metadata' },
  { id: 'library',     label: 'Libraries' },
  { id: 'transcoding', label: 'Transcoding' },
  { id: 'transcoders', label: 'Transcoder Nodes' },
  { id: 'stats',       label: 'Playback Stats' },
  { id: 'plugins',     label: 'Plugins' },
  { id: 'users',       label: 'Users' },
  { id: 'sessions',    label: 'My Sessions' },
]

export default function Settings() {
  const [activeTab, setActiveTab] = useState('general')
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
          const cat = key.split('.')[0]
          if (!next[cat]) continue
          const idx = next[cat].findIndex(s => s.key === key)
          if (idx !== -1) next[cat][idx] = { ...next[cat][idx], value }
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
          {activeTab === 'general'     && <GeneralTab     rows={settings.general ?? []}     save={save} />}
          {activeTab === 'metadata'    && <MetadataTab    rows={settings.metadata ?? []}    save={save} />}
          {activeTab === 'library'     && <LibraryTab     rows={settings.library ?? []}     save={save} />}
          {activeTab === 'transcoding' && <TranscodingTab rows={settings.transcoding ?? []} save={save} />}
          {activeTab === 'transcoders' && <TranscoderNodes />}
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

// ─── Plugins ─────────────────────────────────────────────────────────────────

function PluginsTab() {
  const [plugins, setPlugins] = useState([])
  const [expanded, setExpanded] = useState(null)
  const [saving, setSaving] = useState(null)

  useEffect(() => { api.get('/plugins').then(r => setPlugins(r.data)) }, [])

  async function toggleEnabled(plugin) {
    const next = !plugin.is_enabled
    await api.patch(`/plugins/${plugin.id}/enabled`, { enabled: next })
    setPlugins(ps => ps.map(p => p.id === plugin.id ? { ...p, is_enabled: next } : p))
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

  if (!plugins.length) {
    return (
      <div className={styles.section}>
        <p className={styles.sectionDesc}>
          No plugins found. Drop a plugin folder or <code>.js</code> file into your plugins
          directory (<code>PLUGINS_DIR</code> in <code>.env</code>) and restart the server.
        </p>
        <div className={styles.card} style={{ fontFamily: 'monospace', fontSize: 13, lineHeight: 1.8 }}>
          <strong>Plugin directory structure:</strong>
          <pre style={{ marginTop: 8, color: 'var(--text-muted)' }}>{`plugins/
├── my-plugin/
│   └── index.js     ← exports manifest + hooks
└── single-file.js   ← also valid`}</pre>
        </div>
      </div>
    )
  }

  return (
    <div className={styles.section}>
      <p className={styles.sectionDesc}>
        Plugins are loaded from the <code>PLUGINS_DIR</code> directory on the host.
        Enable/disable changes take effect after a server restart. Settings changes are immediate.
      </p>

      {plugins.map(plugin => (
        <div key={plugin.id} className={`${styles.nodeCard} ${!plugin.is_enabled ? styles.disabled : ''}`}
             style={{ flexDirection: 'column', alignItems: 'stretch', gap: 12 }}>

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
              {plugin.default_settings && Object.keys(plugin.default_settings).length > 0 && (
                <button className="ghost" onClick={() => setExpanded(e => e === plugin.id ? null : plugin.id)}>
                  {expanded === plugin.id ? 'Hide settings' : 'Settings'}
                </button>
              )}
              <button className="ghost" onClick={() => toggleEnabled(plugin)}>
                {plugin.is_enabled ? 'Disable' : 'Enable'}
              </button>
            </div>
          </div>

          {expanded === plugin.id && plugin.default_settings && (
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
  const [values, setValues] = useState({ ...plugin.settings })
  const defaults = plugin.default_settings ?? {}

  function labelFor(key) {
    return key.replace(/([A-Z])/g, ' $1').replace(/^./, s => s.toUpperCase())
  }

  function set(key, value) {
    setValues(v => ({ ...v, [key]: value }))
  }

  return (
    <form className={styles.form} style={{ borderTop: '1px solid var(--border)', paddingTop: 16 }}
          onSubmit={e => { e.preventDefault(); onSave(values) }}>
      {Object.entries(defaults).map(([key, defaultVal]) => (
        <div key={key} className={styles.row}>
          <div className={styles.rowMeta}>
            <label className={styles.rowLabel}>{labelFor(key)}</label>
          </div>
          <div className={styles.rowControl}>
            {typeof defaultVal === 'boolean' ? (
              <label className={styles.toggle}>
                <input type="checkbox" checked={!!values[key]} onChange={e => set(key, e.target.checked)} />
                <span className={styles.toggleTrack} />
              </label>
            ) : typeof defaultVal === 'number' ? (
              <input type="number" value={values[key] ?? ''} onChange={e => set(key, Number(e.target.value))} />
            ) : key.toLowerCase().includes('key') || key.toLowerCase().includes('secret') || key.toLowerCase().includes('token') ? (
              <input type="password" value={values[key] ?? ''} onChange={e => set(key, e.target.value)} autoComplete="new-password" />
            ) : (
              <input type="text" value={values[key] ?? ''} onChange={e => set(key, e.target.value)} />
            )}
          </div>
        </div>
      ))}
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
      <p className={styles.sectionDesc}>Manage user accounts. Toggle open registration in General settings.</p>
      <table className={styles.table}>
        <thead>
          <tr><th>Username</th><th>Email</th><th>Role</th><th>Joined</th><th /></tr>
        </thead>
        <tbody>
          {users.map(u => (
            <tr key={u.id}>
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
              <td>
                <button className="danger" onClick={() => remove(u.id)} disabled={u.id === currentUser.id}>
                  Delete
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
