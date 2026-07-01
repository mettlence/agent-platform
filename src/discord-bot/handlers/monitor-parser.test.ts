import { describe, expect, it } from 'vitest'
import { parseMonitorRequest, looksLikeMonitorRequest } from './monitor-parser.js'

describe('looksLikeMonitorRequest', () => {
  it('accepts English monitor phrasings', () => {
    expect(looksLikeMonitorRequest('monitor pending asksabrina every 4h for 24h')).toBe(true)
    expect(looksLikeMonitorRequest('cronjob check pending both per 2h for 12h')).toBe(true)
    expect(looksLikeMonitorRequest('run cronjob check pending generation')).toBe(true)
  })

  it('accepts Indonesian phrasings', () => {
    expect(looksLikeMonitorRequest('pantau pending asksabrina per 4 jam selama 24 jam')).toBe(true)
    expect(looksLikeMonitorRequest('cronjob check pending order untuk 24 jam kedepan')).toBe(true)
  })

  it('rejects unrelated mentions', () => {
    expect(looksLikeMonitorRequest('ABC12345 jane@example.com')).toBe(false)
    expect(looksLikeMonitorRequest('who are you?')).toBe(false)
    expect(looksLikeMonitorRequest('fix this ticket')).toBe(false)
  })
})

describe('parseMonitorRequest', () => {
  it('parses the canonical English request', () => {
    const r = parseMonitorRequest('monitor pending asksabrina every 4h for 24h')
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.request.projects).toEqual(['asksabrina'])
    expect(r.request.interval_hours).toBe(4)
    expect(r.request.duration_hours).toBe(24)
  })

  it('parses "both" as every registered project', () => {
    const r = parseMonitorRequest('monitor pending both every 2h for 12h')
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.request.projects.sort()).toEqual(['asksabrina', 'astroloversketch'])
  })

  it('parses Indonesian "per N jam selama M jam"', () => {
    const r = parseMonitorRequest(
      'cronjob check pending asksabrina dan astrolover per 4 jam selama 24 jam',
    )
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.request.projects.sort()).toEqual(['asksabrina', 'astroloversketch'])
    expect(r.request.interval_hours).toBe(4)
    expect(r.request.duration_hours).toBe(24)
  })

  it('parses "N jam kedepan"', () => {
    const r = parseMonitorRequest('monitor pending both per 4 jam 24 jam kedepan')
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.request.duration_hours).toBe(24)
  })

  it('parses minute-based intervals (down to 1min for testing)', () => {
    const r = parseMonitorRequest('monitor pending asksabrina every 30m for 4h')
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.request.interval_hours).toBe(0.5)
  })

  it('parses minute-based duration', () => {
    const r = parseMonitorRequest('monitor pending asksabrina every 1m for 10m')
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.request.interval_hours).toBeCloseTo(1 / 60, 6)
    expect(r.request.duration_hours).toBeCloseTo(10 / 60, 6)
  })

  it('parses day-based durations', () => {
    const r = parseMonitorRequest('monitor pending both every 4h for 2 days')
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.request.duration_hours).toBe(48)
  })

  it('rejects missing project', () => {
    const r = parseMonitorRequest('monitor pending every 4h for 24h')
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.error).toMatch(/project/i)
  })

  it('rejects missing interval', () => {
    const r = parseMonitorRequest('monitor pending asksabrina for 24h')
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.error).toMatch(/interval/i)
  })

  it('rejects missing duration', () => {
    const r = parseMonitorRequest('monitor pending asksabrina every 4h')
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.error).toMatch(/duration/i)
  })

  it('rejects duration shorter than interval', () => {
    const r = parseMonitorRequest('monitor pending asksabrina every 4h for 2h')
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.error).toMatch(/at least one interval/i)
  })

  it('rejects duration > 7 days', () => {
    const r = parseMonitorRequest('monitor pending both every 4h for 30 days')
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.error).toMatch(/too large/i)
  })

  it('rejects interval > 24h', () => {
    const r = parseMonitorRequest('monitor pending asksabrina every 48h for 96h')
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.error).toMatch(/interval too large/i)
  })
})
