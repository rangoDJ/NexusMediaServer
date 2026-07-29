import { describe, it, expect } from 'vitest'
import { validateSettings } from '../src/services/pluginManager.js'

describe('validateSettings', () => {
  it('passes for an empty schema', () => {
    expect(validateSettings({}, {})).toEqual([])
  })

  it('flags a missing required field', () => {
    const errors = validateSettings({ apiKey: { type: 'string', required: true } }, {})
    expect(errors).toEqual(['"apiKey" is required'])
  })

  it('skips optional fields that are absent', () => {
    const errors = validateSettings({ lang: { type: 'string', default: 'en' } }, {})
    expect(errors).toEqual([])
  })

  it('type-checks string/number/boolean', () => {
    const schema = { a: { type: 'string' }, b: { type: 'number' }, c: { type: 'boolean' } }
    const errors = validateSettings(schema, { a: 5, b: 'nope', c: 'nope' })
    expect(errors).toContain('"a" must be a string')
    expect(errors).toContain('"b" must be a number')
    expect(errors).toContain('"c" must be a boolean')
  })

  it('enforces enum membership', () => {
    const errors = validateSettings({ lang: { enum: ['en', 'fr'] } }, { lang: 'de' })
    expect(errors).toEqual(['"lang" must be one of: en, fr'])
  })

  it('enforces min/max for numbers', () => {
    const schema = { max: { type: 'number', minimum: 1, maximum: 100 } }
    expect(validateSettings(schema, { max: 0 })).toEqual(['"max" must be >= 1'])
    expect(validateSettings(schema, { max: 101 })).toEqual(['"max" must be <= 100'])
    expect(validateSettings(schema, { max: 50 })).toEqual([])
  })
})
