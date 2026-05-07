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

  const { data: detail } = await tmdb.get(`/movie/${result.id}`)
  return {
    tmdb_id: String(detail.id),
    imdb_id: detail.imdb_id ?? null,
    title: detail.title,
    sort_title: detail.title,
    year: detail.release_date ? parseInt(detail.release_date.slice(0, 4)) : null,
    plot: detail.overview ?? null,
    tagline: detail.tagline ?? null,
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
