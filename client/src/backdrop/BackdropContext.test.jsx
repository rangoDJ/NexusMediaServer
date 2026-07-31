import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, act, cleanup } from '@testing-library/react'
import { BackdropProvider, useBackdrop } from './BackdropContext.jsx'

/**
 * The mechanism jellyfin-web itself uses to keep a backdrop image visible
 * behind the whole app while browsing (components/backdrop/backdrop.js):
 * preload, cross-fade a new layer over the old one, then drop the old one.
 * This pins the parts that are easy to get subtly wrong — promotion timing,
 * duplicate-URL no-ops, and the reduced-motion path having no animationend
 * event to promote on.
 */

function Consumer({ url, onReady }) {
  const { setBackdrop, clearBackdrop } = useBackdrop()
  onReady?.({ setBackdrop, clearBackdrop })
  return <button onClick={() => setBackdrop(url)}>set</button>
}

// jsdom's Image never actually decodes anything; onload has to be fired by
// hand once src is assigned, on the next microtask so it behaves like a real
// (if instant) network image load rather than firing synchronously inside
// the setter — matching how the component's own preload-then-fade sequencing
// expects it to arrive asynchronously. Installed/restored via beforeEach/
// afterEach rather than a manual per-test restore() call, so a mid-test
// assertion failure can never skip the restore and leave a broken stub
// installed for whichever test runs next.
let originalImage
beforeEach(() => {
  originalImage = window.Image
  window.Image = class {
    set src(v) { queueMicrotask(() => this.onload?.()) }
  }
  window.matchMedia = vi.fn().mockReturnValue({ matches: false })
})
afterEach(() => { window.Image = originalImage })

// The portal targets document.body directly rather than the RTL container,
// but it's still part of the same React tree, so unmounting it via cleanup()
// does remove the portaled nodes too — without this, leftover layers from one
// test leak into the next test's queries.
afterEach(cleanup)

describe('BackdropProvider', () => {
  it('renders nothing into the portal until a backdrop is set', () => {
    render(<BackdropProvider><Consumer url="/a.jpg" /></BackdropProvider>)
    expect(document.body.querySelectorAll('[class*="layer"]')).toHaveLength(0)
  })

  it('fades in a new layer, then promotes it to current after the animation ends', async () => {
    render(<BackdropProvider><Consumer url="/a.jpg" /></BackdropProvider>)

    await act(async () => {
      screen.getByText('set').click()
      await Promise.resolve() // let the stubbed Image's onload microtask run
    })

    const layers = () => document.body.querySelectorAll('[class*="layer"]')
    expect(layers()).toHaveLength(1)
    const fadingLayer = layers()[0]
    expect(fadingLayer.className).toMatch(/fadeIn/)
    expect(fadingLayer.style.backgroundImage).toContain('/a.jpg')

    // Simulate the CSS animation finishing — jsdom never fires this itself.
    act(() => { fadingLayer.dispatchEvent(new Event('animationend', { bubbles: true })) })

    const settled = layers()
    expect(settled).toHaveLength(1)
    expect(settled[0].className).not.toMatch(/fadeIn/)
    expect(settled[0].style.backgroundImage).toContain('/a.jpg')
  })

  it('is a no-op for the same URL back to back — no restarted fade', async () => {
    let api
    render(<BackdropProvider><Consumer url="/a.jpg" onReady={a => { api = a }} /></BackdropProvider>)

    await act(async () => { api.setBackdrop('/a.jpg'); await Promise.resolve() })
    const layer = document.body.querySelector('[class*="layer"]')
    act(() => { layer.dispatchEvent(new Event('animationend', { bubbles: true })) })

    await act(async () => { api.setBackdrop('/a.jpg'); await Promise.resolve() })
    // Still exactly one layer — a second call for the same image must not
    // start a second cross-fade.
    expect(document.body.querySelectorAll('[class*="layer"]')).toHaveLength(1)
  })

  it('promotes immediately under prefers-reduced-motion, since animationend never fires', async () => {
    window.matchMedia = vi.fn().mockReturnValue({ matches: true })
    render(<BackdropProvider><Consumer url="/a.jpg" /></BackdropProvider>)

    await act(async () => {
      screen.getByText('set').click()
      await Promise.resolve()
    })

    const layer = document.body.querySelector('[class*="layer"]')
    expect(layer).toBeTruthy()
    expect(layer.className).not.toMatch(/fadeIn/)
  })

  it('clearBackdrop removes every layer and allows the same URL to be set again', async () => {
    let api
    render(<BackdropProvider><Consumer url="/a.jpg" onReady={a => { api = a }} /></BackdropProvider>)

    await act(async () => { api.setBackdrop('/a.jpg'); await Promise.resolve() })
    act(() => { api.clearBackdrop() })
    expect(document.body.querySelectorAll('[class*="layer"]')).toHaveLength(0)

    // Without the clear, setBackdrop('/a.jpg') again would be swallowed by
    // the duplicate-URL guard above.
    await act(async () => { api.setBackdrop('/a.jpg'); await Promise.resolve() })
    expect(document.body.querySelectorAll('[class*="layer"]')).toHaveLength(1)
  })
})
