import axios from 'axios'

// Auth is httpOnly-cookie-based (see src/routes/auth.js) — the access and
// refresh tokens never touch JS/localStorage, which closes off persistent
// account takeover via a future XSS bug. `withCredentials` makes the browser
// attach those cookies to every request; there is nothing for this client to
// read or store beyond the non-sensitive `nexus_user` (id/username/role, for
// UI display only — the server is the real authority on every request).
export const api = axios.create({ baseURL: '/api/v1', withCredentials: true })

// Refresh tokens rotate server-side (old one is revoked the instant a new
// pair is issued — see POST /auth/refresh). If several requests 401 at once
// (e.g. the dashboard's parallel fetches on mount), each independently
// calling /auth/refresh would race: only the first succeeds, and every other
// one gets 401 back from a token that's already been rotated out from under
// it, forcing a spurious logout on an otherwise-healthy session. Sharing one
// in-flight refresh promise across concurrent 401s avoids that.
let refreshPromise = null

api.interceptors.response.use(
  r => r,
  async err => {
    const original = err.config

    // A 401 from the auth endpoints themselves is an answer, not an expired
    // session: /auth/login says "wrong password", /auth/refresh says "your
    // session is gone". Refreshing and redirecting on those would reload the
    // login page out from under the form, discarding the error the user needs
    // to read — so let the caller handle them.
    const isAuthEndpoint = /\/auth\/(login|register|refresh)$/.test(original?.url ?? '')

    // On 401, try to refresh the access token once (cookie-based — no body
    // needed) before redirecting to login.
    if (err.response?.status === 401 && !isAuthEndpoint && !original._retried) {
      original._retried = true
      try {
        if (!refreshPromise) {
          refreshPromise = axios.post('/api/v1/auth/refresh', {}, { withCredentials: true })
            .finally(() => { refreshPromise = null })
        }
        await refreshPromise
        return api(original)
      } catch {
        // Refresh failed — fall through to logout
      }
      localStorage.removeItem('nexus_user')
      window.location.href = '/login'
    }
    return Promise.reject(err)
  }
)
