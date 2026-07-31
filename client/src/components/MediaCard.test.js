import { describe, it, expect } from 'vitest'
import { fallbackIndex } from './MediaCard.jsx'

// Regression coverage for the jellyfin-web-parity fallback: an item with no
// artwork at all gets one of 5 fixed colours (--card-fallback-1..5), cycled
// by id rather than sampled from anything.
describe('fallbackIndex', () => {
  it('always returns 1..5', () => {
    const ids = ['a', 'movie-1', 'e4f9c3d2-aaaa-bbbb-cccc-000000000001', '', 'ZZZZZZZZZZ']
    for (const id of ids) {
      const i = fallbackIndex(id)
      expect(i).toBeGreaterThanOrEqual(1)
      expect(i).toBeLessThanOrEqual(5)
    }
  })

  it('is deterministic for the same id', () => {
    const id = 'e4f9c3d2-aaaa-bbbb-cccc-000000000001'
    expect(fallbackIndex(id)).toBe(fallbackIndex(id))
  })

  it('spreads across the range rather than collapsing to one bucket', () => {
    const seen = new Set()
    for (let i = 0; i < 200; i++) seen.add(fallbackIndex(`item-${i}`))
    // Not asserting a specific distribution, just that it isn't degenerate.
    expect(seen.size).toBeGreaterThan(2)
  })
})
