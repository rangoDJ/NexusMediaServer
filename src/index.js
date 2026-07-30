import Fastify from 'fastify'
import fjwt from '@fastify/jwt'
import fcookie from '@fastify/cookie'
import helmet from '@fastify/helmet'
import cors from '@fastify/cors'
import rateLimit from '@fastify/rate-limit'
import swagger from '@fastify/swagger'
import swaggerUi from '@fastify/swagger-ui'
import fastifyStatic from '@fastify/static'
import { spawn } from 'child_process'
import { resolve, dirname } from 'path'
import { fileURLToPath } from 'url'
import { createPool } from './db/pool.js'
import { helmetOptions } from './config/security.js'
import authRoutes from './routes/auth.js'
import libraryRoutes from './routes/libraries.js'
import mediaRoutes from './routes/media.js'
import streamRoutes from './routes/stream.js'
import transcoderRoutes from './routes/transcoders.js'
import usersRoutes from './routes/users.js'
import settingsRoutes from './routes/settings.js'
import serverRoutes from './routes/server.js'
import { authMiddleware } from './middleware/auth.js'
import { buildLogger } from './services/logging.js'
import { startHealthPoller } from './services/transcoderPool.js'
import { loadPlugins, callHook } from './services/pluginLoader.js'
import { TaskScheduler } from './services/taskScheduler.js'
import { ScanBroadcaster } from './services/scanBroadcaster.js'
import { DirectoryWatcher } from './services/directoryWatcher.js'
import pluginRoutes from './routes/plugins.js'
import setupRoutes from './routes/setup.js'
import searchRoutes from './routes/search.js'
import peopleRoutes from './routes/people.js'
import taskRoutes from './routes/tasks.js'
import eventsRoute from './routes/events.js'
import collectionsRoutes from './routes/collections.js'
import activityRoutes from './routes/activity.js'
import { createScanLibrariesTask } from './tasks/scanLibraries.js'
import { cleanupSessionsTask } from './tasks/cleanupSessions.js'
import { refreshMetadataTask } from './tasks/refreshMetadata.js'
import { generateTrickplayTask } from './tasks/generateTrickplay.js'
import { analyzeIntrosTask } from './tasks/analyzeIntros.js'
import { extractColorsTask } from './tasks/extractColors.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const CLIENT_DIST = resolve(__dirname, '../client/dist')

// Built and validated *before* the Fastify constructor runs — pino.transport()
// can throw synchronously (e.g. a container image that wasn't rebuilt with
// the pino-roll dependency), and Fastify does not catch that; it would crash
// the whole process before ever binding to a port. buildLogger() can't throw.
const app = Fastify({
  loggerInstance: buildLogger({
    logDir:       process.env.LOG_DIR ?? '/config/logs',
    fileBaseName: 'server',
    retentionDays: parseInt(process.env.LOG_RETENTION_DAYS ?? '3', 10),
  }),
})

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
  await app.register(cors, { origin: 'http://localhost:5173', credentials: true })
}

// ── Cookies (httpOnly auth cookies — see routes/auth.js) ──────────────────────
await app.register(fcookie)

// ── Security headers / CSP ─────────────────────────────────────────────────────
// Auth is cookie-based (httpOnly), so a CSP is the main remaining backstop
// against token theft via a future XSS.
//
// Configured in config/security.js and asserted in test/securityHeaders.test.js
// — helmet's defaults assume HTTPS and will otherwise add
// upgrade-insecure-requests, which blanks the UI on a plain-HTTP LAN install.
await app.register(helmet, helmetOptions())

if (!process.env.JWT_SECRET || process.env.JWT_SECRET.length < 32) {
  console.error('FATAL: JWT_SECRET must be at least 32 characters. Generate one with: node -e "console.log(require(\'crypto\').randomBytes(64).toString(\'hex\'))"')
  process.exit(1)
}
// Bearer header still works (mobile apps, API scripts); when absent, fall
// back to the httpOnly cookie set by routes/auth.js — this is what lets the
// web SPA authenticate <video>/<img>/<track>/EventSource/hls.js requests
// without ever touching the token in JS (see client/src/api/client.js).
await app.register(fjwt, {
  secret: process.env.JWT_SECRET,
  cookie: { cookieName: 'nexus_access', signed: false },
})

// The transcoder is a separate service — possibly on a different, GPU-equipped
// host reachable over the network (see docker-compose.yml). Its shared secret
// gates unauthenticated ffmpeg/ffprobe execution and session control, so it
// deserves the same strength floor as JWT_SECRET rather than being allowed to
// run with the .env.example placeholder.
if (!process.env.TRANSCODER_SECRET || process.env.TRANSCODER_SECRET.length < 32) {
  console.error('FATAL: TRANSCODER_SECRET must be at least 32 characters. Generate one with: node -e "console.log(require(\'crypto\').randomBytes(64).toString(\'hex\'))"')
  process.exit(1)
}

app.decorate('authenticate', authMiddleware)
app.decorate('db', await createPool())

// ── Scan broadcaster (SSE fan-out) ────────────────────────────────────────────
const broadcaster = new ScanBroadcaster()
app.decorate('broadcaster', broadcaster)

// ── Directory watcher ─────────────────────────────────────────────────────────
// Reacts to filesystem changes (new files, deletions, replacements) and runs a
// debounced library scan — eliminates the need for frequent polling scans.
const directoryWatcher = new DirectoryWatcher(app.db, app.log, broadcaster)
app.decorate('directoryWatcher', directoryWatcher)

// ── Task scheduler ────────────────────────────────────────────────────────────
const scheduler = new TaskScheduler(app.db, app.log)
scheduler.register(createScanLibrariesTask(broadcaster, directoryWatcher))
scheduler.register(cleanupSessionsTask)
scheduler.register(refreshMetadataTask)
scheduler.register(generateTrickplayTask)
scheduler.register(analyzeIntrosTask)
scheduler.register(extractColorsTask)
app.decorate('scheduler', scheduler)

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
await app.register(searchRoutes,     { prefix: '/api/v1/search' })
await app.register(peopleRoutes,     { prefix: '/api/v1/people' })
await app.register(taskRoutes,        { prefix: '/api/v1/tasks' })
await app.register(collectionsRoutes, { prefix: '/api/v1/collections' })
await app.register(activityRoutes,    { prefix: '/api/v1/activity' })
await app.register(eventsRoute,       { prefix: '/api/v1' })

// Docker healthcheck endpoint. MUST always return 2xx as long as the
// server itself is responsive — the transcoder stats are best-effort and
// must never cause the container to be marked unhealthy. A DB blip or a
// missing migration was previously killing the health status.
app.get('/api/health', async (request, reply) => {
  let transcoder_nodes = null
  try {
    const { rows } = await app.db.query(`
      SELECT
        COUNT(*) FILTER (WHERE is_enabled = true AND last_seen_at > now() - interval '2 minutes') AS online,
        COUNT(*) FILTER (WHERE is_enabled = true)                                                  AS total
      FROM transcoder_nodes
    `)
    transcoder_nodes = { online: parseInt(rows[0].online), total: parseInt(rows[0].total) }
  } catch (err) {
    request.log.warn({ err }, '[health] transcoder_nodes query failed (non-fatal)')
  }
  return reply.code(200).send({ status: 'ok', transcoder_nodes })
})

// ── Plugin system ─────────────────────────────────────────────────────────────
// Load plugins after main routes so api.routes hook can't shadow built-in endpoints.
// Pass the scheduler so plugins can register their own scheduled tasks.
await loadPlugins(app.db, app.log, scheduler)
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
app.addHook('onClose', () => scheduler.stop())
app.addHook('onClose', () => directoryWatcher.stop())

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
  // Start the task scheduler after the server is fully up so that startup
  // triggers fire into a ready application.
  await scheduler.start()
  // Start filesystem watchers after the server is up — events fired during
  // startup might race with migrations / plugin load otherwise.
  await directoryWatcher.start()
} catch (err) {
  app.log.error(err)
  process.exit(1)
}
