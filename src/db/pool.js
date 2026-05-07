import pg from 'pg'

const { Pool } = pg

export async function createPool() {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL })
  await pool.query('SELECT 1') // fail fast if DB is unreachable
  return pool
}
