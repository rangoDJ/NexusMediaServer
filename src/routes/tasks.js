import { requireAdmin } from '../middleware/auth.js'

/**
 * Scheduled Tasks REST API — admin-only.
 *
 * GET    /                   List all tasks with state and config
 * GET    /:id                Get a single task
 * POST   /:id/run            Trigger a task immediately
 * DELETE /:id/run            Cancel a running task
 * PUT    /:id/triggers       Replace a task's trigger list
 * GET    /:id/history        Execution history (last 20 runs)
 */
export default async function taskRoutes(app) {
  app.addHook('preHandler', app.authenticate)
  app.addHook('preHandler', requireAdmin)

  // ── List all tasks ──────────────────────────────────────────────────────────
  app.get('/', async () => {
    return app.scheduler.getAll()
  })

  // ── Get a single task ───────────────────────────────────────────────────────
  app.get('/:id', async (request, reply) => {
    const task = await app.scheduler.getById(request.params.id)
    if (!task) return reply.code(404).send({ error: 'Task not found' })
    return task
  })

  // ── Trigger a task immediately ──────────────────────────────────────────────
  app.post('/:id/run', async (request, reply) => {
    const task = await app.scheduler.getById(request.params.id)
    if (!task) return reply.code(404).send({ error: 'Task not found' })

    if (task.status === 'running' || task.status === 'cancelling') {
      return reply.code(409).send({ error: 'Task is already running' })
    }

    await app.scheduler.run(request.params.id)
    return reply.code(202).send({ status: 'started' })
  })

  // ── Cancel a running task ───────────────────────────────────────────────────
  app.delete('/:id/run', async (request, reply) => {
    const task = await app.scheduler.getById(request.params.id)
    if (!task) return reply.code(404).send({ error: 'Task not found' })

    if (task.status !== 'running') {
      return reply.code(409).send({ error: 'Task is not running' })
    }

    app.scheduler.cancel(request.params.id)
    return reply.code(202).send({ status: 'cancelling' })
  })

  // ── Update a task's triggers ────────────────────────────────────────────────
  //
  // Body: { triggers: Trigger[], is_enabled?: boolean }
  // Trigger shapes:
  //   { type: 'startup' }
  //   { type: 'interval', intervalMs: 43200000 }
  //   { type: 'daily',   timeOfDay: '03:00' }
  app.put('/:id/triggers', async (request, reply) => {
    const task = await app.scheduler.getById(request.params.id)
    if (!task) return reply.code(404).send({ error: 'Task not found' })

    const { triggers, is_enabled } = request.body
    if (!Array.isArray(triggers)) {
      return reply.code(400).send({ error: 'triggers must be an array' })
    }

    // Basic validation
    const VALID_TYPES = new Set(['startup', 'interval', 'daily'])
    for (const t of triggers) {
      if (!VALID_TYPES.has(t.type)) {
        return reply.code(400).send({ error: `Unknown trigger type "${t.type}"` })
      }
      if (t.type === 'interval' && typeof t.intervalMs !== 'number') {
        return reply.code(400).send({ error: 'interval trigger requires intervalMs (number)' })
      }
      if (t.type === 'daily' && !/^\d{2}:\d{2}$/.test(t.timeOfDay ?? '')) {
        return reply.code(400).send({ error: 'daily trigger requires timeOfDay in HH:MM format' })
      }
    }

    await app.scheduler.updateConfig(request.params.id, triggers, is_enabled)
    return app.scheduler.getById(request.params.id)
  })

  // ── Execution history ───────────────────────────────────────────────────────
  app.get('/:id/history', async (request, reply) => {
    const task = await app.scheduler.getById(request.params.id)
    if (!task) return reply.code(404).send({ error: 'Task not found' })

    const limit = Math.min(parseInt(request.query.limit ?? '20', 10), 100)
    return app.scheduler.getHistory(request.params.id, limit)
  })
}
