import axios from 'axios'

export const api = axios.create({ baseURL: '/api/v1' })

api.interceptors.request.use(config => {
  const token = localStorage.getItem('nexus_token')
  if (token) config.headers.Authorization = `Bearer ${token}`
  return config
})

api.interceptors.response.use(
  r => r,
  async err => {
    const original = err.config

    // On 401, try to refresh the access token once before redirecting to login.
    if (err.response?.status === 401 && !original._retried) {
      original._retried = true
      const refreshToken = localStorage.getItem('nexus_refresh_token')
      if (refreshToken) {
        try {
          const { data } = await axios.post('/api/v1/auth/refresh', { refresh_token: refreshToken })
          localStorage.setItem('nexus_token', data.access_token)
          localStorage.setItem('nexus_refresh_token', data.refresh_token)
          original.headers.Authorization = `Bearer ${data.access_token}`
          return api(original)
        } catch {
          // Refresh failed — fall through to logout
        }
      }
      localStorage.removeItem('nexus_token')
      localStorage.removeItem('nexus_refresh_token')
      localStorage.removeItem('nexus_user')
      window.location.href = '/login'
    }
    return Promise.reject(err)
  }
)
