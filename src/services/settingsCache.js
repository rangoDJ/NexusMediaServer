// Simple in-memory cache so settings aren't queried on every request.
// TTL is intentionally short (60s) so UI changes propagate quickly.
let cache = null
let cacheExpiry = 0
// In-flight promise: when the cache is cold and multiple concurrent callers
// arrive simultaneously, they all share one DB query instead of each firing
// their own. Without this, a cache miss under load produces N identical
// round-trips to Postgres — a classic thundering-herd problem.
let pending = null
// Bumped on every invalidation so a stale in-flight query that resolves AFTER
// an invalidation can't re-seed the cache with pre-invalidation data.
let generation = 0

export async function getSettings(db) {
  if (cache && Date.now() < cacheExpiry) return cache
  if (pending) return pending
  const thisGen = generation
  pending = db.query('SELECT key, value FROM settings')
    .then(({ rows }) => {
      if (thisGen !== generation) return getSettings(db)
      cache = Object.fromEntries(rows.map(r => [r.key, r.value]))
      cacheExpiry = Date.now() + 60_000
      pending = null
      return cache
    })
    .catch(err => {
      if (thisGen === generation) pending = null
      throw err
    })
  return pending
}

export function invalidateSettingsCache() {
  generation += 1
  cache = null
  pending = null
}

// Convenience: get a single typed value with a fallback.
export async function getSetting(db, key, fallback = null) {
  const all = await getSettings(db)
  // `in` walks the prototype chain — a setting whose key collides with a
  // prototype property (toString, __proto__, …) would silently resolve to
  // Object.prototype instead of the fallback. Check OWN properties only.
  return Object.prototype.hasOwnProperty.call(all, key) ? all[key] : fallback
}
