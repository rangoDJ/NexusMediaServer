// Simple in-memory cache so settings aren't queried on every request.
// TTL is intentionally short (60s) so UI changes propagate quickly.
let cache = null
let cacheExpiry = 0

export async function getSettings(db) {
  if (cache && Date.now() < cacheExpiry) return cache
  const { rows } = await db.query('SELECT key, value FROM settings')
  cache = Object.fromEntries(rows.map(r => [r.key, r.value]))
  cacheExpiry = Date.now() + 60_000
  return cache
}

export function invalidateSettingsCache() {
  cache = null
}

// Convenience: get a single typed value with a fallback.
export async function getSetting(db, key, fallback = null) {
  const all = await getSettings(db)
  return key in all ? all[key] : fallback
}
