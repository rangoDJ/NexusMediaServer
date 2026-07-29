import { describe, it, expect, beforeEach } from 'vitest'
import { isAdmin } from './App.jsx'

// Regression coverage for a bug where RequireAdmin was identical to
// RequireAuth and never actually checked the user's role, letting any
// logged-in non-admin client-side-navigate to /settings.
describe('isAdmin', () => {
  beforeEach(() => localStorage.clear())

  it('returns false when nothing is stored', () => {
    expect(isAdmin()).toBe(false)
  })

  it('returns false for a viewer', () => {
    localStorage.setItem('nexus_user', JSON.stringify({ role: 'viewer' }))
    expect(isAdmin()).toBe(false)
  })

  it('returns true for an admin', () => {
    localStorage.setItem('nexus_user', JSON.stringify({ role: 'admin' }))
    expect(isAdmin()).toBe(true)
  })

  it('returns false (not throws) on malformed JSON', () => {
    localStorage.setItem('nexus_user', '{not json')
    expect(isAdmin()).toBe(false)
  })
})
