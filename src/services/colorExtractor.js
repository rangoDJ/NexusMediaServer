import { readFile } from 'fs/promises'
import axios from 'axios'
import jpeg from 'jpeg-js'
import { PNG } from 'pngjs'
import { encode as encodeBlurhash } from 'blurhash'

/**
 * Poster artwork sampling: a blurhash placeholder (matching jellyfin-web,
 * which shows one behind every poster while the real image loads — see
 * components/cardbuilder/cardImage.ts) and, retained alongside it, the
 * dominant-colour extraction from the original Nexus-original UI direction.
 *
 * jellyfin-web itself has no per-item colour system — cards that have no
 * artwork at all fall back to one of 5 fixed palette colours cycled by item
 * id, not anything sampled. dominant_color is kept computed (it's cheap,
 * reuses the same decoded pixels blurhash needs, and the column/tests already
 * exist) but nothing in the Jellyfin-parity UI reads it after this pass —
 * only blurhash and the fixed fallback are used for card visuals now.
 *
 * Runs in-process rather than on a transcoder node. Every other media
 * operation here (ffprobe, trickplay, chromaprint) is delegated over HTTP,
 * but those all need ffmpeg on a file in the media volume. This needs neither:
 * posters are small, most of them live on TMDB rather than on disk, and the
 * result is cosmetic. Making it depend on a reachable — and amd64-only —
 * transcoder would mean the UI loses its placeholder whenever that node is
 * down.
 *
 * The decoders are deliberately pure JS. sharp would be faster, but it is a
 * native module and this image is built for linux/amd64 *and* linux/arm64
 * under QEMU, where node-gyp builds are exactly what you don't want.
 */

// A poster only needs to yield one colour, so decode cost matters more than
// fidelity. TMDB w500 posters are 500x750; sampling every Nth pixel to land
// near this budget keeps a full library backfill quick.
const TARGET_SAMPLES = 4096

// Pixels that carry no usable hue. Near-black and near-white are the letterbox
// bars, title text and blown highlights that dominate most posters by area;
// low-saturation pixels are the greys behind them. Excluding all three is what
// stops nearly every poster resolving to "dark grey".
const MIN_LIGHTNESS  = 0.12
const MAX_LIGHTNESS  = 0.92
const MIN_SATURATION = 0.15

// 24 buckets = 15° each. Fine enough to separate teal from green, coarse
// enough that a gradient across one object still lands in a single bucket.
const HUE_BUCKETS = 24

// The output has to stay legible as a glow, a scrim and a progress fill on
// both a near-black and a near-white ground. Clamping into these bands means a
// muddy or blown-out poster still yields something usable, at the cost of not
// reproducing the artwork exactly — which is the right trade for an accent.
const OUT_SATURATION = { min: 0.45, max: 0.90 }
const OUT_LIGHTNESS  = { min: 0.45, max: 0.62 }

const MAX_BYTES = 8 * 1024 * 1024   // posters are ~100KB; this is a sanity cap

/** @returns {'jpeg'|'png'|null} */
function sniffFormat(buf) {
  if (buf.length < 8) return null
  if (buf[0] === 0xFF && buf[1] === 0xD8) return 'jpeg'
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4E && buf[3] === 0x47) return 'png'
  return null
}

/** Decode to { data: RGBA Buffer, width, height }, or null if unsupported. */
function decode(buf) {
  switch (sniffFormat(buf)) {
    case 'jpeg':
      // useTArray avoids allocating a Node Buffer copy of the pixel data.
      return jpeg.decode(buf, { useTArray: true, maxMemoryUsageInMB: 64 })
    case 'png':
      return PNG.sync.read(buf)
    default:
      return null
  }
}

/** sRGB → HSL, all components 0..1. */
export function rgbToHsl(r, g, b) {
  r /= 255; g /= 255; b /= 255
  const max = Math.max(r, g, b)
  const min = Math.min(r, g, b)
  const l = (max + min) / 2
  if (max === min) return { h: 0, s: 0, l }

  const d = max - min
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min)
  let h
  if (max === r)      h = ((g - b) / d + (g < b ? 6 : 0)) / 6
  else if (max === g) h = ((b - r) / d + 2) / 6
  else                h = ((r - g) / d + 4) / 6
  return { h, s, l }
}

/** HSL (0..1) → '#RRGGBB'. */
export function hslToHex(h, s, l) {
  const hue = (t) => {
    if (t < 0) t += 1
    if (t > 1) t -= 1
    if (t < 1 / 6) return p + (q - p) * 6 * t
    if (t < 1 / 2) return q
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6
    return p
  }
  if (s === 0) {
    const v = Math.round(l * 255)
    return '#' + [v, v, v].map(c => c.toString(16).padStart(2, '0')).join('')
  }
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s
  const p = 2 * l - q
  const rgb = [hue(h + 1 / 3), hue(h), hue(h - 1 / 3)]
  return '#' + rgb
    .map(c => Math.round(c * 255).toString(16).padStart(2, '0'))
    .join('')
    .toUpperCase()
}

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v))

/**
 * Pick the dominant accent from decoded RGBA pixels.
 *
 * Exported separately from the I/O so the choice of colour can be tested
 * against synthetic pixel data without touching the network or disk.
 *
 * @param {{data: Uint8Array|Buffer, width: number, height: number}} image
 * @returns {string|null} '#RRGGBB', or null when the image carries no usable hue
 */
export function dominantColorFromPixels(image) {
  const { data, width, height } = image
  const pixelCount = width * height
  if (!pixelCount) return null

  // Stride the pixels rather than resizing — no interpolation needed when all
  // we want is a hue histogram.
  const step = Math.max(1, Math.floor(pixelCount / TARGET_SAMPLES))

  const buckets = Array.from({ length: HUE_BUCKETS }, () => ({ weight: 0, s: 0, l: 0, n: 0 }))
  let considered = 0

  for (let p = 0; p < pixelCount; p += step) {
    const i = p * 4
    // Skip transparent pixels — a PNG poster's padding shouldn't vote.
    if (data[i + 3] < 128) continue

    const { h, s, l } = rgbToHsl(data[i], data[i + 1], data[i + 2])
    if (l < MIN_LIGHTNESS || l > MAX_LIGHTNESS || s < MIN_SATURATION) continue

    // Weight by saturation so a small vivid area outvotes a large washed-out
    // one — the eye reads the vivid region as "the colour of the poster".
    const idx = Math.min(HUE_BUCKETS - 1, Math.floor(h * HUE_BUCKETS))
    const b = buckets[idx]
    b.weight += s
    b.s += s
    b.l += l
    b.n += 1
    considered++
  }

  if (!considered) return null   // greyscale or near-monochrome poster

  let best = buckets[0]
  let bestIdx = 0
  for (let i = 1; i < HUE_BUCKETS; i++) {
    if (buckets[i].weight > best.weight) { best = buckets[i]; bestIdx = i }
  }
  if (!best.n) return null

  // Hue from the bucket centre; saturation and lightness from its members,
  // then clamped into the legible band.
  const h = (bestIdx + 0.5) / HUE_BUCKETS
  const s = clamp(best.s / best.n, OUT_SATURATION.min, OUT_SATURATION.max)
  const l = clamp(best.l / best.n, OUT_LIGHTNESS.min,  OUT_LIGHTNESS.max)
  return hslToHex(h, s, l)
}

// blurhash's encode() visits every pixel of the buffer it's given — it does
// not sample internally the way dominantColorFromPixels() does. Encoding a
// full 500x750 TMDB poster directly would mean visiting ~375,000 pixels per
// item across a library backfill; downsampling first is standard blurhash
// practice; 32px on the long edge is plenty for a blur-only placeholder.
const BLURHASH_MAX_DIM = 32
// 4x3 components — the commonly-used default component count for photo-like
// artwork (enough horizontal detail for a wide poster/backdrop, less
// vertical, since posters are usually taller than they are wide anyway).
const BLURHASH_COMPONENTS = { x: 4, y: 3 }

/** Nearest-neighbour downsample to RGBA Uint8ClampedArray, longest edge capped at maxDim. */
function downsample(image, maxDim) {
  const { data, width, height } = image
  const scale = maxDim / Math.max(width, height)
  const outW = Math.max(1, Math.round(width * scale))
  const outH = Math.max(1, Math.round(height * scale))
  const out = new Uint8ClampedArray(outW * outH * 4)

  for (let y = 0; y < outH; y++) {
    const srcY = Math.min(height - 1, Math.floor(y / scale))
    for (let x = 0; x < outW; x++) {
      const srcX = Math.min(width - 1, Math.floor(x / scale))
      const si = (srcY * width + srcX) * 4
      const di = (y * outW + x) * 4
      out[di] = data[si]; out[di + 1] = data[si + 1]; out[di + 2] = data[si + 2]; out[di + 3] = data[si + 3]
    }
  }
  return { data: out, width: outW, height: outH }
}

/**
 * Encode a blurhash placeholder from decoded RGBA pixels.
 *
 * Exported separately from the I/O for the same reason
 * dominantColorFromPixels() is — testable against synthetic pixel data.
 *
 * @param {{data: Uint8Array|Buffer, width: number, height: number}} image
 * @returns {string|null} a blurhash string, or null on any encode failure
 */
export function blurhashFromPixels(image) {
  if (!image.width || !image.height) return null
  try {
    const small = downsample(image, BLURHASH_MAX_DIM)
    return encodeBlurhash(small.data, small.width, small.height, BLURHASH_COMPONENTS.x, BLURHASH_COMPONENTS.y)
  } catch {
    return null
  }
}

/** Load poster bytes from a URL or an absolute path. Returns null on failure. */
async function loadBytes({ url, filePath }) {
  if (filePath) {
    const buf = await readFile(filePath)
    return buf.length > MAX_BYTES ? null : buf
  }
  if (url) {
    const { data } = await axios.get(url, {
      responseType: 'arraybuffer',
      timeout: 15_000,
      maxContentLength: MAX_BYTES,
    })
    return Buffer.from(data)
  }
  return null
}

/**
 * Extract the dominant colour of a poster.
 *
 * Never throws — every failure mode (missing file, dead URL, unsupported
 * format, corrupt image, greyscale artwork) returns null, which the schema
 * treats as a normal "no colour" state.
 *
 * @param {{url?: string|null, filePath?: string|null}} source
 * @returns {Promise<string|null>} '#RRGGBB' or null
 */
export async function extractDominantColor(source) {
  try {
    const bytes = await loadBytes(source)
    if (!bytes) return null
    const image = decode(bytes)
    if (!image?.data?.length) return null
    return dominantColorFromPixels(image)
  } catch {
    return null
  }
}

/**
 * Sample a poster once and return everything the backfill task needs from
 * it — decoding is the expensive/fallible part (network fetch, JPEG/PNG
 * parse), so callers that want both values should use this rather than call
 * extractDominantColor() and a hypothetical extractBlurhash() separately,
 * which would fetch and decode the same image twice.
 *
 * Never throws. Either field may independently be null (e.g. a valid decode
 * of a perfectly grey poster yields a blurhash but no dominant color).
 *
 * @param {{url?: string|null, filePath?: string|null}} source
 * @returns {Promise<{color: string|null, blurhash: string|null}>}
 */
export async function extractArtwork(source) {
  try {
    const bytes = await loadBytes(source)
    if (!bytes) return { color: null, blurhash: null }
    const image = decode(bytes)
    if (!image?.data?.length) return { color: null, blurhash: null }
    return {
      color: dominantColorFromPixels(image),
      blurhash: blurhashFromPixels(image),
    }
  } catch {
    return { color: null, blurhash: null }
  }
}
