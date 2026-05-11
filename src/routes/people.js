// Person detail + filmography. Backed by the media_cast index table which
// is kept in sync via trigger — see migration 007_people_index.sql.
export default async function peopleRoutes(app) {
  app.addHook('preHandler', app.authenticate)

  app.get('/:tmdbId', async (request, reply) => {
    const { tmdbId } = request.params

    // Anchor: any cast row for this person gives us display info.
    const personQ = await app.db.query(
      `SELECT name, profile_url
       FROM media_cast
       WHERE person_id = $1
       LIMIT 1`,
      [tmdbId]
    )
    if (!personQ.rows.length) return reply.code(404).send({ error: 'Person not found' })

    const filmQ = await app.db.query(
      `SELECT m.id, m.type, m.title, m.year, m.poster_url, m.rating,
              mc.character
       FROM media_cast mc
       JOIN media_items m ON m.id = mc.media_item_id
       WHERE mc.person_id = $1
       ORDER BY m.year DESC NULLS LAST, m.title`,
      [tmdbId]
    )

    return {
      id: tmdbId,
      name: personQ.rows[0].name,
      profile_url: personQ.rows[0].profile_url,
      filmography: filmQ.rows,
    }
  })
}
