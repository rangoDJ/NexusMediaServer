/**
 * Intro detection via Chromaprint fingerprint cross-correlation.
 *
 * Strategy:
 *   1. Each episode's fingerprint is a sequence of 32-bit integers.
 *   2. We slide the shorter fingerprint over the longer one, counting matching
 *      bits at each offset (using popcount on XOR — lower XOR = more similar).
 *   3. A run of offsets with similarity above threshold identifies the window
 *      where both episodes share the same audio (= intro / credits).
 *   4. We intersect matches across all episode pairs in a season to find the
 *      common segment.
 */

const SIMILARITY_THRESHOLD = 0.65  // fraction of bits that must match
const MIN_INTRO_SECS       = 20    // ignore windows shorter than this
const MAX_INTRO_SECS       = 300   // don't mark windows longer than this

/**
 * Parse a raw Chromaprint fingerprint string into a Uint32Array.
 * fpcalc -raw returns comma-separated signed int32 values.
 */
export function parseFingerprint(raw) {
  const nums = raw.split(',').map(Number).filter(n => !isNaN(n))
  return new Int32Array(nums)
}

/**
 * Compute bit-similarity between two 32-bit integers.
 * Returns fraction of matching bits [0.0, 1.0].
 */
function bitSimilarity(a, b) {
  let xor = (a ^ b) >>> 0
  // Hamming weight (popcount)
  xor = xor - ((xor >>> 1) & 0x55555555)
  xor = (xor & 0x33333333) + ((xor >>> 2) & 0x33333333)
  xor = (xor + (xor >>> 4)) & 0x0f0f0f0f
  const diffBits = Math.imul(xor, 0x01010101) >>> 24
  return (32 - diffBits) / 32
}

/**
 * Find the best-matching offset when sliding `needle` over `haystack`.
 * Returns { offset, score } where offset is the position in haystack where
 * needle best aligns, and score is the average bit-similarity over the window.
 */
export function findBestOffset(haystack, needle) {
  const hLen = haystack.length
  const nLen = needle.length
  if (nLen === 0 || hLen < nLen) return null

  let bestOffset = 0
  let bestScore  = 0

  for (let offset = 0; offset <= hLen - nLen; offset++) {
    let total = 0
    for (let i = 0; i < nLen; i++) {
      total += bitSimilarity(haystack[offset + i], needle[i])
    }
    const score = total / nLen
    if (score > bestScore) {
      bestScore  = score
      bestOffset = offset
    }
  }

  return bestScore >= SIMILARITY_THRESHOLD ? { offset: bestOffset, score: bestScore } : null
}

/**
 * Given a list of fingerprinted episodes for one season, find the common
 * audio window that appears in the majority of episodes.
 *
 * @param {Array<{ id: string, fingerprint: Int32Array, duration_secs: number }>} episodes
 * @param {number} frameRate  - fingerprint frames per second (fpcalc default ≈ 11.6)
 * @returns {Array<{ episode_id: string, start_secs: number, end_secs: number }>}
 */
export function detectIntros(episodes, frameRate = 11.6) {
  if (episodes.length < 2) return []

  // Use the first episode as the reference
  const ref = episodes[0]
  const hits = []

  for (let i = 1; i < episodes.length; i++) {
    const ep = episodes[i]
    // Slide the shorter over the longer
    const [hay, ndl] = ref.fingerprint.length >= ep.fingerprint.length
      ? [ref.fingerprint, ep.fingerprint]
      : [ep.fingerprint, ref.fingerprint]

    const result = findBestOffset(hay, ndl)
    if (!result) continue

    // Convert frame offset → seconds
    const startSecs = result.offset / frameRate
    const endSecs   = startSecs + (ndl.length / frameRate)
    const duration  = endSecs - startSecs

    if (duration < MIN_INTRO_SECS || duration > MAX_INTRO_SECS) continue

    hits.push({ refStart: startSecs, refEnd: endSecs })
  }

  if (hits.length < Math.ceil(episodes.length * 0.5)) return []

  // Average the intro window across all matching pairs
  const avgStart = hits.reduce((s, h) => s + h.refStart, 0) / hits.length
  const avgEnd   = hits.reduce((s, h) => s + h.refEnd,   0) / hits.length

  // Emit a segment entry for every episode in the season
  return episodes.map(ep => ({
    episode_id: ep.id,
    start_secs: Math.round(avgStart),
    end_secs:   Math.round(avgEnd),
  }))
}
