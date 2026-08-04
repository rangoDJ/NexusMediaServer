import { libraryFilterCondition } from '../services/libraryAccess.js'

// Unified search across movies, series, episodes, and people.
// People are extracted from the metadata->cast JSONB array on each media item.
export default async function searchRoutes(app) {
  app.addHook('preHandler', app.authenticate)

  app.get('/', async (request) => {
    const q = (request.query.q ?? '').trim()
    if (q.length < 2) return { movies: [], series: [], episodes: [], people: [] }

    // Escape LIKE special characters so a search for "50%" or "file_name"
    // matches literally instead of "everything" or "any single character".
    // Using '!' as the escape char avoids backslash/standard_conforming_strings
    // ambiguity in PostgreSQL.
    const escaped = q.replace(/[!%_]/g, '!$&')
    const pattern = `%${escaped}%`

    // Movies + series share the media_items table; split by type after the fetch.
    const mediaParams = [pattern]
    const mediaLibCond = await libraryFilterCondition(app.db, request.user, mediaParams, 'library_id')
    const mediaQ = await app.db.query(
      `SELECT id, type, title, year, poster_url, rating, duration_secs, genres, dominant_color, blurhash
       FROM media_items
       WHERE title ILIKE $1 ESCAPE '!'
         ${mediaLibCond ? `AND ${mediaLibCond}` : ''}
       ORDER BY type, sort_title NULLS LAST, title
       LIMIT 60`,
      mediaParams
    )
    const movies = mediaQ.rows.filter(r => r.type === 'movie')
    const series = mediaQ.rows.filter(r => r.type === 'series')

    const epParams = [pattern]
    const epLibCond = await libraryFilterCondition(app.db, request.user, epParams, 'm.library_id')
    const epQ = await app.db.query(
      `SELECT e.id, e.season_number, e.episode_number, e.title,
              m.id AS series_id, m.title AS series_title, m.poster_url
       FROM episodes e
       JOIN media_items m ON m.id = e.series_id
       WHERE e.title ILIKE $1 ESCAPE '!'
         ${epLibCond ? `AND ${epLibCond}` : ''}
       ORDER BY m.title, e.season_number, e.episode_number
       LIMIT 30`,
      epParams
    )

    // People — backed by the media_cast index table (kept in sync via trigger).
    // Trigram GIN index on name makes this fast even for libraries with
    // tens of thousands of items. Scoped to accessible libraries so search
    // can't reveal people tied only to restricted content.
    const peopleParams = [pattern]
    const peopleLibCond = await libraryFilterCondition(app.db, request.user, peopleParams, 'm.library_id')
    const peopleQ = await app.db.query(
      `SELECT DISTINCT ON (mc.person_id)
              mc.person_id AS id,
              mc.name,
              mc.profile_url
       FROM media_cast mc
       JOIN media_items m ON m.id = mc.media_item_id
       WHERE mc.name ILIKE $1 ESCAPE '!'
         ${peopleLibCond ? `AND ${peopleLibCond}` : ''}
       ORDER BY mc.person_id, mc.name
       LIMIT 30`,
      peopleParams
    )

    return { movies, series, episodes: epQ.rows, people: peopleQ.rows }
  })
}
