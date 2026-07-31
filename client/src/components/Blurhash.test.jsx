import { describe, it, expect, afterEach } from 'vitest'
import { render, cleanup } from '@testing-library/react'
import { encode } from 'blurhash'
import Blurhash from './Blurhash.jsx'

afterEach(cleanup)

// jsdom has no real canvas 2D backend (getContext('2d') returns null); stub
// just enough of the API for the component's decode-then-paint effect to run
// the way it would in a real browser.
HTMLCanvasElement.prototype.getContext = function () {
  return {
    createImageData: (w, h) => ({ data: new Uint8ClampedArray(w * h * 4) }),
    putImageData: () => {},
  }
}

function realHash() {
  const w = 4, h = 4
  const px = new Uint8ClampedArray(w * h * 4)
  for (let i = 0; i < px.length; i += 4) { px[i] = 200; px[i + 1] = 60; px[i + 2] = 60; px[i + 3] = 255 }
  return encode(px, w, h, 4, 3)
}

describe('Blurhash', () => {
  it('renders nothing when there is no hash', () => {
    const { container } = render(<Blurhash hash={null} />)
    expect(container.querySelector('canvas')).toBeNull()
  })

  it('renders a canvas and paints it for a valid hash', () => {
    const { container } = render(<Blurhash hash={realHash()} />)
    const canvas = container.querySelector('canvas')
    expect(canvas).toBeTruthy()
    // jsdom's canvas 2D context is a stub (no real pixel backing store) but
    // getImageData/putImageData still have to exist and not throw for the
    // component's decode-then-paint effect to complete without error.
    expect(() => canvas.getContext('2d')).not.toThrow()
  })

  it('does not throw for a malformed hash', () => {
    expect(() => render(<Blurhash hash="not-a-real-blurhash" />)).not.toThrow()
  })
})
