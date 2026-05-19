import axios from 'axios'

const IMAGE_BASE = 'https://image.tmdb.org/t/p'

function client(apiKey) {
  return axios.create({
    baseURL: 'https://api.themoviedb.org/3',
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
