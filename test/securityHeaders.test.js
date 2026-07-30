import { describe, it, expect } from 'vitest'
import Fastify from 'fastify'
import helmet from '@fastify/helmet'
import { helmetOptions } from '../src/config/security.js'

/**
 * Regression coverage for a blank-page outage.
 *
 * The first CSP shipped only the directives it named and inherited the rest
 * from helmet's defaults — which include `upgrade-insecure-requests`. On a
 * plain-HTTP LAN install (http://<ip>:8097, the normal way this server is
 * reached) that made the browser rewrite every asset URL to https, so the
 * bundle never loaded and the page rendered empty.
 *
 * helmet's default HSTS header had the same root cause: correct for a
 * TLS-terminated deployment, wrong as an unconditional default here.
 */
async function headersFor(env = {}) {
  const app = Fastify()
  await app.register(helmet, helmetOptions(env))
  app.get('/', async () => 'ok')
  const res = await app.inject({ method: 'GET', url: '/' })
  await app.close()
  return res.headers
}

describe('security headers — plain-HTTP deployment (default)', () => {
  it('does not force asset URLs to https', async () => {
    const csp = (await headersFor())['content-security-policy']
    expect(csp).toBeTruthy()
    expect(csp).not.toContain('upgrade-insecure-requests')
  })

  it('does not send HSTS, which would pin the host to https for a year', async () => {
    expect((await headersFor())['strict-transport-security']).toBeUndefined()
  })

  it('still ships the protections the CSP exists for', async () => {
    const h = await headersFor()
    const csp = h['content-security-policy']
    expect(csp).toContain("default-src 'self'")
    expect(csp).toContain("script-src 'self'")
    expect(csp).toContain("object-src 'none'")
    expect(csp).toContain("frame-ancestors 'none'")
    // Playback and artwork must keep working.
    expect(csp).toContain('blob:')
    expect(h['x-content-type-options']).toBe('nosniff')
  })
})

describe('security headers — TLS deployment (opt-in)', () => {
  it('enables HSTS and https upgrades when NEXUS_HTTPS=true', async () => {
    const h = await headersFor({ NEXUS_HTTPS: 'true' })
    expect(h['strict-transport-security']).toContain('max-age=')
    expect(h['content-security-policy']).toContain('upgrade-insecure-requests')
  })
})
