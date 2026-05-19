/**
 * Task Scheduler — Jellyfin-inspired scheduled task engine for NexusMediaServer.
 *
 * Concepts
 * ────────
 * Task definition   An object registered at startup. Describes what to run
 *                   (execute fn), its metadata, and its default triggers.
 *
 * Trigger           Describes WHEN to run a task automatically:
 *                     { type: 'startup' }                         — once after start()
 *                     { type: 'interval', intervalMs: 43_200_000 } — every N ms
 *                     { type: 'daily',   timeOfDay: '03:00' }    — HH:MM UTC daily
 *
 * Config            Persisted per-task trigger list + enabled flag (DB table
 *                   scheduled_task_configs). Falls back to task.defaultTriggers.
 *
 * Result            One row in task_results per execution. The last 20 rows
 *                   per task are retained; older rows are pruned automatically.
 *
 * Concurrency       Each task carries its own mutex — a second run() call while
 *                   the task is already running returns immediately (no queue).
 *
 * Cancellation      Uses AbortController / AbortSignal; tasks should check
 *                   signal.aborted and throw/return early.
 */

import { EventEmitter } from 'events'

const MAX_HISTORY = 20          // rows kept in task_results per task
const STARTUP_DELAY_MS = 5_000  // grace period before startup triggers fire

export class TaskScheduler extends EventEmitter {
  /** @type {import('pg').Pool} */          #db
  /** @type {import('fastify').FastifyBaseLogger} */ #log
  /** @type {Map<string, TaskDefinition>}  */ #tasks   = new Map()
  /** @type {Map<string, RuntimeState>}    */ #state   = new Map()
  /** @type {Map<string, NodeJS.Timeout[]>}*/ #timers  = new Map()

  constructor(db, log) {
    super()
    this.#db  = db
    this.#log = log
  }

  // ── Registration ─────────────────────────────────────────────────────────────

  /**
   * Register a task definition. Call before start().
   * @param {TaskDefinition} task
   */
  register(task) {
    if (this.#tasks.has(task.id)) {
      throw new Error(`Task "${task.id}" is already registered`)
    }
    this.#tasks.set(task.id, task)
    this.#state.set(task.id, {
      status:     'idle',
      progress:   null,
      startedAt:  null,
      lastResult: null,
    })
  }

  // ── Lifecycle ─────────────────────────────────────────────────────────────────

  /**
   * Load persisted configs from DB, resolve triggers, and arm all timers.
   * Must be called after the DB pool is ready.
   */
  async start() {
    await this.#ensureConfigs()
    await this.#loadLastResults()

    for (const task of this.#tasks.values()) {
      const config = await this.#loadConfig(task.id)
      if (!config.is_enabled) {
        this.#log.info(`[tasks] "${task.name}" is disabled — skipping triggers`)
        continue
      }
      this.#armTriggers(task, config.triggers)
    }

    this.#log.info(`[tasks] Scheduler started — ${this.#tasks.size} task(s) registered`)
  }

  /** Clear all timers and cancel any running tasks. */
  async stop() {
    for (const handles of this.#timers.values()) {
      handles.forEach(h => clearTimeout(h))
    }
    this.#timers.clear()

    const cancellations = []
    for (const [id, state] of this.#state.entries()) {
      if (state.status === 'running') cancellations.push(this.cancel(id))
    }
    await Promise.allSettled(cancellations)

    this.#log.info('[tasks] Scheduler stopped')
  }

  // ── Public API ────────────────────────────────────────────────────────────────

  /**
   * Manually trigger a task. Returns immediately if the task is already running.
   * @returns {boolean} false if the task was already running
   */
  async run(taskId) {
    const task = this.#tasks.get(taskId)
    if (!task) throw new Error(`Unknown task "${taskId}"`)

    const state = this.#state.get(taskId)
    if (state.status === 'running' || state.status === 'cancelling') {
      this.#log.warn(`[tasks] "${task.name}" is already running — ignoring run() request`)
      return false
    }

    // Execute in background; run() itself returns immediately
    this.#execute(task).catch(err =>
      this.#log.error({ err }, `[tasks] Unhandled error from task "${task.name}"`)
    )
    return true
  }

  /**
   * Signal the currently-running execution of a task to stop.
   * No-op if the task is idle.
   */
  cancel(taskId) {
    const state = this.#state.get(taskId)
    if (!state || state.status !== 'running') return

    this.#log.info(`[tasks] Cancelling "${this.#tasks.get(taskId)?.name}"`)
    state.status = 'cancelling'
    state._abort?.abort()
  }

  /**
   * Replace a task's triggers, persist to DB, and re-arm timers.
   * @param {string}   taskId
   * @param {Trigger[]} triggers
   * @param {boolean}  [isEnabled]
   */
  async updateConfig(taskId, triggers, isEnabled) {
    const task = this.#tasks.get(taskId)
    if (!task) throw new Error(`Unknown task "${taskId}"`)

    await this.#db.query(`
      INSERT INTO scheduled_task_configs (task_id, triggers, is_enabled, updated_at)
      VALUES ($1, $2, $3, now())
      ON CONFLICT (task_id) DO UPDATE
        SET triggers   = EXCLUDED.triggers,
            is_enabled = EXCLUDED.is_enabled,
            updated_at = now()
    `, [taskId, JSON.stringify(triggers), isEnabled ?? true])

    // Re-arm timers with new config
    const handles = this.#timers.get(taskId) ?? []
    handles.forEach(h => clearTimeout(h))
    this.#timers.delete(taskId)

    const config = await this.#loadConfig(taskId)
    if (config.is_enabled) this.#armTriggers(task, config.triggers)

    this.#log.info(`[tasks] Updated triggers for "${task.name}"`)
  }

  /** Return all tasks with their current runtime state and config. */
  async getAll() {
    const configs = await this.#loadAllConfigs()
    return Array.from(this.#tasks.values()).map(task =>
      this.#serialize(task, configs.get(task.id))
    )
  }

  /** Return one task with runtime state and config. */
  async getById(taskId) {
    const task = this.#tasks.get(taskId)
    if (!task) return null
    const config = await this.#loadConfig(taskId)
    return this.#serialize(task, config)
  }

  /** Return the last N execution results for a task. */
  async getHistory(taskId, limit = MAX_HISTORY) {
    const { rows } = await this.#db.query(`
      SELECT status, started_at, ended_at, duration_ms, error_message
      FROM task_results
      WHERE task_id = $1
      ORDER BY started_at DESC
      LIMIT $2
    `, [taskId, limit])
    return rows
  }

  // ── Private — execution ───────────────────────────────────────────────────────

  async #execute(task) {
    const state = this.#state.get(task.id)
    const abort = new AbortController()
    const startedAt = new Date()

    state.status    = 'running'
    state.progress  = 0
    state.startedAt = startedAt
    state._abort    = abort

    this.emit('taskStarted', { taskId: task.id, startedAt })
    this.#log.info(`[tasks] ▶ Starting "${task.name}"`)

    let status       = 'completed'
    let errorMessage = null

    try {
      await task.execute({
        db:       this.#db,
        log:      this.#log,
        signal:   abort.signal,
        progress: pct => {
          state.progress = Math.round(Math.max(0, Math.min(100, pct)))
          this.emit('taskProgress', { taskId: task.id, progress: state.progress })
        },
      })

      if (abort.signal.aborted) status = 'cancelled'
    } catch (err) {
      if (abort.signal.aborted) {
        status = 'cancelled'
      } else {
        status       = 'failed'
        errorMessage = err.message
        this.#log.error({ err }, `[tasks] ✗ "${task.name}" failed`)
      }
    }

    const endedAt    = new Date()
    const durationMs = endedAt - startedAt

    // Persist result
    const lastResult = { status, startedAt, endedAt, durationMs, errorMessage }
    state.lastResult = lastResult
    state.status     = 'idle'
    state.progress   = null
    state.startedAt  = null
    state._abort     = null

    await this.#saveResult(task.id, lastResult)

    const icon = status === 'completed' ? '✓' : status === 'cancelled' ? '⊘' : '✗'
    this.#log.info(
      `[tasks] ${icon} "${task.name}" ${status} in ${(durationMs / 1000).toFixed(1)}s`
    )
    this.emit('taskFinished', { taskId: task.id, ...lastResult })
  }

  // ── Private — triggers ────────────────────────────────────────────────────────

  #armTriggers(task, triggers) {
    const handles = []

    for (const trigger of triggers) {
      if (trigger.type === 'startup') {
        const h = setTimeout(() => {
          this.#log.info(`[tasks] Startup trigger firing for "${task.name}"`)
          this.run(task.id).catch(err =>
            this.#log.error({ err }, `[tasks] Startup trigger failed for "${task.name}"`)
          )
        }, STARTUP_DELAY_MS)
        handles.push(h)

      } else if (trigger.type === 'interval') {
        const scheduleNext = () => {
          const h = setTimeout(() => {
            this.#log.info(`[tasks] Interval trigger firing for "${task.name}"`)
            this.run(task.id)
              .catch(err =>
                this.#log.error({ err }, `[tasks] Interval trigger failed for "${task.name}"`)
              )
              .finally(() => scheduleNext())
          }, trigger.intervalMs)
          handles.push(h)
        }
        scheduleNext()

      } else if (trigger.type === 'daily') {
        const scheduleNext = () => {
          const h = setTimeout(() => {
            this.#log.info(`[tasks] Daily trigger firing for "${task.name}"`)
            this.run(task.id)
              .catch(err =>
                this.#log.error({ err }, `[tasks] Daily trigger failed for "${task.name}"`)
              )
              .finally(() => scheduleNext())
          }, msUntilTimeOfDay(trigger.timeOfDay))
          handles.push(h)
        }
        scheduleNext()

      } else {
        this.#log.warn(`[tasks] Unknown trigger type "${trigger.type}" for "${task.name}"`)
      }
    }

    this.#timers.set(task.id, handles)
  }

  // ── Private — DB helpers ──────────────────────────────────────────────────────

  /** Upsert a config row for every registered task that doesn't have one yet. */
  async #ensureConfigs() {
    for (const task of this.#tasks.values()) {
      await this.#db.query(`
        INSERT INTO scheduled_task_configs (task_id, triggers, is_enabled)
        VALUES ($1, $2, true)
        ON CONFLICT (task_id) DO NOTHING
      `, [task.id, JSON.stringify(task.defaultTriggers ?? [])])
    }
  }

  async #loadConfig(taskId) {
    const { rows } = await this.#db.query(
      'SELECT triggers, is_enabled FROM scheduled_task_configs WHERE task_id = $1',
      [taskId]
    )
    if (rows[0]) return rows[0]
    const task = this.#tasks.get(taskId)
    return { triggers: task?.defaultTriggers ?? [], is_enabled: true }
  }

  async #loadAllConfigs() {
    const { rows } = await this.#db.query(
      'SELECT task_id, triggers, is_enabled FROM scheduled_task_configs'
    )
    return new Map(rows.map(r => [r.task_id, r]))
  }

  async #loadLastResults() {
    const { rows } = await this.#db.query(`
      SELECT DISTINCT ON (task_id)
        task_id, status, started_at, ended_at, duration_ms, error_message
      FROM task_results
      ORDER BY task_id, started_at DESC
    `)
    for (const row of rows) {
      const state = this.#state.get(row.task_id)
      if (state) state.lastResult = row
    }
  }

  async #saveResult(taskId, { status, startedAt, endedAt, durationMs, errorMessage }) {
    await this.#db.query(`
      INSERT INTO task_results (task_id, status, started_at, ended_at, duration_ms, error_message)
      VALUES ($1, $2, $3, $4, $5, $6)
    `, [taskId, status, startedAt, endedAt, durationMs, errorMessage ?? null])

    // Prune old history
    await this.#db.query(`
      DELETE FROM task_results
      WHERE task_id = $1
        AND id NOT IN (
          SELECT id FROM task_results
          WHERE task_id = $1
          ORDER BY started_at DESC
          LIMIT $2
        )
    `, [taskId, MAX_HISTORY])
  }

  // ── Private — serialisation ───────────────────────────────────────────────────

  #serialize(task, config) {
    const state = this.#state.get(task.id)
    return {
      id:          task.id,
      name:        task.name,
      description: task.description,
      category:    task.category,
      status:      state?.status    ?? 'idle',
      progress:    state?.progress  ?? null,
      started_at:  state?.startedAt ?? null,
      last_result: state?.lastResult ?? null,
      is_enabled:  config?.is_enabled ?? true,
      triggers:    config?.triggers   ?? task.defaultTriggers ?? [],
    }
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Milliseconds from now until the next occurrence of a UTC time of day.
 * @param {string} timeOfDay "HH:MM"
 */
function msUntilTimeOfDay(timeOfDay) {
  const [hours, minutes] = timeOfDay.split(':').map(Number)
  const now  = new Date()
  const next = new Date(Date.UTC(
    now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(),
    hours, minutes, 0, 0
  ))
  if (next <= now) next.setUTCDate(next.getUTCDate() + 1)
  return next - now
}

/**
 * @typedef {Object} TaskDefinition
 * @property {string}    id
 * @property {string}    name
 * @property {string}    description
 * @property {string}    category
 * @property {Trigger[]} defaultTriggers
 * @property {(ctx: ExecuteContext) => Promise<void>} execute
 *
 * @typedef {Object} Trigger
 * @property {'startup'|'interval'|'daily'} type
 * @property {number}  [intervalMs]    interval trigger
 * @property {string}  [timeOfDay]     daily trigger "HH:MM"
 *
 * @typedef {Object} ExecuteContext
 * @property {import('pg').Pool}                      db
 * @property {import('fastify').FastifyBaseLogger}    log
 * @property {AbortSignal}                            signal
 * @property {(pct: number) => void}                  progress
 *
 * @typedef {Object} RuntimeState
 * @property {'idle'|'running'|'cancelling'} status
 * @property {number|null}  progress
 * @property {Date|null}    startedAt
 * @property {Object|null}  lastResult
 * @property {AbortController|null} _abort
 */
