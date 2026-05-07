import Fastify from 'fastify'
import axios from 'axios'
import sessionRoutes from './routes/sessions.js'
import probeRoutes from './routes/probe.js'

const app = Fastify({ logger: true })

// All requests must carry the shared secret
app.addHook('onRequest', async (request, reply) => {
  if (request.headers['x-transcoder-secret'] !== process.env.TRANSCODER_SECRET) {
    reply.code(401).send({ error: 'Unauthorized' })
  }
})

await app.register(sessionRoutes, { prefix: '/session' })
await app.register(probeRoutes, { prefix: '/probe' })

app.get('/health', async () => {
  const { sessionStore } = await import('./services/sessionStore.js')
  return {
    status: 'ok',
    active_sessions: sessionStore.size,
    node_name: process.env.TRANSCODER_NAME ?? 'transcoder',
    hw_accel: process.env.HW_ACCEL ?? 'cpu',
  }
})

const port = parseInt(process.env.PORT ?? '3001')
await app.listen({ port, host: '0.0.0.0' })

// Register with the API so it can be picked up for sessions automatically.
// Retries until the API is reachable (handles startup ordering).
async function registerWithApi() {
  const apiUrl   = process.env.API_URL
  const selfUrl  = process.env.TRANSCODER_PUBLIC_URL
  const name     = process.env.TRANSCODER_NAME ?? 'transcoder'
  const hwAccel  = process.env.HW_ACCEL ?? 'cpu'
  const isBuiltin = process.env.IS_BUILTIN === 'true'

  if (!apiUrl || !selfUrl) {
    app.log.warn('API_URL or TRANSCODER_PUBLIC_URL not set — skipping auto-registration')
    return
  }

  for (let attempt = 1; attempt <= 10; attempt++) {
    try {
      await axios.post(
        `${apiUrl}/api/v1/transcoders/register`,
        { name, url: selfUrl, hw_accel: hwAccel, is_builtin: isBuiltin },
        { headers: { 'x-transcoder-secret': process.env.TRANSCODER_SECRET }, timeout: 5000 }
      )
      app.log.info(`Registered with API as "${name}" (${hwAccel}) @ ${selfUrl}`)
      return
    } catch (err) {
      app.log.warn(`Registration attempt ${attempt}/10 failed: ${err.message}. Retrying in 5s...`)
      await new Promise(r => setTimeout(r, 5000))
    }
  }

  app.log.error('Could not register with API after 10 attempts. Add this node manually.')
}

registerWithApi()
