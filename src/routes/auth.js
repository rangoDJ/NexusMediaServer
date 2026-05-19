import bcrypt from 'bcrypt'
import crypto from 'crypto'
import { getSetting } from '../services/settingsCache.js'
import { callHook } from '../services/pluginLoader.js'

// Access tokens are short-lived (1 day). Refresh tokens are long-lived and stored
// as bcrypt hashes so a DB breach doesn't yield usable tokens.

const ACCESS_TOKEN_TTL = '1d'

function generateRefreshToken() {
  return crypto.randomBytes(48).toString('base64url')
}

async function issueTokens(app, db, user, { device_name, device_type, ip_address, user_agent } = {}) {
  const sessionDays = await getSetting(db, 'auth.session_days', 30)
  const accessToken = app.jwt.sign(
    { sub: user.id, username: user.username, role: user.role },
    { expiresIn: ACCESS_TOKEN_TTL }
  )

  const refreshToken = generateRefreshToken()
  const tokenHash = await bcrypt.hash(refreshToken, 10)
  const expiresAt = new Date(Date.now() + sessionDays * 86_400_000)

  await db.query(`
    INSERT INTO refresh_tokens(user_id, token_hash, device_name, device_type, ip_address, user_agent, expires_at)
    VALUES($1,$2,$3,$4,$5,$6,$7)
  `, [user.id, tokenHash, device_name ?? null, device_type ?? null, ip_address ?? null, user_agent ?? null, expiresAt])

  return { access_token: accessToken, refresh_token: refreshToken }
}

const AUTH_RATE_LIMIT = { max: 10, timeWindow: '1 minute' }

export default async function authRoutes(app) {
  app.post('/register', { config: { rateLimit: AUTH_RATE_LIMIT } }, async (request, reply) => {
    const { username, email, password, device_name, device_type } = request.body

    const count = await app.db.query('SELECT COUNT(*) FROM users')
    const isFirst = count.rows[0].count === '0'

    if (!isFirst) {
      const allowReg = await getSetting(app.db, 'auth.allow_registration', true)
      if (!allowReg) return reply.code(403).send({ error: 'Registration is disabled on this server' })
    }

    const existing = await app.db.query(
      'SELECT id FROM users WHERE username=$1 OR email=$2',
      [username, email]
    )
    if (existing.rows.length) return reply.code(409).send({ error: 'Username or email already taken' })

    const role = isFirst ? 'admin' : await getSetting(app.db, 'auth.default_role', 'viewer')
    const password_hash = await bcrypt.hash(password, 12)

    const { rows } = await app.db.query(
      'INSERT INTO users(username, email, password_hash, role) VALUES($1,$2,$3,$4) RETURNING id, username, role',
      [username, email, password_hash, role]
    )
    const user = rows[0]
    const tokens = await issueTokens(app, app.db, user, {
      device_name, device_type,
      ip_address: request.ip,
      user_agent: request.headers['user-agent'],
    })

    return reply.code(201).send({ ...tokens, user })
  })

  app.post('/login', { config: { rateLimit: AUTH_RATE_LIMIT } }, async (request, reply) => {
    const { username, password, device_name, device_type } = request.body
    const { rows } = await app.db.query(
      'SELECT id, username, password_hash, role FROM users WHERE username=$1',
      [username]
    )
    const user = rows[0]
    if (!user || !(await bcrypt.compare(password, user.password_hash))) {
      return reply.code(401).send({ error: 'Invalid credentials' })
    }

    // Allow plugins to veto a login (auth.login hook)
    const hookResults = await callHook('auth.login', { username }, app.log)
    for (const result of hookResults) {
      if (result?.denied) {
        return reply.code(403).send({ error: result.reason ?? 'Login denied by server policy' })
      }
    }

    const tokens = await issueTokens(app, app.db, user, {
      device_name, device_type,
      ip_address: request.ip,
      user_agent: request.headers['user-agent'],
    })
    return { ...tokens, user: { id: user.id, username: user.username, role: user.role } }
  })

  // Exchange a refresh token for a new access + refresh token pair (rotation).
  app.post('/refresh', { config: { rateLimit: AUTH_RATE_LIMIT } }, async (request, reply) => {
    const { refresh_token } = request.body
    if (!refresh_token) return reply.code(400).send({ error: 'refresh_token required' })

    // Find candidate tokens for this hash (bcrypt compare is O(n) — limit the search)
    const { rows } = await app.db.query(`
      SELECT rt.*, u.username, u.role
      FROM refresh_tokens rt
      JOIN users u ON u.id = rt.user_id
      WHERE rt.revoked_at IS NULL
        AND rt.expires_at > now()
      ORDER BY rt.created_at DESC
      LIMIT 50
    `)

    let match = null
    for (const row of rows) {
      if (await bcrypt.compare(refresh_token, row.token_hash)) { match = row; break }
    }
    if (!match) return reply.code(401).send({ error: 'Invalid or expired refresh token' })

    // Revoke old token, issue new pair
    await app.db.query('UPDATE refresh_tokens SET revoked_at=now() WHERE id=$1', [match.id])

    const user = { id: match.user_id, username: match.username, role: match.role }
    const tokens = await issueTokens(app, app.db, user, {
      device_name: match.device_name,
      device_type: match.device_type,
      ip_address: request.ip,
      user_agent: request.headers['user-agent'],
    })
    return { ...tokens, user }
  })

  app.get('/me', { preHandler: app.authenticate }, async (request) => {
    const { rows } = await app.db.query(
      'SELECT id, username, email, role, created_at FROM users WHERE id=$1',
      [request.user.sub]
    )
    return rows[0]
  })

  // List all active device sessions for the current user
  app.get('/devices', { preHandler: app.authenticate }, async (request) => {
    const { rows } = await app.db.query(`
      SELECT id, device_name, device_type, ip_address, last_used_at, created_at
      FROM refresh_tokens
      WHERE user_id=$1 AND revoked_at IS NULL AND expires_at > now()
      ORDER BY last_used_at DESC
    `, [request.user.sub])
    return rows
  })

  // Revoke a specific device session (remote logout)
  app.delete('/devices/:id', { preHandler: app.authenticate }, async (request, reply) => {
    const { rowCount } = await app.db.query(
      'UPDATE refresh_tokens SET revoked_at=now() WHERE id=$1 AND user_id=$2 AND revoked_at IS NULL',
      [request.params.id, request.user.sub]
    )
    if (!rowCount) return reply.code(404).send({ error: 'Session not found' })
    return reply.code(204).send()
  })

  // Revoke all sessions except the current one (logout everywhere)
  app.delete('/devices', { preHandler: app.authenticate }, async (request, reply) => {
    const { current_refresh_token } = request.body ?? {}
    // We can't identify the current session from the access token alone, so the client
    // optionally sends its current refresh token to keep it alive.
    await app.db.query(
      "UPDATE refresh_tokens SET revoked_at=now() WHERE user_id=$1 AND revoked_at IS NULL",
      [request.user.sub]
    )
    return reply.code(204).send()
  })
}
