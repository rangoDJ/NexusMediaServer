import { describe, it, expect, vi, beforeEach } from 'vitest'
import Fastify from 'fastify'
import fjwt from '@fastify/jwt'
import fcookie from '@fastify/cookie'
import bcrypt from 'bcrypt'
import authRoutes from '../src/routes/auth.js'
import { secureCookies } from '../src/config/security.js'
import { invalidateSettingsCache } from '../src/services/settingsCache.js'

/**
 * Regression coverage for a login that instantly logged itself back out.
 *
 * The auth cookies took their `Secure` attribute from NODE_ENV, which
 * docker-compose.yml sets to `production` — while the documented way to reach
 * a self-hosted install is plain http://<server-ip>. Browsers discard a
 * `Secure` cookie that arrives over HTTP without any error, so the login POST
 * returned 200, the SPA routed to the home page, the first API call came back
 * 401 with no cookie attached, and the client bounced straight back to /login.
 *
 * It survived local testing because browsers treat http://localhost as a
 * trustworthy origin and keep the cookie — the failure only shows up over
 * the LAN.
 */

const PASSWORD = 'correct horse battery staple'

function fakeDb(passwordHash) {
  return {
    query: vi.fn(async sql => {
      if (sql.includes('FROM settings'))            return { rows: [] }
      if (sql.includes('FROM users WHERE username')) {
        return { rows: [{ id: 'u1', username: 'alice', password_hash: passwordHash, role: 'admin' }] }
      }
      if (sql.includes('INSERT INTO refresh_tokens')) return { rows: [] }
      if (sql.includes('INSERT INTO activity_log'))   return { rows: [] }
      return { rows: [] }
    }),
  }
}

async function loginCookies(env = {}) {
  const original = { ...process.env }
  Object.assign(process.env, env)
  try {
    const app = Fastify()
    await app.register(fcookie)
    await app.register(fjwt, {
      secret: 'a'.repeat(64),
      cookie: { cookieName: 'nexus_access', signed: false },
    })
    app.decorate('db', fakeDb(await bcrypt.hash(PASSWORD, 10)))
    await app.register(authRoutes, { prefix: '/api/v1/auth' })

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { username: 'alice', password: PASSWORD },
    })
    await app.close()

    const raw = res.headers['set-cookie']
    return { res, cookies: Array.isArray(raw) ? raw : [raw].filter(Boolean) }
  } finally {
    process.env = original
  }
}

beforeEach(() => {
  invalidateSettingsCache()
  delete process.env.NEXUS_HTTPS
})

describe('auth cookies — plain-HTTP deployment (default)', () => {
  it('does not mark cookies Secure just because NODE_ENV=production', async () => {
    const { res, cookies } = await loginCookies({ NODE_ENV: 'production' })

    expect(res.statusCode).toBe(200)
    expect(cookies).toHaveLength(2)
    // A Secure cookie over http:// is dropped by the browser, which turns a
    // successful login into an immediate logout.
    for (const cookie of cookies) expect(cookie).not.toMatch(/;\s*Secure/i)
  })

  it('still sets both auth cookies, httpOnly, with the refresh cookie scoped to /api/v1/auth', async () => {
    const { cookies } = await loginCookies({ NODE_ENV: 'production' })

    const access  = cookies.find(c => c.startsWith('nexus_access='))
    const refresh = cookies.find(c => c.startsWith('nexus_refresh='))

    expect(access).toMatch(/HttpOnly/i)
    expect(access).toMatch(/Path=\//)
    expect(access).toMatch(/SameSite=Strict/i)
    expect(refresh).toMatch(/HttpOnly/i)
    expect(refresh).toMatch(/Path=\/api\/v1\/auth/)
  })
})

describe('auth cookies — TLS deployment (opt-in)', () => {
  it('marks both cookies Secure when NEXUS_HTTPS=true', async () => {
    const { cookies } = await loginCookies({ NEXUS_HTTPS: 'true' })

    expect(cookies).toHaveLength(2)
    for (const cookie of cookies) expect(cookie).toMatch(/;\s*Secure/i)
  })

  it('is keyed off the same flag as the rest of the security config', () => {
    expect(secureCookies({ NEXUS_HTTPS: 'true' })).toBe(true)
    expect(secureCookies({ NEXUS_HTTPS: 'false' })).toBe(false)
    expect(secureCookies({ NODE_ENV: 'production' })).toBe(false)
    expect(secureCookies({})).toBe(false)
  })
})
