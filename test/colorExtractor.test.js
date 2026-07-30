import { describe, it, expect } from 'vitest'
import {
  rgbToHsl,
  hslToHex,
  dominantColorFromPixels,
  extractDominantColor,
} from '../src/services/colorExtractor.js'

/** Build an RGBA image of solid-colored vertical bands. */
function image(bands, { width = 40, height = 10 } = {}) {
  const data = new Uint8Array(width * height * 4)
  const bandWidth = width / bands.length
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const [r, g, b, a = 255] = bands[Math.min(bands.length - 1, Math.floor(x / bandWidth))]
      const i = (y * width + x) * 4
      data[i] = r; data[i + 1] = g; data[i + 2] = b; data[i + 3] = a
    }
  }
  return { data, width, height }
}

const hexToHsl = (hex) => {
  const n = parseInt(hex.slice(1), 16)
  return rgbToHsl((n >> 16) & 255, (n >> 8) & 255, n & 255)
}

describe('rgbToHsl', () => {
  it('reports zero saturation for greys', () => {
    expect(rgbToHsl(128, 128, 128).s).toBe(0)
    expect(rgbToHsl(0, 0, 0).s).toBe(0)
  })

  it('places primaries at the expected hue angles', () => {
    expect(rgbToHsl(255, 0, 0).h).toBeCloseTo(0, 3)
    expect(rgbToHsl(0, 255, 0).h).toBeCloseTo(1 / 3, 3)
    expect(rgbToHsl(0, 0, 255).h).toBeCloseTo(2 / 3, 3)
  })
})

describe('hslToHex', () => {
  it('round-trips through rgbToHsl', () => {
    const hex = hslToHex(0.5, 0.6, 0.5)
    const back = hexToHsl(hex)
    expect(back.h).toBeCloseTo(0.5, 1)
    expect(back.s).toBeCloseTo(0.6, 1)
    expect(back.l).toBeCloseTo(0.5, 1)
  })

  it('emits grey when saturation is zero', () => {
    expect(hslToHex(0, 0, 0.5)).toBe('#808080')
  })

  it('always emits 7-character uppercase hex', () => {
    for (const h of [0, 0.2, 0.45, 0.7, 0.99]) {
      const hex = hslToHex(h, 0.7, 0.5)
      expect(hex).toMatch(/^#[0-9A-F]{6}$/)
    }
  })
})

describe('dominantColorFromPixels', () => {
  it('returns null for a fully greyscale image', () => {
    expect(dominantColorFromPixels(image([[0, 0, 0], [128, 128, 128], [255, 255, 255]]))).toBeNull()
  })

  it('returns null for an empty image', () => {
    expect(dominantColorFromPixels({ data: new Uint8Array(0), width: 0, height: 0 })).toBeNull()
  })

  it('picks the hue of a single-color image', () => {
    const { h } = hexToHsl(dominantColorFromPixels(image([[220, 40, 40]])))
    expect(Math.min(h, 1 - h)).toBeLessThan(0.05)   // red, near hue 0 either side
  })

  it('ignores letterbox black and blown highlights', () => {
    // Mostly black and white by area, with one teal band. The teal should win.
    const result = dominantColorFromPixels(image([
      [0, 0, 0], [0, 0, 0], [255, 255, 255], [255, 255, 255],
      [0, 0, 0], [0, 0, 0], [255, 255, 255], [32, 190, 190],
    ]))
    expect(hexToHsl(result).h).toBeCloseTo(0.5, 1)
  })

  it('prefers a small vivid area over a large desaturated one', () => {
    // Seven bands of washed-out blue-grey against one vivid orange.
    const result = dominantColorFromPixels(image([
      [120, 130, 150], [120, 130, 150], [120, 130, 150], [120, 130, 150],
      [120, 130, 150], [120, 130, 150], [120, 130, 150], [255, 140, 20],
    ]))
    expect(hexToHsl(result).h).toBeCloseTo(0.08, 1)   // orange
  })

  it('skips transparent pixels', () => {
    // A transparent red band must not outvote the opaque green one. Pure green
    // is used so the expected hue is exactly 1/3 — [0,200,80] would sit at 0.4
    // and make a near-miss look like a pass.
    const result = dominantColorFromPixels(image([[255, 0, 0, 0], [0, 255, 0, 255]]))
    expect(hexToHsl(result).h).toBeCloseTo(1 / 3, 1)
  })

  it('clamps output into the legible saturation and lightness band', () => {
    // Near-black navy and near-white pastel both have usable hue but extreme
    // lightness; the accent has to come back mid-range either way.
    for (const band of [[10, 12, 60], [225, 230, 255]]) {
      const out = dominantColorFromPixels(image([band]))
      if (!out) continue
      const { s, l } = hexToHsl(out)
      expect(l).toBeGreaterThanOrEqual(0.44)
      expect(l).toBeLessThanOrEqual(0.63)
      expect(s).toBeGreaterThanOrEqual(0.44)
      expect(s).toBeLessThanOrEqual(0.91)
    }
  })
})

describe('extractDominantColor (real encoded images)', () => {
  // The unit tests above feed raw pixel arrays, which skips decoding entirely.
  // These encode genuine JPEG and PNG files so the jpeg-js / pngjs paths and
  // their differing return shapes are actually exercised.
  const W = 60, H = 90

  /** Poster-shaped pixels: a letterboxed black top third, then a solid color. */
  function posterPixels(r, g, b) {
    const data = Buffer.alloc(W * H * 4)
    for (let i = 0; i < W * H; i++) {
      const dark = i < (W * H) / 3
      data[i * 4]     = dark ? 0 : r
      data[i * 4 + 1] = dark ? 0 : g
      data[i * 4 + 2] = dark ? 0 : b
      data[i * 4 + 3] = 255
    }
    return data
  }

  async function tmpFile(name, bytes) {
    const { writeFile, mkdtemp } = await import('fs/promises')
    const { join } = await import('path')
    const { tmpdir } = await import('os')
    const dir = await mkdtemp(join(tmpdir(), 'nexus-color-'))
    const file = join(dir, name)
    await writeFile(file, bytes)
    return file
  }

  it('reads a real JPEG and ignores its letterbox bars', async () => {
    const jpeg = (await import('jpeg-js')).default
    const bytes = jpeg.encode({ data: posterPixels(200, 40, 120), width: W, height: H }, 90).data
    const hex = await extractDominantColor({ filePath: await tmpFile('poster.jpg', bytes) })

    expect(hex).toMatch(/^#[0-9A-F]{6}$/)
    expect(hexToHsl(hex).h).toBeCloseTo(0.9, 1)   // magenta, not black
  })

  it('reads a real PNG', async () => {
    const { PNG } = await import('pngjs')
    const png = new PNG({ width: W, height: H })
    png.data = posterPixels(40, 120, 220)
    const hex = await extractDominantColor({ filePath: await tmpFile('poster.png', PNG.sync.write(png)) })

    expect(hex).toMatch(/^#[0-9A-F]{6}$/)
    expect(hexToHsl(hex).h).toBeCloseTo(0.6, 1)   // blue
  })

  it('returns null for a genuinely greyscale poster', async () => {
    const { PNG } = await import('pngjs')
    const png = new PNG({ width: W, height: H })
    png.data = posterPixels(130, 130, 130)
    expect(await extractDominantColor({ filePath: await tmpFile('grey.png', PNG.sync.write(png)) })).toBeNull()
  })
})

describe('extractDominantColor', () => {
  it('returns null rather than throwing when the source is missing', async () => {
    expect(await extractDominantColor({})).toBeNull()
    expect(await extractDominantColor({ filePath: '/does/not/exist.jpg' })).toBeNull()
  })

  it('returns null rather than throwing when a URL is unreachable', async () => {
    expect(await extractDominantColor({ url: 'http://127.0.0.1:59997/nope.jpg' })).toBeNull()
  })

  it('returns null for bytes that are not a supported image', async () => {
    const { writeFile, mkdtemp } = await import('fs/promises')
    const { join } = await import('path')
    const { tmpdir } = await import('os')
    const dir = await mkdtemp(join(tmpdir(), 'nexus-color-'))
    const file = join(dir, 'not-an-image.jpg')
    await writeFile(file, 'this is plainly not a JPEG')
    expect(await extractDominantColor({ filePath: file })).toBeNull()
  })
})
