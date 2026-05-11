// Person detail + filmography. Person identity is the TMDB person id that
// the scanner stored in each media item's metadata->cast array.
export default async function peopleRoutes(app) {
  app.addHook('preHandler', app.authenticate)

  app.get('/:tmdbId', async (request, reply) => {
    const { tmdbId } = request.params

    // Anchor: find one cast entry for this person to pull display info from.
    const personQ = await app.db.query(
      `SELECT cast_member->>'name'        AS name,
              cast_member->>'profile_url' AS profile_url
       FROM media_items, jsonb_array_elements(metadata->'cast') AS cast_member
       WHERE cast_member->>'id' = $1
       LIMIT 1`,
      [tmdbId]
    )
    if (!personQ.rows.length) return reply.code(404).send({ error: 'Person not found' })

    // Filmography: every media item where this person id appears in the cast.
    const filmQ = await app.db.query(
      `SELECT m.id, m.type, m.title, m.year, m.poster_url, m.rating,
              cast_member->>'character' AS character
       FROM media_items m, jsonb_array_elements(m.metadata->'cast') AS cast_member
       WHERE cast_member->>'id' = $1
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
