/**
 * Per-user library access control.
 *
 * A user with zero rows in user_library_access can see every library
 * (backward-compatible default). Once an admin restricts a user, only the
 * listed libraries are visible/streamable to them. Admins are always
 * unrestricted regardless of this table.
 */

/**
 * @returns {Promise<Set<string>|null>} null = unrestricted (sees everything),
 *   otherwise the set of library ids the user may access.
 */
export async function getAllowedLibraryIds(db, user) {
  if (!user || user.role === 'admin') return null
  const { rows } = await db.query(
    'SELECT library_id FROM user_library_access WHERE user_id=$1',
    [user.sub ?? user.id]
  )
  if (!rows.length) return null
  return new Set(rows.map(r => r.library_id))
}

/** @returns {Promise<boolean>} */
export async function canAccessLibrary(db, user, libraryId) {
  if (!libraryId) return true
  const allowed = await getAllowedLibraryIds(db, user)
  return allowed === null || allowed.has(libraryId)
}

/** Looks up a media item's library and checks access. */
export async function canAccessMediaItem(db, user, mediaItemId) {
  const allowed = await getAllowedLibraryIds(db, user)
  if (allowed === null) return true
  const { rows } = await db.query('SELECT library_id FROM media_items WHERE id=$1', [mediaItemId])
  if (!rows.length) return false
  return allowed.has(rows[0].library_id)
}

/**
 * Appends an allowed-library-ids array to `params` and returns a SQL
 * condition string (`"col = ANY($n)"`) to AND into a WHERE clause, or ''
 * when the user is unrestricted. Caller is responsible for combining it
 * with other conditions (AND / WHERE).
 */
export async function libraryFilterCondition(db, user, params, column) {
  const allowed = await getAllowedLibraryIds(db, user)
  if (allowed === null) return ''
  params.push([...allowed])
  return `${column} = ANY($${params.length})`
}

/** Looks up an episode's parent series' library and checks access. */
export async function canAccessEpisode(db, user, episodeId) {
  const allowed = await getAllowedLibraryIds(db, user)
  if (allowed === null) return true
  const { rows } = await db.query(`
    SELECT m.library_id FROM episodes e
    JOIN media_items m ON m.id = e.series_id
    WHERE e.id=$1
  `, [episodeId])
  if (!rows.length) return false
  return allowed.has(rows[0].library_id)
}
