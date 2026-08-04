import { libraryFilterCondition } from '../services/libraryAccess.js'

export default async function collectionRoutes(app) {
  app.addHook('preHandler', app.authenticate)

  // List all collections that have at least one movie the caller can access
  app.get('/', async (request) => {
    const params = []
    const libCond = await libraryFilterCondition(app.db, request.user, params, 'm.library_id')
    const { rows } = await app.db.query(`
      SELECT c.id, c.tmdb_id, c.name, c.poster_url, c.backdrop_url,
             COUNT(m.id)::int AS movie_count
      FROM collections c
      JOIN media_items m ON m.collection_id = c.id
      ${libCond ? `WHERE ${libCond}` : ''}
      GROUP BY c.id
      ORDER BY c.name
    `, params)
    return rows
  })

  // Get a single collection with its movies (both scoped to accessible libraries)
  app.get('/:id', async (request, reply) => {
    const params = [request.params.id]
    const colCond = await libraryFilterCondition(app.db, request.user, params, 'm.library_id')
    const { rows: colRows } = await app.db.query(`
      SELECT DISTINCT c.id, c.tmdb_id, c.name, c.overview, c.poster_url, c.backdrop_url
      FROM collections c
      JOIN media_items m ON m.collection_id = c.id
      WHERE c.id = $1 AND m.type = 'movie'
        ${colCond ? `AND ${colCond}` : ''}
    `, params)
    if (!colRows.length) return reply.code(404).send({ error: 'Collection not found' })

    const movieParams = [request.params.id]
    const movieCond = await libraryFilterCondition(app.db, request.user, movieParams, 'library_id')
    const { rows: movies } = await app.db.query(`
      SELECT id, title, year, poster_url, rating, duration_secs, genres
      FROM media_items
      WHERE collection_id = $1 AND type = 'movie'
        ${movieCond ? `AND ${movieCond}` : ''}
      ORDER BY year NULLS LAST, sort_title NULLS LAST, title
    `, movieParams)

    return { ...colRows[0], movies }
  })
}
