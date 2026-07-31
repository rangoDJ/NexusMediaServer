/**
 * Security header configuration.
 *
 * Split out of index.js so the headers can be asserted in tests — the first
 * version of this config took the web UI down and there was nothing to catch
 * it (see test/securityHeaders.test.js).
 *
 * THE DEPLOYMENT ASSUMPTION
 * A self-hosted media server is normally reached over plain HTTP on a LAN
 * (http://192.168.x.x:8097). helmet's defaults assume the opposite — that you
 * are on HTTPS — and quietly add two directives that break that setup:
 *
 *   upgrade-insecure-requests  rewrites every asset URL to https://. The
 *                              server doesn't speak TLS, so the bundle 404s
 *                              at the transport layer and the page renders
 *                              blank.
 *   Strict-Transport-Security  pins the host to https for a year. Browsers
 *                              ignore it when it arrives over plain HTTP, so
 *                              it does no lasting damage here, but it is
 *                              wrong to send and would bite the moment
 *                              someone put this behind TLS once.
 *
 * Both are correct for a TLS deployment and wrong as an unconditional
 * default, so they're opt-in via NEXUS_HTTPS=true — set it when a reverse
 * proxy terminates TLS in front of Nexus.
 */
/**
 * Whether auth cookies may carry the `Secure` attribute.
 *
 * Same deployment assumption as helmetOptions() above, and it must be keyed
 * off the same flag. A `Secure` cookie delivered over plain HTTP is discarded
 * by the browser without warning: the login request still returns 200 with a
 * user record, the SPA still routes to the home page, and then the very first
 * API call comes back 401 because no cookie was ever stored — which the client
 * (correctly) treats as a dead session and bounces to /login. The symptom is a
 * login that appears to succeed and instantly logs itself back out.
 *
 * Keying this off NODE_ENV is what caused exactly that: docker-compose.yml
 * sets NODE_ENV=production, but the documented way to reach a self-hosted
 * install is http://<server-ip>. (http://localhost happens to work, because
 * browsers treat localhost as a trustworthy origin — so the bug hides during
 * local testing and only appears once someone connects over the LAN.)
 */
export function secureCookies(env = process.env) {
  return env.NEXUS_HTTPS === 'true'
}

export function helmetOptions(env = process.env) {
  const https = env.NEXUS_HTTPS === 'true'

  return {
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc:  ["'self'"],
        // The client build inlines styles; CSS-in-JS and inline style
        // attributes (the per-item --art custom property) need this.
        styleSrc:   ["'self'", "'unsafe-inline'"],
        // Posters/backdrops render straight from TMDB's CDN (tmdb.js builds
        // poster_url/backdrop_url as https://image.tmdb.org/...) whenever an
        // item has no local artwork file — that's most of a typical library.
        // Without this the browser silently drops every TMDB-hosted image
        // and the <img> just renders blank; nothing errors loudly enough to
        // point at the CSP as the cause.
        imgSrc:     ["'self'", 'data:', 'blob:', 'https://image.tmdb.org'],
        // blob: is required by hls.js, which feeds segments to the video
        // element through object URLs.
        mediaSrc:   ["'self'", 'blob:'],
        workerSrc:  ["'self'", 'blob:'],
        connectSrc: ["'self'"],
        objectSrc:  ["'none'"],
        frameAncestors: ["'none'"],
        // null removes the directive helmet's defaults would otherwise add.
        upgradeInsecureRequests: https ? [] : null,
      },
    },

    strictTransportSecurity: https
      ? { maxAge: 31536000, includeSubDomains: true }
      : false,

    // Cross-origin isolation isn't needed here and interferes with loading
    // artwork and media through the app's own proxy endpoints.
    crossOriginEmbedderPolicy: false,
  }
}
