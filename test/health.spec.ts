/** Contract tests for the health assessment. @module dsh-jev/test/health */

import { describe, expect, it } from 'vitest'

import { assessHealth, type JevHealthInput, type JevHealthThresholds } from '../src/health.ts'

const THRESHOLDS: JevHealthThresholds = { errorRateAlert: 0.5, alertMinCalls: 10 }

/**
 * Build an input with every counter defaulted.
 * @param overrides - fields to replace.
 * @returns the assessment input.
 */
function input(overrides: Partial<JevHealthInput> = {}): JevHealthInput {
  return { calls: 0, failures: 0, circuit: 'closed', ...overrides }
}

describe('assessHealth sample size', () => {
  it('reports unknown below the minimum sample instead of healthy', () => {
    const health = assessHealth(input({ calls: 9, failures: 9 }), THRESHOLDS)

    expect(health.status).toBe('unknown')
    expect(health.reasons).toEqual([])
  })

  it('starts judging at exactly the minimum sample', () => {
    const health = assessHealth(input({ calls: 10, failures: 10 }), THRESHOLDS)

    expect(health.status).toBe('degraded')
    expect(health.reasons).toHaveLength(1)
  })

  it('reports unknown for a single failure out of two calls', () => {
    expect(assessHealth(input({ calls: 2, failures: 1 }), THRESHOLDS).status).toBe('unknown')
  })
})

describe('assessHealth error rate', () => {
  it('treats a rate at exactly the threshold as degraded', () => {
    const health = assessHealth(input({ calls: 10, failures: 5 }), THRESHOLDS)

    expect(health.status).toBe('degraded')
    expect(health.reasons).toHaveLength(1)
  })

  it('treats a rate just below the threshold as healthy', () => {
    const health = assessHealth(input({ calls: 10, failures: 4 }), { errorRateAlert: 0.5, alertMinCalls: 10 })

    expect(health.status).toBe('healthy')
    expect(health.reasons).toEqual([])
  })

  it('quotes the rate, the counts, and the threshold', () => {
    const [reason] = assessHealth(input({ calls: 20, failures: 11 }), THRESHOLDS).reasons

    expect(reason).toContain('0.55')
    expect(reason).toContain('11 of 20')
    expect(reason).toContain('0.50')
  })
})

describe('assessHealth circuit state', () => {
  for (const circuit of ['open', 'half-open'] as const) {
    it(`reports degraded while the circuit is ${circuit}`, () => {
      const health = assessHealth(input({ calls: 10, failures: 0, circuit }), THRESHOLDS)

      expect(health.status).toBe('degraded')
      expect(health.reasons).toHaveLength(1)
      expect(health.reasons[0]).toContain(circuit)
    })
  }

  it('reports both reasons when the rate and the circuit agree', () => {
    const health = assessHealth(input({ calls: 10, failures: 8, circuit: 'open' }), THRESHOLDS)

    expect(health.status).toBe('degraded')
    expect(health.reasons).toHaveLength(2)
    expect(health.reasons[1]).toContain('open')
  })

  it('reports healthy with a closed circuit and no failures', () => {
    const health = assessHealth(input({ calls: 10, failures: 0 }), THRESHOLDS)

    expect(health.status).toBe('healthy')
    expect(health.reasons).toEqual([])
  })
})

describe('assessHealth purity', () => {
  it('returns equal results for equal input', () => {
    const probe = input({ calls: 10, failures: 6, circuit: 'half-open' })

    expect(assessHealth(probe, THRESHOLDS)).toEqual(assessHealth(probe, THRESHOLDS))
  })

  it('exposes reasons as a readonly array', () => {
    const health = assessHealth(input({ calls: 10, failures: 6 }), THRESHOLDS)

    expect(Array.isArray(health.reasons)).toBe(true)
    expect(health.reasons.every(reason => typeof reason === 'string')).toBe(true)
  })

  it('names only counters, states, and thresholds', () => {
    const health = assessHealth(input({ calls: 10, failures: 6, circuit: 'open' }), THRESHOLDS)

    for (const reason of health.reasons) {
      expect(reason).not.toMatch(/state|arguments|apiKey|sk-/i)
    }
  })
})
