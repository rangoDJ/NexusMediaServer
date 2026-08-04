// Person detail + filmography. Backed by the media_cast index table which
// is kept in sync via trigger — see migration 007_people_index.sql.
import { libraryFilterCondition } from '../services/libraryAccess.js'

export default async function peopleRoutes(app) {
  app.addHook('preHandler', app.authenticate)

  app.get('/:tmdbId', async (request, reply) => {
    const { tmdbId } = request.params

    // Anchor + filmography are both scoped to libraries the caller can
    // access, so a restricted user can't enumerate people whose only roles
    // are in libraries they were denied.
    const anchorParams = [tmdbId]
    const anchorCond = await libraryFilterCondition(app.db, request.user, anchorParams, 'm.library_id')
    const personQ = await app.db.query(
      `SELECT mc.name, mc.profile_url
       FROM media_cast mc
       JOIN media_items m ON m.id = mc.media_item_id
       WHERE mc.person_id = $1
         ${anchorCond ? `AND ${anchorCond}` : ''}
       LIMIT 1`,
      anchorParams
    )
    if (!personQ.rows.length) return reply.code(404).send({ error: 'Person not found' })

    const filmParams = [tmdbId]
    const filmCond = await libraryFilterCondition(app.db, request.user, filmParams, 'm.library_id')
    const filmQ = await app.db.query(
      `SELECT m.id, m.type, m.title, m.year, m.poster_url, m.rating,
              mc.character
       FROM media_cast mc
       JOIN media_items m ON m.id = mc.media_item_id
       WHERE mc.person_id = $1
         ${filmCond ? `AND ${filmCond}` : ''}
       ORDER BY m.year DESC NULLS LAST, m.title`,
      filmParams
    )

    return {
      id: tmdbId,
      name: personQ.rows[0].name,
      profile_url: personQ.rows[0].profile_url,
      filmography: filmQ.rows,
    }
  })
}
