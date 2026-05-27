export default async function collectionRoutes(app) {
  app.addHook('preHandler', app.authenticate)

  // List all collections that have at least one movie
  app.get('/', async () => {
    const { rows } = await app.db.query(`
      SELECT c.id, c.tmdb_id, c.name, c.poster_url, c.backdrop_url,
             COUNT(m.id)::int AS movie_count
      FROM collections c
      JOIN media_items m ON m.collection_id = c.id
      GROUP BY c.id
      ORDER BY c.name
    `)
    return rows
  })

  // Get a single collection with its movies
  app.get('/:id', async (request, reply) => {
    const { rows: colRows } = await app.db.query(
      'SELECT id, tmdb_id, name, overview, poster_url, backdrop_url FROM collections WHERE id=$1',
      [request.params.id]
    )
    if (!colRows.length) return reply.code(404).send({ error: 'Collection not found' })

    const { rows: movies } = await app.db.query(`
      SELECT id, title, year, poster_url, rating, duration_secs, genres
      FROM media_items
      WHERE collection_id = $1 AND type = 'movie'
      ORDER BY year NULLS LAST, sort_title NULLS LAST, title
    `, [request.params.id])

    return { ...colRows[0], movies }
  })
}
