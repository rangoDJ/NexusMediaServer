// Regression coverage for a bug where the reconciliation pass called
// GET /session/:id on the transcoder, but that route never existed (only
// /:id/status, /:id/metrics, etc.) — every call 404'd, which caused every
// genuinely active stream to be marked 'error' on every server startup and
// every 24h. Asserts the request now hits the real /status endpoint.
import { describe, it, expect, vi, beforeEach } from 'vitest'

const getMock = vi.fn()
vi.mock('axios', () => ({ default: { get: (...args) => getMock(...args) } }))

beforeEach(() => { getMock.mockReset() })

describe('cleanupSessionsTask reconciliation pass', () => {
  it('polls the real /session/:id/status endpoint, not /session/:id', async () => {
    const { cleanupSessionsTask } = await import('../src/tasks/cleanupSessions.js')

    let call = 0
    const db = {
      query: vi.fn((sql) => {
        call++
        if (sql.includes("SET status = 'done'")) return { rowCount: 0 }
        if (sql.includes('FROM transcode_sessions')) {
          return {
            rows: [{
              id: 'sess-1',
              remote_session_id: 'remote-1',
              node_url: 'http://transcoder:3001',
            }],
          }
        }
        return { rowCount: 0, rows: [] }
      }),
    }
    getMock.mockResolvedValue({ status: 200, data: {} })

    const log = { info: vi.fn(), warn: vi.fn(), debug: vi.fn() }
    await cleanupSessionsTask.execute({ db, log, signal: { aborted: false }, progress: vi.fn() })

    expect(getMock).toHaveBeenCalledTimes(1)
    const [url] = getMock.mock.calls[0]
    expect(url).toBe('http://transcoder:3001/session/remote-1/status')
  })
})
