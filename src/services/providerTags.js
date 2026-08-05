// Media managers (Radarr/Sonarr, Jellyfin, Kodi) commonly bake provider IDs
// into folder/file names for exact matching, e.g.:
//   "xXx State of the Union (2005) {tmdb-11679}"   (Radarr default)
//   "Superman (2025) [tmdbid-197]"                 (Jellyfin/Kodi style)
//   "Clueless (1996) {tvdb-70595}"                 (Sonarr default — TV
//     libraries are commonly tagged with TheTVDB's id, not TMDB's)
// Without this, that literal tag ends up as part of the title (since it's
// just "whatever's left after the year" to a naive filename guesser), and
// worse, pollutes any TMDB title search enough to fail entirely.
const TAG_RE = /[{[](tmdbid|tmdb|imdbid|imdb|tvdbid|tvdb)[-=]([a-zA-Z0-9]+)[}\]]/gi

/**
 * @param {string} name
 * @returns {{ tmdbId: number|null, imdbId: string|null, tvdbId: number|null, cleanName: string }}
 */
export function parseProviderTags(name) {
  if (!name) return { tmdbId: null, imdbId: null, tvdbId: null, cleanName: name ?? '' }

  let tmdbId = null
  let imdbId = null
  let tvdbId = null
  const cleanName = name
    .replace(TAG_RE, (_match, key, value) => {
      const k = key.toLowerCase()
      if (k.startsWith('tmdb'))      tmdbId = parseInt(value, 10) || null
      else if (k.startsWith('tvdb')) tvdbId = parseInt(value, 10) || null
      else                           imdbId = value
      return ''
    })
    .replace(/\s{2,}/g, ' ')
    .trim()

  return { tmdbId, imdbId, tvdbId, cleanName }
}
