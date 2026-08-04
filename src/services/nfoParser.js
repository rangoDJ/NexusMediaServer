import { readFile, stat } from 'fs/promises'
import { XMLParser } from 'fast-xml-parser'

const parser = new XMLParser({ ignoreAttributes: false, parseAttributeValue: true })

// Hard limits so a malformed or malicious NFO can never exhaust memory or
// flood the DB with absurdly long string values.
const MAX_NFO_BYTES   = 2 * 1024 * 1024  // 2 MB source file
const MAX_FIELD_CHARS = 64 * 1024        // longest single field we accept
const MAX_GENRES      = 200

/** Coerce a parsed value into a safe string, or null if it isn't usable. */
function asString(value, max = MAX_FIELD_CHARS) {
  if (typeof value === 'string') value = value.trim()
  // fast-xml-parser's parseAttributeValue can turn text into numbers/booleans.
  if (typeof value !== 'string') value = String(value)
  if (value.length <= 0) return null
  return value.slice(0, max)
}

/** Coerce a numeric-ish value into a finite number, or null. */
function asNumber(value) {
  const n = Number(value)
  return Number.isFinite(n) ? n : null
}

/**
 * Parse an NFO and return ONLY fields that have a value. Missing fields are
 * omitted entirely (not set to null) so that {...tmdb, ...nfo} merges don't
 * clobber TMDB's good data with NFO's missing data. This was a real bug:
 * an NFO without a <plot> tag would null out the TMDB plot, poster, etc.
 */
export async function parseNfo(nfoPath) {
  try {
    // Refuse to read overly large files before allocating a buffer for them.
    const st = await stat(nfoPath)
    if (st.size > MAX_NFO_BYTES) return {}

    const xml = await readFile(nfoPath, 'utf8').catch(() => '')
    if (!xml || xml.length > MAX_NFO_BYTES) return {}

    const doc = parser.parse(xml)
    const root = doc.movie ?? doc.tvshow ?? doc.episodedetails ?? {}

    const out = {}
    const title = asString(root.title)
    if (title) out.title = title

    const sorttitle = asString(root.sorttitle)
    if (sorttitle) out.sort_title = sorttitle

    out.year = asNumber(parseInt(root.year, 10))
    if (out.year == null) delete out.year

    const plot = asString(root.plot)
    if (plot) out.plot = plot

    const tagline = asString(root.tagline)
    if (tagline) out.tagline = tagline

    out.rating = asNumber(root.rating)
    if (out.rating == null) delete out.rating

    const tmdbid = asString(root.tmdbid)
    if (tmdbid) out.tmdb_id = tmdbid

    const imdb = asString(root.imdbid ?? (typeof root.uniqueid === 'string' ? root.uniqueid : null))
    if (imdb) out.imdb_id = imdb

    const rawGenres = Array.isArray(root.genre) ? root.genre : [root.genre]
    const genres = rawGenres.map(g => asString(g)).filter(Boolean).slice(0, MAX_GENRES)
    if (genres.length) out.genres = genres

    if (root.lockdata) out.skipTmdb = true
    return out
  } catch {
    return {}
  }
}
