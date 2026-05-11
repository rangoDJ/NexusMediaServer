// Unified search across movies, series, episodes, and people.
// People are extracted from the metadata->cast JSONB array on each media item.
export default async function searchRoutes(app) {
  app.addHook('preHandler', app.authenticate)

  app.get('/', async (request) => {
    const q = (request.query.q ?? '').trim()
    if (q.length < 2) return { movies: [], series: [], episodes: [], people: [] }

    const pattern = `%${q}%`

    // Movies + series share the media_items table; split by type after the fetch.
    const mediaQ = await app.db.query(
      `SELECT id, type, title, year, poster_url, rating, duration_secs, genres
       FROM media_items
       WHERE title ILIKE $1
       ORDER BY type, sort_title NULLS LAST, title
       LIMIT 60`,
      [pattern]
    )
    const movies = mediaQ.rows.filter(r => r.type === 'movie')
    const series = mediaQ.rows.filter(r => r.type === 'series')

    const epQ = await app.db.query(
      `SELECT e.id, e.season_number, e.episode_number, e.title,
              m.id AS series_id, m.title AS series_title, m.poster_url
       FROM episodes e
       JOIN media_items m ON m.id = e.series_id
       WHERE e.title ILIKE $1
       ORDER BY m.title, e.season_number, e.episode_number
       LIMIT 30`,
      [pattern]
    )

    // People — flatten metadata->cast and de-duplicate by TMDB person id.
    // Pick one profile_url per person (any one is fine).
    const peopleQ = await app.db.query(
      `SELECT DISTINCT ON (cast_member->>'id')
              cast_member->>'id'          AS id,
              cast_member->>'name'        AS name,
              cast_member->>'profile_url' AS profile_url
       FROM media_items, jsonb_array_elements(metadata->'cast') AS cast_member
       WHERE cast_member->>'name' ILIKE $1
         AND cast_member->>'id' IS NOT NULL
       ORDER BY cast_member->>'id'
       LIMIT 30`,
      [pattern]
    )

    return { movies, series, episodes: epQ.rows, people: peopleQ.rows }
  })
}
