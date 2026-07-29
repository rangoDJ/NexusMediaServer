import bcrypt from 'bcrypt'
import crypto from 'crypto'
import { getSetting } from '../services/settingsCache.js'
import { callHook } from '../services/pluginLoader.js'
import { logActivity } from '../services/activityLog.js'

// Access tokens are short-lived (1 day). Refresh tokens are long-lived and stored
// as bcrypt hashes so a DB breach doesn't yield usable tokens.

const ACCESS_TOKEN_TTL = '1d'
const ACCESS_TOKEN_TTL_SECS = 24 * 60 * 60

function generateRefreshToken() {
  return crypto.randomBytes(48).toString('base64url')
}

// httpOnly + SameSite=Strict cookies are the primary auth channel for the web
// SPA — they can't be read or exfiltrated by JS (unlike the old localStorage
// tokens), which closes off persistent account takeover via a future XSS bug.
// The refresh cookie is scoped to /api/v1/auth so it's never sent on ordinary
// API/media requests. Tokens are still also returned in the JSON body for
// non-browser API clients (mobile apps, scripts) that manage their own storage.
function setAuthCookies(reply, { access_token, refresh_token }, sessionDays) {
  const secure = process.env.NODE_ENV === 'production'
  reply.setCookie('nexus_access', access_token, {
    httpOnly: true, sameSite: 'strict', secure, path: '/', maxAge: ACCESS_TOKEN_TTL_SECS,
  })
  reply.setCookie('nexus_refresh', refresh_token, {
    httpOnly: true, sameSite: 'strict', secure, path: '/api/v1/auth', maxAge: sessionDays * 86_400,
  })
}

function clearAuthCookies(reply) {
  reply.clearCookie('nexus_access',  { path: '/' })
  reply.clearCookie('nexus_refresh', { path: '/api/v1/auth' })
}

async function issueTokens(app, reply, db, user, { device_name, device_type, ip_address, user_agent } = {}) {
  const sessionDays = await getSetting(db, 'auth.session_days', 30)
  const accessToken = app.jwt.sign(
    { sub: user.id, username: user.username, role: user.role },
    { expiresIn: ACCESS_TOKEN_TTL }
  )

  const refreshToken = generateRefreshToken()
  const tokenPrefix  = refreshToken.slice(0, 16)
  const tokenHash    = await bcrypt.hash(refreshToken, 10)
  const expiresAt    = new Date(Date.now() + sessionDays * 86_400_000)

  await db.query(`
    INSERT INTO refresh_tokens(user_id, token_hash, token_prefix, device_name, device_type, ip_address, user_agent, expires_at)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8)
  `, [user.id, tokenHash, tokenPrefix, device_name ?? null, device_type ?? null, ip_address ?? null, user_agent ?? null, expiresAt])

  const tokens = { access_token: accessToken, refresh_token: refreshToken }
  setAuthCookies(reply, tokens, sessionDays)
  return tokens
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

    // Post-insert race guard: if two requests raced to be the first user they
    // both got role='admin'. Keep only the one that is the sole row; downgrade
    // the other to viewer so there's exactly one bootstrap admin.
    if (isFirst && user) {
      const { rows: [{ count: total }] } = await app.db.query('SELECT COUNT(*) FROM users')
      if (total !== '1') {
        await app.db.query("UPDATE users SET role='viewer' WHERE id=$1", [user.id])
        user.role = 'viewer'
      }
    }

    const tokens = await issueTokens(app, reply, app.db, user, {
      device_name, device_type,
      ip_address: request.ip,
      user_agent: request.headers['user-agent'],
    })

    logActivity(app.db, app.log, {
      type: 'user.created', userId: user.id,
      message: `Account "${user.username}" created${isFirst ? ' (initial admin)' : ''}`,
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
      logActivity(app.db, app.log, {
        type: 'auth.login_failed', severity: 'warning',
        message: `Failed sign-in attempt for "${username}"`,
        details: { ip_address: request.ip },
      })
      return reply.code(401).send({ error: 'Invalid credentials' })
    }

    // Allow plugins to veto a login (auth.login hook)
    const hookResults = await callHook('auth.login', { username }, app.log)
    for (const result of hookResults) {
      if (result?.denied) {
        return reply.code(403).send({ error: result.reason ?? 'Login denied by server policy' })
      }
    }

    const tokens = await issueTokens(app, reply, app.db, user, {
      device_name, device_type,
      ip_address: request.ip,
      user_agent: request.headers['user-agent'],
    })

    logActivity(app.db, app.log, {
      type: 'auth.login', userId: user.id,
      message: `${user.username} signed in${device_name ? ` from ${device_name}` : ''}`,
      details: { ip_address: request.ip, device_type },
    })

    return { ...tokens, user: { id: user.id, username: user.username, role: user.role } }
  })

  // Exchange a refresh token for a new access + refresh token pair (rotation).
  app.post('/refresh', { config: { rateLimit: AUTH_RATE_LIMIT } }, async (request, reply) => {
    // The web client no longer sends this in the body — the refresh cookie
    // (scoped to /api/v1/auth) is included automatically. Body support is
    // kept for non-browser API clients that manage their own token storage.
    const refresh_token = request.body?.refresh_token ?? request.cookies?.nexus_refresh
    if (!refresh_token) return reply.code(400).send({ error: 'refresh_token required' })

    // Use the token prefix (first 16 chars, stored plaintext) to find the
    // candidate row via an indexed lookup before doing the expensive bcrypt compare.
    // Rows without a prefix (issued before migration 015) fall back gracefully —
    // token_prefix IS NULL rows simply won't match and those sessions expire naturally.
    const tokenPrefix = refresh_token.slice(0, 16)
    const { rows } = await app.db.query(`
      SELECT rt.*, u.username, u.role
      FROM refresh_tokens rt
      JOIN users u ON u.id = rt.user_id
      WHERE rt.token_prefix = $1
        AND rt.revoked_at IS NULL
        AND rt.expires_at > now()
    `, [tokenPrefix])

    let match = null
    for (const row of rows) {
      if (await bcrypt.compare(refresh_token, row.token_hash)) { match = row; break }
    }
    if (!match) return reply.code(401).send({ error: 'Invalid or expired refresh token' })

    // Revoke old token, issue new pair
    await app.db.query('UPDATE refresh_tokens SET revoked_at=now() WHERE id=$1', [match.id])

    const user = { id: match.user_id, username: match.username, role: match.role }
    const tokens = await issueTokens(app, reply, app.db, user, {
      device_name: match.device_name,
      device_type: match.device_type,
      ip_address: request.ip,
      user_agent: request.headers['user-agent'],
    })
    return { ...tokens, user }
  })

  // Revoke the current session's refresh token and clear auth cookies.
  app.post('/logout', async (request, reply) => {
    const refresh_token = request.body?.refresh_token ?? request.cookies?.nexus_refresh
    if (refresh_token) {
      const prefix = refresh_token.slice(0, 16)
      const { rows } = await app.db.query(
        `SELECT id, token_hash FROM refresh_tokens WHERE token_prefix=$1 AND revoked_at IS NULL`,
        [prefix]
      )
      for (const row of rows) {
        if (await bcrypt.compare(refresh_token, row.token_hash)) {
          await app.db.query('UPDATE refresh_tokens SET revoked_at=now() WHERE id=$1', [row.id])
          break
        }
      }
    }
    clearAuthCookies(reply)
    return reply.code(204).send()
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
    const current_refresh_token = request.body?.current_refresh_token ?? request.cookies?.nexus_refresh

    let keepId = null
    if (current_refresh_token) {
      // Find the current session's DB id so we can exclude it from the revocation.
      const prefix = current_refresh_token.slice(0, 16)
      const { rows } = await app.db.query(
        `SELECT id, token_hash FROM refresh_tokens
         WHERE token_prefix=$1 AND user_id=$2 AND revoked_at IS NULL`,
        [prefix, request.user.sub]
      )
      for (const row of rows) {
        if (await bcrypt.compare(current_refresh_token, row.token_hash)) { keepId = row.id; break }
      }
    }

    if (keepId) {
      await app.db.query(
        "UPDATE refresh_tokens SET revoked_at=now() WHERE user_id=$1 AND revoked_at IS NULL AND id != $2",
        [request.user.sub, keepId]
      )
    } else {
      await app.db.query(
        "UPDATE refresh_tokens SET revoked_at=now() WHERE user_id=$1 AND revoked_at IS NULL",
        [request.user.sub]
      )
    }
    return reply.code(204).send()
  })
}
