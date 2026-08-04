/**
 * Server activity/audit trail — Jellyfin-style: a small, high-signal feed
 * (logins, scans, plugin changes, user changes, failed tasks), not a mirror
 * of the application log. Fire-and-forget by design, same pattern already
 * used for play_sessions inserts elsewhere — a failure to record an activity
 * line must never break the action it's describing.
 *
 * @param {import('pg').Pool}                   db
 * @param {import('fastify').FastifyBaseLogger} log
 * @param {object} entry
 * @param {string}  entry.type      e.g. 'auth.login', 'scan.complete'
 * @param {string}  entry.message   pre-rendered human-readable line
 * @param {'info'|'warning'|'error'} [entry.severity]
 * @param {string|null} [entry.userId]
 * @param {object|null} [entry.details]
 */
export function logActivity(db, log, { type, message, severity = 'info', userId = null, details = null }) {
  // JSON.stringify on details can throw synchronously (circular refs) — and
  // this is called fire-and-forget, so a throw here escapes into the caller's
  // async context. Never let activity recording break the action it describes.
  let serialized = null
  try {
    serialized = details ? JSON.stringify(details) : null
  } catch {
    log?.warn('[activity] Failed to serialise activity details — recording without them')
    serialized = null
  }
  db.query(
    'INSERT INTO activity_log(type, severity, message, user_id, details) VALUES($1,$2,$3,$4,$5)',
    [type, severity, message, userId, serialized]
  ).catch(err => log.warn({ err }, '[activity] Failed to record activity'))
}
