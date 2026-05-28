import axios from 'axios'
import { pickTranscoder } from './transcoderPool.js'

// Cache the selected transcoder node for up to 60 seconds so bulk callers
// (the scanner, trickplay task, intro task) don't issue a fresh SELECT per file.
// The health poller refreshes last_seen_at every 30 s, so a 60 s TTL is safe.
let _cachedNode   = null
let _cacheExpiry  = 0

async function resolveNode(db) {
  if (_cachedNode && Date.now() < _cacheExpiry) return _cachedNode
  _cachedNode  = await pickTranscoder(db)
  _cacheExpiry = Date.now() + 60_000
  return _cachedNode
}

// Ask a transcoder node to ffprobe a file and return its technical metadata.
// Returns null if no transcoder is reachable or the file can't be probed.
export async function probeFile(db, filePath) {
  const node = await resolveNode(db)
  if (!node) return null

  try {
    const { data } = await axios.post(
      `${node.url}/probe`,
      { file_path: filePath },
      { headers: { 'x-transcoder-secret': process.env.TRANSCODER_SECRET }, timeout: 15_000 }
    )
    return data
  } catch {
    // Probe failed — invalidate the cache so the next call re-selects a node
    // in case this one just went down.
    _cachedNode = null
    return null
  }
}

/** Force-expire the node cache (e.g. after a scan finishes). */
export function invalidateProbeCache() {
  _cachedNode  = null
  _cacheExpiry = 0
}
