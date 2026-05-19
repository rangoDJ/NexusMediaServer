import { readFile } from 'fs/promises'
import { XMLParser } from 'fast-xml-parser'

const parser = new XMLParser({ ignoreAttributes: false, parseAttributeValue: true })

/**
 * Parse an NFO and return ONLY fields that have a value. Missing fields are
 * omitted entirely (not set to null) so that {...tmdb, ...nfo} merges don't
 * clobber TMDB's good data with NFO's missing data. This was a real bug:
 * an NFO without a <plot> tag would null out the TMDB plot, poster, etc.
 */
export async function parseNfo(nfoPath) {
  try {
    const xml = await readFile(nfoPath, 'utf8')
    const doc = parser.parse(xml)
    const root = doc.movie ?? doc.tvshow ?? doc.episodedetails ?? {}

    const out = {}
    if (root.title)     out.title      = root.title
    if (root.sorttitle) out.sort_title = root.sorttitle
    if (root.year)      out.year       = parseInt(root.year)
    if (root.plot)      out.plot       = root.plot
    if (root.tagline)   out.tagline    = root.tagline
    if (root.rating)    out.rating     = parseFloat(root.rating)
    if (root.tmdbid)    out.tmdb_id    = String(root.tmdbid)
    const imdb = root.imdbid ?? (typeof root.uniqueid === 'string' ? root.uniqueid : null)
    if (imdb)           out.imdb_id    = imdb
    if (root.genre) {
      out.genres = Array.isArray(root.genre) ? root.genre : [root.genre]
    }
    if (root.lockdata)  out.skipTmdb   = true
    return out
  } catch {
    return {}
  }
}
