import { readFileSync, readdirSync } from 'fs'
import { resolve, dirname } from 'path'
import { fileURLToPath } from 'url'
import { createPool } from './pool.js'

const __dir = dirname(fileURLToPath(import.meta.url))
const migrationsDir = resolve(__dir, 'migrations')

const db = await createPool()

await db.query(`
  CREATE TABLE IF NOT EXISTS schema_migrations (
    filename TEXT PRIMARY KEY,
    applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )
`)

const applied = new Set(
  (await db.query('SELECT filename FROM schema_migrations')).rows.map(r => r.filename)
)

const files = readdirSync(migrationsDir).filter(f => f.endsWith('.sql')).sort()

for (const file of files) {
  if (applied.has(file)) continue
  const sql = readFileSync(resolve(migrationsDir, file), 'utf8')
  await db.query('BEGIN')
  try {
    await db.query(sql)
    await db.query('INSERT INTO schema_migrations(filename) VALUES($1)', [file])
    await db.query('COMMIT')
    console.log(`Applied: ${file}`)
  } catch (err) {
    await db.query('ROLLBACK')
    throw err
  }
}

console.log('Migrations complete.')
await db.end()
