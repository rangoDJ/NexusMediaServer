import { describe, it, expect } from 'vitest'
import { formatTime, formatBitrate, parseTrickplayVtt } from './Player.jsx'

describe('formatTime', () => {
  it('formats sub-hour durations as m:ss', () => {
    expect(formatTime(0)).toBe('0:00')
    expect(formatTime(65)).toBe('1:05')
    expect(formatTime(599)).toBe('9:59')
  })

  it('formats hour-plus durations as h:mm:ss', () => {
    expect(formatTime(3661)).toBe('1:01:01')
  })

  it('falls back to 0:00 for invalid input', () => {
    expect(formatTime(null)).toBe('0:00')
    expect(formatTime(undefined)).toBe('0:00')
    expect(formatTime(-5)).toBe('0:00')
    expect(formatTime(Infinity)).toBe('0:00')
  })
})

describe('formatBitrate', () => {
  it('renders Mbps for >= 1000 kbps', () => {
    expect(formatBitrate(6000)).toBe('6.0 Mbps')
  })

  it('renders Kbps for < 1000 kbps', () => {
    expect(formatBitrate(700)).toBe('700 Kbps')
  })

  it('falls back to an em dash for falsy input', () => {
    expect(formatBitrate(0)).toBe('—')
    expect(formatBitrate(null)).toBe('—')
  })
})

describe('parseTrickplayVtt', () => {
  it('parses cues with media-fragment xywh references', () => {
    const vtt = [
      'WEBVTT',
      '',
      '00:00:00.000 --> 00:00:10.000',
      'trickplay.jpg#xywh=0,0,160,90',
      '',
      '00:00:10.000 --> 00:00:20.000',
      'trickplay.jpg#xywh=160,0,160,90',
      '',
    ].join('\n')

    const cues = parseTrickplayVtt(vtt)
    expect(cues).toHaveLength(2)
    expect(cues[0]).toEqual({ start: 0, end: 10, x: 0, y: 0, w: 160, h: 90 })
    expect(cues[1]).toEqual({ start: 10, end: 20, x: 160, y: 0, w: 160, h: 90 })
  })

  it('ignores blocks without a time range or xywh reference', () => {
    const vtt = 'WEBVTT\n\nNOTE this block has neither\n'
    expect(parseTrickplayVtt(vtt)).toEqual([])
  })
})
