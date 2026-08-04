import { describe, it, expect, vi } from 'vitest'
import {
  getAllowedLibraryIds,
  canAccessLibrary,
  canAccessMediaItem,
  canAccessEpisode,
  libraryFilterCondition,
} from '../src/services/libraryAccess.js'

function fakeDb(queryImpl) {
  return { query: vi.fn(queryImpl) }
}

describe('getAllowedLibraryIds', () => {
  it('returns null (unrestricted) for admins without querying the DB', async () => {
    const db = fakeDb(() => { throw new Error('should not be called') })
    const result = await getAllowedLibraryIds(db, { sub: 'u1', role: 'admin' })
    expect(result).toBeNull()
  })

  it('returns null when a viewer has zero access rows (backward-compatible default)', async () => {
    const db = fakeDb(() => ({ rows: [] }))
    const result = await getAllowedLibraryIds(db, { sub: 'u1', role: 'viewer' })
    expect(result).toBeNull()
  })

  it('returns the restricted set when a viewer has access rows', async () => {
    const db = fakeDb(() => ({ rows: [{ library_id: 'lib-1' }, { library_id: 'lib-2' }] }))
    const result = await getAllowedLibraryIds(db, { sub: 'u1', role: 'viewer' })
    expect(result).toEqual(new Set(['lib-1', 'lib-2']))
  })
})

describe('canAccessLibrary', () => {
  it('allows any library when unrestricted', async () => {
    const db = fakeDb(() => ({ rows: [] }))
    expect(await canAccessLibrary(db, { sub: 'u1', role: 'viewer' }, 'lib-1')).toBe(true)
  })

  it('denies a library not in the restricted set', async () => {
    const db = fakeDb(() => ({ rows: [{ library_id: 'lib-1' }] }))
    expect(await canAccessLibrary(db, { sub: 'u1', role: 'viewer' }, 'lib-2')).toBe(false)
  })

  it('allows a library in the restricted set', async () => {
    const db = fakeDb(() => ({ rows: [{ library_id: 'lib-1' }] }))
    expect(await canAccessLibrary(db, { sub: 'u1', role: 'viewer' }, 'lib-1')).toBe(true)
  })
})

describe('canAccessMediaItem', () => {
  it('denies when the item belongs to a non-allowed library', async () => {
    const db = fakeDb((sql) => {
      if (sql.includes('user_library_access')) return { rows: [{ library_id: 'lib-1' }] }
      if (sql.includes('media_items')) return { rows: [{ library_id: 'lib-2' }] }
      throw new Error('unexpected query: ' + sql)
    })
    expect(await canAccessMediaItem(db, { sub: 'u1', role: 'viewer' }, 'item-1')).toBe(false)
  })

  it('denies (rather than throws) when the item does not exist', async () => {
    const db = fakeDb((sql) => {
      if (sql.includes('user_library_access')) return { rows: [{ library_id: 'lib-1' }] }
      if (sql.includes('media_items')) return { rows: [] }
      throw new Error('unexpected query: ' + sql)
    })
    expect(await canAccessMediaItem(db, { sub: 'u1', role: 'viewer' }, 'missing')).toBe(false)
  })
})

describe('canAccessEpisode', () => {
  it('resolves through the parent series to its library', async () => {
    const db = fakeDb((sql) => {
      if (sql.includes('user_library_access')) return { rows: [{ library_id: 'lib-1' }] }
      if (sql.includes('episodes')) return { rows: [{ library_id: 'lib-1' }] }
      throw new Error('unexpected query: ' + sql)
    })
    const episodeId = '11111111-2222-3333-4444-555555555555'
    expect(await canAccessEpisode(db, { sub: 'u1', role: 'viewer' }, episodeId)).toBe(true)
  })

  it('denies (rather than throws) when the episode id is malformed', async () => {
    const db = fakeDb((sql) => {
      if (sql.includes('user_library_access')) return { rows: [{ library_id: 'lib-1' }] }
      if (sql.includes('episodes')) return { rows: [{ library_id: 'lib-1' }] }
      throw new Error('unexpected query: ' + sql)
    })
    expect(await canAccessEpisode(db, { sub: 'u1', role: 'viewer' }, 'ep-1')).toBe(false)
  })
})

describe('libraryFilterCondition', () => {
  it('returns an empty condition and does not touch params when unrestricted', async () => {
    const db = fakeDb(() => ({ rows: [] }))
    const params = ['existing-param']
    const cond = await libraryFilterCondition(db, { sub: 'u1', role: 'viewer' }, params, 'm.library_id')
    expect(cond).toBe('')
    expect(params).toEqual(['existing-param'])
  })

  it('appends the allowed-ids array and returns a positional ANY() condition', async () => {
    const db = fakeDb(() => ({ rows: [{ library_id: 'lib-1' }] }))
    const params = ['existing-param']
    const cond = await libraryFilterCondition(db, { sub: 'u1', role: 'viewer' }, params, 'm.library_id')
    expect(cond).toBe('m.library_id = ANY($2)')
    expect(params[1]).toEqual(['lib-1'])
  })
})
