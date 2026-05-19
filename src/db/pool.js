import pg from 'pg'

const { Pool } = pg

/**
 * Hardened pg pool.
 *
 * The defaults were causing "Connection terminated unexpectedly" + Postgres
 * "canceling authentication due to timeout" under load:
 *   - max=10 connections is too small once we have the scheduler, the watcher,
 *     the refresh task (holds a connection for minutes), the health poller,
 *     SSE event clients, and normal API traffic running concurrently.
 *   - No `error` handler on the pool means an idle-disconnect crashes Node.
 *   - No connectionTimeoutMillis means callers wait forever on a full pool.
 */
export async function createPool() {
  const pool = new Pool({
    connectionString:            process.env.DATABASE_URL,
    max:                         parseInt(process.env.DB_POOL_MAX ?? '30'),
    idleTimeoutMillis:           60_000,  // close idle clients after 60s
    connectionTimeoutMillis:     10_000,  // give up acquiring after 10s instead of hanging
    keepAlive:                   true,
    keepAliveInitialDelayMillis: 10_000,
  })

  // Without this listener, an idle-client error (DB restart, network blip,
  // Postgres killed the connection) throws an unhandled 'error' event and
  // crashes the Node process. We log + let pg-pool drop the bad client.
  pool.on('error', (err) => {
    console.warn('[db] idle client error (pool will drop it):', err.message)
  })

  await pool.query('SELECT 1') // fail fast if DB is unreachable
  return pool
}
