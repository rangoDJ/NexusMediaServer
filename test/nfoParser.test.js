import { describe, it, expect } from 'vitest'
import { mkdtemp, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { parseNfo } from '../src/services/nfoParser.js'

async function tempNfo(xml) {
  const dir = await mkdtemp(join(tmpdir(), 'nfo-test-'))
  const p = join(dir, 'movie.nfo')
  await writeFile(p, xml, 'utf8')
  return p
}

describe('parseNfo', () => {
  it('parses a normal NFO', async () => {
    const p = await tempNfo('<?xml version="1.0"?><movie><title>The Matrix</title><year>1999</year><plot>Story</plot><genre>Sci-Fi</genre><tmdbid>603</tmdbid></movie>')
    const out = await parseNfo(p)
    expect(out.title).toBe('The Matrix')
    expect(out.year).toBe(1999)
    expect(out.genres).toEqual(['Sci-Fi'])
    expect(out.tmdb_id).toBe('603')
  })

  it('caps oversized source files without throwing', async () => {
    const big = '<movie>' + '<plot>' + 'a'.repeat(3 * 1024 * 1024) + '</plot>' + '</movie>'
    const p = await tempNfo(big)
    const out = await parseNfo(p)
    expect(out).toEqual({})
  })

  it('truncates absurdly long string fields to MAX_FIELD_CHARS', async () => {
    const long = 'x'.repeat(200 * 1024)
    const p = await tempNfo(`<movie><title>${long}</title></movie>`)
    const out = await parseNfo(p)
    expect(out.title.length).toBeLessThanOrEqual(64 * 1024)
    expect(out.title).toMatch(/^x+/)
  })

  it('rejects an object/array genre rather than leaking it', async () => {
    const p = await tempNfo('<movie><genre><a>1</a><b>2</b></genre></movie>')
    const out = await parseNfo(p)
    expect(Array.isArray(out.genres)).toBe(true)
    for (const g of out.genres ?? []) expect(typeof g).toBe('string')
  })

  it('returns {} for unreadable/missing files', async () => {
    expect(await parseNfo(join(tmpdir(), 'does-not-exist.nfo'))).toEqual({})
  })
})