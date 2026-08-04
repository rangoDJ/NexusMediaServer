import axios from 'axios'

const IMAGE_BASE = 'https://image.tmdb.org/t/p'

function client(apiKey) {
  return axios.create({
    baseURL: 'https://api.themoviedb.org/3',
    // A hung upstream must never block a media scan / task forever — axing the
    // default timeout:0 (no timeout) so slow TMDB responses fail cleanly and
    // the scanner can fall back to NFO/local metadata.
    timeout: 10_000,
    params: { api_key: apiKey, language: 'en' },
  })
}

export async function fetchMovieMetadata(title, year, { apiKey, language = 'en' } = {}) {
  const key = apiKey || process.env.TMDB_API_KEY
  if (!key) return {}
  const tmdb = client(key)
  tmdb.defaults.params.language = language

  const { data: search } = await tmdb.get('/search/movie', {
    params: { query: title, year: year ?? undefined, include_adult: false }
  })
  const result = search.results[0]
  if (!result) return {}

  const [{ data: detail }, { data: credits }] = await Promise.all([
    tmdb.get(`/movie/${result.id}`),
    tmdb.get(`/movie/${result.id}/credits`),
  ])

  const director = credits.crew?.find(c => c.job === 'Director')?.name ?? null
  const writer   = credits.crew?.find(c => c.job === 'Screenplay' || c.job === 'Writer' || c.job === 'Story')?.name ?? null
  const cast     = (credits.cast ?? []).slice(0, 20).map(c => ({
    id:          c.id,
    name:        c.name,
    character:   c.character ?? null,
    profile_url: c.profile_path ? `${IMAGE_BASE}/w185${c.profile_path}` : null,
  }))

  const col = detail.belongs_to_collection
  return {
    tmdb_id:      String(detail.id),
    imdb_id:      detail.imdb_id ?? null,
    title:        detail.title,
    sort_title:   detail.title,
    year:         detail.release_date ? parseInt(detail.release_date.slice(0, 4)) : null,
    plot:         detail.overview ?? null,
    tagline:      detail.tagline ?? null,
    rating:       detail.vote_average ?? null,
    genres:       detail.genres?.map(g => g.name) ?? null,
    studios:      detail.production_companies?.map(c => c.name) ?? null,
    poster_url:   detail.poster_path   ? `${IMAGE_BASE}/w500${detail.poster_path}`   : null,
    backdrop_url: detail.backdrop_path ? `${IMAGE_BASE}/w1280${detail.backdrop_path}` : null,
    director,
    writer,
    cast,
    collection: col ? {
      tmdb_id:      String(col.id),
      name:         col.name,
      poster_url:   col.poster_path   ? `${IMAGE_BASE}/w500${col.poster_path}`   : null,
      backdrop_url: col.backdrop_path ? `${IMAGE_BASE}/w1280${col.backdrop_path}` : null,
    } : null,
  }
}

/**
 * Direct lookup by TMDB id — used by the refresh task so we don't waste an
 * API call on /search and risk getting a different result for ambiguous titles.
 */
export async function fetchMovieById(tmdbId, { apiKey, language = 'en' } = {}) {
  const key = apiKey || process.env.TMDB_API_KEY
  if (!key || !tmdbId) return {}
  const tmdb = client(key)
  tmdb.defaults.params.language = language

  const [{ data: detail }, { data: credits }] = await Promise.all([
    tmdb.get(`/movie/${tmdbId}`),
    tmdb.get(`/movie/${tmdbId}/credits`),
  ])

  const director = credits.crew?.find(c => c.job === 'Director')?.name ?? null
  const writer   = credits.crew?.find(c => c.job === 'Screenplay' || c.job === 'Writer' || c.job === 'Story')?.name ?? null
  const cast     = (credits.cast ?? []).slice(0, 20).map(c => ({
    id: c.id, name: c.name, character: c.character ?? null,
    profile_url: c.profile_path ? `${IMAGE_BASE}/w185${c.profile_path}` : null,
  }))

  const col = detail.belongs_to_collection
  return {
    tmdb_id:      String(detail.id),
    imdb_id:      detail.imdb_id ?? null,
    title:        detail.title,
    sort_title:   detail.title,
    year:         detail.release_date ? parseInt(detail.release_date.slice(0, 4)) : null,
    plot:         detail.overview ?? null,
    tagline:      detail.tagline ?? null,
    rating:       detail.vote_average ?? null,
    genres:       detail.genres?.map(g => g.name) ?? null,
    studios:      detail.production_companies?.map(c => c.name) ?? null,
    poster_url:   detail.poster_path   ? `${IMAGE_BASE}/w500${detail.poster_path}`   : null,
    backdrop_url: detail.backdrop_path ? `${IMAGE_BASE}/w1280${detail.backdrop_path}` : null,
    director, writer, cast,
    collection: col ? {
      tmdb_id:      String(col.id),
      name:         col.name,
      poster_url:   col.poster_path   ? `${IMAGE_BASE}/w500${col.poster_path}`   : null,
      backdrop_url: col.backdrop_path ? `${IMAGE_BASE}/w1280${col.backdrop_path}` : null,
    } : null,
  }
}

export async function fetchSeriesById(tmdbId, { apiKey, language = 'en' } = {}) {
  const key = apiKey || process.env.TMDB_API_KEY
  if (!key || !tmdbId) return {}
  const tmdb = client(key)
  tmdb.defaults.params.language = language

  const { data: detail } = await tmdb.get(`/tv/${tmdbId}`)
  return {
    tmdb_id: String(detail.id),
    title: detail.name,
    sort_title: detail.name,
    year: detail.first_air_date ? parseInt(detail.first_air_date.slice(0, 4)) : null,
    plot: detail.overview ?? null,
    rating: detail.vote_average ?? null,
    genres: detail.genres?.map(g => g.name) ?? null,
    poster_url: detail.poster_path ? `${IMAGE_BASE}/w500${detail.poster_path}` : null,
    backdrop_url: detail.backdrop_path ? `${IMAGE_BASE}/w1280${detail.backdrop_path}` : null,
  }
}

/**
 * Search TMDB for alternative matches — used by the manual re-identification feature.
 * type: 'movie' | 'tv'
 */
export async function searchTmdb(query, type = 'movie', { apiKey, language = 'en' } = {}) {
  const key = apiKey || process.env.TMDB_API_KEY
  if (!key) return []
  const tmdb = client(key)
  tmdb.defaults.params.language = language

  const endpoint = type === 'tv' ? '/search/tv' : '/search/movie'
  const { data } = await tmdb.get(endpoint, { params: { query, include_adult: false } })
  return (data.results ?? []).slice(0, 10).map(r => ({
    tmdb_id:   String(r.id),
    title:     r.title ?? r.name,
    year:      (r.release_date ?? r.first_air_date)?.slice(0, 4) ?? null,
    poster_url: r.poster_path ? `${IMAGE_BASE}/w342${r.poster_path}` : null,
    rating:    r.vote_average ?? null,
    overview:  r.overview ?? null,
  }))
}

export async function fetchSeriesMetadata(title, { apiKey, language = 'en' } = {}) {
  const key = apiKey || process.env.TMDB_API_KEY
  if (!key) return {}
  const tmdb = client(key)
  tmdb.defaults.params.language = language

  const { data: search } = await tmdb.get('/search/tv', { params: { query: title } })
  const result = search.results[0]
  if (!result) return {}

  const { data: detail } = await tmdb.get(`/tv/${result.id}`)
  return {
    tmdb_id: String(detail.id),
    title: detail.name,
    sort_title: detail.name,
    year: detail.first_air_date ? parseInt(detail.first_air_date.slice(0, 4)) : null,
    plot: detail.overview ?? null,
    rating: detail.vote_average ?? null,
    genres: detail.genres?.map(g => g.name) ?? null,
    poster_url: detail.poster_path ? `${IMAGE_BASE}/w500${detail.poster_path}` : null,
    backdrop_url: detail.backdrop_path ? `${IMAGE_BASE}/w1280${detail.backdrop_path}` : null,
  }
}
