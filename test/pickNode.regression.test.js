// Regression coverage for a bug where both tasks queried a nonexistent
// `current_sessions` column (the real column is `active_sessions`), which
// threw a Postgres error on every run and silently disabled trickplay
// generation and intro detection. Since a real Postgres error can't happen
// against a mock, we instead assert on the captured SQL text.
import { describe, it, expect, vi } from 'vitest'

async function captureNodeQuery(taskModulePath) {
  vi.resetModules()
  vi.doMock('axios', () => ({ default: { post: vi.fn().mockResolvedValue({ data: {} }) } }))

  const queries = []
  const db = {
    query: vi.fn((sql) => {
      queries.push(sql)
      if (sql.includes('FROM transcoder_nodes')) return { rows: [] } // no node → task exits early after this
      // Return one fake row for whatever "needs work" query runs first, so
      // each task actually proceeds far enough to call pickNode().
      if (sql.includes('FROM media_items') || sql.includes('FROM episodes')) {
        return { rows: [{ series_id: 's1', title: 't' }] }
      }
      return { rows: [] }
    }),
  }

  const mod = await import(taskModulePath)
  const task = Object.values(mod).find(v => v && typeof v.execute === 'function')
  const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
  await task.execute({ db, log, signal: { aborted: false }, progress: vi.fn() })

  return queries.find(q => q.includes('FROM transcoder_nodes'))
}

describe('transcoder node selection query', () => {
  it('generateTrickplay.js orders by the real active_sessions column', async () => {
    const nodeQuery = await captureNodeQuery('../src/tasks/generateTrickplay.js')
    expect(nodeQuery).toContain('active_sessions')
    expect(nodeQuery).not.toContain('current_sessions')
  })

  it('analyzeIntros.js orders by the real active_sessions column', async () => {
    const nodeQuery = await captureNodeQuery('../src/tasks/analyzeIntros.js')
    expect(nodeQuery).toContain('active_sessions')
    expect(nodeQuery).not.toContain('current_sessions')
  })
})
