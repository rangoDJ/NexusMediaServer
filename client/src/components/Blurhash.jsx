import { useRef, useEffect } from 'react'
import { decode } from 'blurhash'

// Small canvas — this is a blur placeholder, not a thumbnail. Blurhash is
// lossy by construction (see components/cardbuilder/cardImage.ts in
// jellyfin-web, which does the same thing at roughly this resolution), and
// CSS scales it up to fill the card.
const CANVAS_SIZE = 32

/**
 * Decodes a blurhash string to a small canvas, matching jellyfin-web's own
 * poster placeholder (shown behind the real <img> while it loads, then
 * hidden once the image paints — see MediaCard.jsx).
 */
export default function Blurhash({ hash, className }) {
  const canvasRef = useRef(null)

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas || !hash) return

    let pixels
    try {
      pixels = decode(hash, CANVAS_SIZE, CANVAS_SIZE)
    } catch {
      return   // a malformed hash shouldn't crash the card
    }

    const ctx = canvas.getContext('2d')
    if (!ctx) return   // context can be unavailable (e.g. jsdom, exhausted contexts)
    const imageData = ctx.createImageData(CANVAS_SIZE, CANVAS_SIZE)
    imageData.data.set(pixels)
    ctx.putImageData(imageData, 0, 0)
  }, [hash])

  if (!hash) return null

  return (
    <canvas
      ref={canvasRef}
      className={className}
      width={CANVAS_SIZE}
      height={CANVAS_SIZE}
      aria-hidden="true"
    />
  )
}
