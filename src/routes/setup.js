import { readdir, access, writeFile } from 'fs/promises'
import { resolve, join } from 'path'
import bcrypt from 'bcrypt'
import { invalidateSettingsCache } from '../services/settingsCache.js'

const INITIALIZED_FLAG = '/config/.initialized'

// Setup is required when the flag file doesn't exist AND the DB has no users.
// Dual check: flag file is fast (no DB hit); DB is the fallback for flag-missing-but-done.
export async function isSetupRequired(db) {
  if (process.env.SETUP_COMPLETE === 'true') return false
  try {
    await access(INITIALIZED_FLAG)
    return false
  } catch {
    try {
      const { rows } = await db.query('SELECT 1 FROM users LIMIT 1')
      if (rows.length > 0) {
        // DB has users but flag is missing (e.g. volume was wiped) — restore flag
        await writeFile(INITIALIZED_FLAG, new Date().toISOString(), 'utf8').catch(() => {})
        return false
      }
    } catch {
      // DB not reachable yet — treat as setup required so the wizard can show a useful error
    }
    return true
  }
}

export default async function setupRoutes(app) {
  // ── Status — always public ────────────────────────────────────────────────
  app.get('/status', async () => ({
    required: await isSetupRequired(app.db),
  }))

  // ── Directory browser — public during setup only ──────────────────────────
  // Used by the library wizard to let the user navigate the container filesystem.
  app.get('/browse', async (request, reply) => {
    if (!await isSetupRequired(app.db)) {
      return reply.code(403).send({ error: 'Setup already completed' })
    }

    // Resolve to an absolute path, preventing traversal outside /
    const safePath = resolve('/', request.query.path ?? '/')

    try {
      const entries = await readdir(safePath, { withFileTypes: true })
      const dirs = entries
        .filter(e => e.isDirectory() && !e.name.startsWith('.'))
        .sort((a, b) => a.name.localeCompare(b.name))
        .map(e => ({ name: e.name, path: join(safePath, e.name) }))
      return { path: safePath, dirs }
    } catch {
      return reply.code(404).send({ error: 'Path not found or not accessible' })
    }
  })

  // ── Complete setup ────────────────────────────────────────────────────────
  app.post('/complete', async (request, reply) => {
    if (!await isSetupRequired(app.db)) {
      return reply.code(403).send({ error: 'Setup already completed' })
    }

    const { admin = {}, libraries = [], tmdb_api_key } = request.body

    if (!admin.username?.trim()) {
      return reply.code(400).send({ error: 'Username is required' })
    }
    if (!admin.email?.trim()) {
      return reply.code(400).send({ error: 'Email is required' })
    }
    if (!admin.password || admin.password.length < 8) {
      return reply.code(400).send({ error: 'Password must be at least 8 characters' })
    }

    const client = await app.db.connect()
    try {
      await client.query('BEGIN')

      const hash = await bcrypt.hash(admin.password, 12)
      await client.query(
        `INSERT INTO users(username, email, password_hash, role)
         VALUES($1, $2, $3, 'admin')`,
        [admin.username.trim(), admin.email.trim(), hash]
      )

      for (const lib of libraries) {
        const paths = (lib.paths ?? []).map(p => p.trim()).filter(Boolean)
        if (!lib.name?.trim() || paths.length === 0) continue
        await client.query(
          `INSERT INTO libraries(name, type, paths) VALUES($1, $2, $3)`,
          [lib.name.trim(), lib.type ?? 'movies', paths]
        )
      }

      if (tmdb_api_key?.trim()) {
        await client.query(
          `UPDATE settings SET value = $1 WHERE key = 'metadata.tmdb_api_key'`,
          [tmdb_api_key.trim()]
        )
        invalidateSettingsCache()
      }

      await client.query('COMMIT')
    } catch (err) {
      await client.query('ROLLBACK')
      app.log.error(err, 'Setup failed during DB transaction')
      if (err.code === '23505') {
        return reply.code(409).send({ error: 'A user with that username or email already exists' })
      }
      return reply.code(500).send({ error: 'Setup failed — see server logs' })
    } finally {
      client.release()
    }

    await writeFile(INITIALIZED_FLAG, new Date().toISOString(), 'utf8')
    app.log.info('Initial setup completed — wizard flag written')
    return reply.code(201).send({ ok: true })
  })
}
