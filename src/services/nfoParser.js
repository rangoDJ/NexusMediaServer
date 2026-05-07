import { readFile } from 'fs/promises'
import { XMLParser } from 'fast-xml-parser'

const parser = new XMLParser({ ignoreAttributes: false, parseAttributeValue: true })

export async function parseNfo(nfoPath) {
  try {
    const xml = await readFile(nfoPath, 'utf8')
    const doc = parser.parse(xml)
    const root = doc.movie ?? doc.tvshow ?? doc.episodedetails ?? {}

    return {
      title: root.title ?? null,
      sort_title: root.sorttitle ?? null,
      year: root.year ? parseInt(root.year) : null,
      plot: root.plot ?? null,
      tagline: root.tagline ?? null,
      rating: root.rating ? parseFloat(root.rating) : null,
      tmdb_id: root.tmdbid ? String(root.tmdbid) : null,
      imdb_id: root.imdbid ?? (typeof root.uniqueid === 'string' ? root.uniqueid : null),
      genres: root.genre
        ? (Array.isArray(root.genre) ? root.genre : [root.genre])
        : null,
      skipTmdb: !!root.lockdata,
    }
  } catch {
    return {}
  }
}
