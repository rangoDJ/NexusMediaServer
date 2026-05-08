import Fastify from 'fastify'
import fjwt from '@fastify/jwt'
import cors from '@fastify/cors'
import rateLimit from '@fastify/rate-limit'
import swagger from '@fastify/swagger'
import swaggerUi from '@fastify/swagger-ui'
import fastifyStatic from '@fastify/static'
import { spawn } from 'child_process'
import { resolve, dirname } from 'path'
import { fileURLToPath } from 'url'
import { createPool } from './db/pool.js'
import authRoutes from './routes/auth.js'
import libraryRoutes from './routes/libraries.js'
import mediaRoutes from './routes/media.js'
import streamRoutes from './routes/stream.js'
import transcoderRoutes from './routes/transcoders.js'
import usersRoutes from './routes/users.js'
import settingsRoutes from './routes/settings.js'
import serverRoutes from './routes/server.js'
import { authMiddleware } from './middleware/auth.js'
import { startHealthPoller } from './services/transcoderPool.js'
import { loadPlugins, callHook } from './services/pluginLoader.js'
import pluginRoutes from './routes/plugins.js'
import setupRoutes from './routes/setup.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const CLIENT_DIST = resolve(__dirname, '../client/dist')

const app = Fastify({ logger: { level: process.env.NODE_ENV === 'development' ? 'info' : 'warn' } })

// ── OpenAPI docs ──────────────────────────────────────────────────────────────
await app.register(swagger, {
  openapi: {
    info: {
      title: 'Nexus Media Server API',
      description: 'REST API for web, Android, and iOS clients.',
      version: '1.0.0',
    },
    servers: [{ url: '/api/v1' }],
    components: {
      securitySchemes: { bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' } }
    },
    security: [{ bearerAuth: [] }],
  }
})
await app.register(swaggerUi, {
  routePrefix: '/api/docs',
  uiConfig: { docExpansion: 'list', deepLinking: true },
})

// ── Rate limiting ─────────────────────────────────────────────────────────────
await app.register(rateLimit, { global: true, max: 300, timeWindow: '1 minute' })

// ── CORS (only needed in dev — in prod everything is same-origin) ─────────────
if (process.env.NODE_ENV === 'development') {
  await app.register(cors, { origin: 'http://localhost:5173' })
}

await app.register(fjwt, { secret: process.env.JWT_SECRET })

app.decorate('authenticate', authMiddleware)
app.decorate('db', await createPool())

// ── API routes (register before static so /api/* is never served as a file) ──
// Setup routes must be registered first — they are publicly accessible and
// gate the wizard before any auth is possible.
await app.register(setupRoutes,      { prefix: '/api/v1/setup' })
await app.register(serverRoutes,     { prefix: '/api/v1/server' })
await app.register(authRoutes,       { prefix: '/api/v1/auth' })
await app.register(libraryRoutes,    { prefix: '/api/v1/libraries' })
await app.register(mediaRoutes,      { prefix: '/api/v1/media' })
await app.register(streamRoutes,     { prefix: '/api/v1/stream' })
await app.register(transcoderRoutes, { prefix: '/api/v1/transcoders' })
await app.register(usersRoutes,      { prefix: '/api/v1/users' })
await app.register(settingsRoutes,   { prefix: '/api/v1/settings' })
await app.register(pluginRoutes,     { prefix: '/api/v1/plugins' })

app.get('/api/health', async () => ({ status: 'ok' }))

// ── Plugin system ─────────────────────────────────────────────────────────────
// Load plugins after main routes so api.routes hook can't shadow built-in endpoints.
await loadPlugins(app.db, app.log)
await callHook('api.routes', { app }, app.log)

// ── Static web UI ─────────────────────────────────────────────────────────────
// In dev, Vite runs on :5173 and proxies /api/* here. In production the built
// React app lives in client/dist and is served directly by this process.
if (process.env.NODE_ENV !== 'development') {
  await app.register(fastifyStatic, {
    root: CLIENT_DIST,
    prefix: '/',
    wildcard: false,
    decorateReply: true,
  })

  // SPA fallback: non-API routes that don't match a static file get index.html
  // so React Router can handle client-side navigation.
  app.setNotFoundHandler((request, reply) => {
    if (request.url.startsWith('/api/')) {
      return reply.code(404).send({ error: 'API endpoint not found' })
    }
    return reply.sendFile('index.html', CLIENT_DIST)
  })
}

// ── Start ─────────────────────────────────────────────────────────────────────
// Register onClose hooks before listen — Fastify forbids addHook after the
// server has started listening.
const pollerHandle = startHealthPoller(app.db, app.log)
app.addHook('onClose', () => clearInterval(pollerHandle))

if (process.env.NODE_ENV !== 'development') {
  const transcoderEntry = resolve(__dirname, '../transcoder/src/index.js')
  const builtin = spawn('node', [transcoderEntry], {
    env: {
      ...process.env,
      PORT:                    '3002',
      TRANSCODER_NAME:         'builtin-cpu',
      TRANSCODER_PUBLIC_URL:   'http://localhost:3002',
      API_URL:                 'http://localhost:3000',
      HW_ACCEL:                'cpu',
      IS_BUILTIN:              'true',
      HLS_OUTPUT_PATH:         '/tmp/hls',
    },
    stdio: 'inherit',
  })
  builtin.on('error', err => app.log.error(err, 'Built-in transcoder failed to start'))
  app.addHook('onClose', () => builtin.kill())
}

try {
  await app.listen({ port: 3000, host: '0.0.0.0' })
} catch (err) {
  app.log.error(err)
  process.exit(1)
}
