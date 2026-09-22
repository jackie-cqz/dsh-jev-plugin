/** Contract tests for the confidence bands and the verdict helper. @module dsh-jev/test/confidence */

import { describe, expect, it } from 'vitest'

import { DEFAULT_CONFIDENCE, type ResolvedConfidenceConfig } from '../src/config.ts'
import { confidenceOf, verdictFor } from '../src/confidence.ts'
import { JevValidationError } from '../src/errors.ts'

/** Bands with an empty review window, used for the degenerate-ordering case. */
const TOUCHING_BANDS: ResolvedConfidenceConfig = { approveAt: 0.5, escalateBelow: 0.5 }

describe('verdictFor', () => {
  const BANDS: ResolvedConfidenceConfig = { approveAt: 0.8, escalateBelow: 0.5 }

  it.each([
    ['a clearly confident value', 0.9, 'approve'],
    ['a value inside the review window', 0.6, 'review'],
    ['a clearly uncertain value', 0.3, 'escalate'],
    ['the inclusive approve boundary', 0.8, 'approve'],
    ['the exclusive escalate boundary', 0.5, 'review'],
    ['just below the escalate boundary', 0.4999, 'escalate'],
    ['the minimum usable confidence', 0, 'escalate'],
    ['the maximum usable confidence', 1, 'approve'],
  ])('maps %s', (_label, confidence, expected) => {
    expect(verdictFor(confidence, BANDS)).toBe(expected)
  })

  it('resolves the shared boundary to approve when the review window is empty', () => {
    expect(verdictFor(0.5, TOUCHING_BANDS)).toBe('approve')
    expect(verdictFor(0.6, TOUCHING_BANDS)).toBe('approve')
    expect(verdictFor(0.4, TOUCHING_BANDS)).toBe('escalate')
  })

  it('applies the default bands', () => {
    expect(verdictFor(0.9, DEFAULT_CONFIDENCE)).toBe('approve')
    expect(verdictFor(0.6, DEFAULT_CONFIDENCE)).toBe('review')
    expect(verdictFor(0.2, DEFAULT_CONFIDENCE)).toBe('escalate')
  })

  const REJECTED: ReadonlyArray<readonly [label: string, value: unknown]> = [
    ['a negative confidence', -0.1],
    ['a confidence above one', 1.1],
    ['NaN', Number.NaN],
    ['positive infinity', Number.POSITIVE_INFINITY],
    ['negative infinity', Number.NEGATIVE_INFINITY],
    ['a numeric string', '0.5'],
    ['null', null],
    ['undefined', undefined],
  ]

  for (const [label, value] of REJECTED) {
    it(`rejects ${label}`, () => {
      expect(() => verdictFor(value as number, BANDS)).toThrow(JevValidationError)
    })
  }

  it('names the received value in the failure message', () => {
    expect(() => verdictFor(1.1, BANDS)).toThrow(/1\.1/)
    expect(() => verdictFor(Number.NaN, BANDS)).toThrow(/NaN/)
    expect(() => verdictFor('0.5' as unknown as number, BANDS)).toThrow(/a string/)
  })
})

describe('confidenceOf', () => {
  it('reads the confidence from a choice answer', () => {
    expect(confidenceOf({
      type: 'choice',
      choice: 'billing',
      probabilities: { billing: 0.9 },
      confidence: 0.77,
    })).toBe(0.77)
  })

  it('reads the confidence from a score answer', () => {
    expect(confidenceOf({
      type: 'score',
      score: 2.99,
      legend: { '0': 'low', '3': 'critical' },
      probabilities: { '3': 0.99 },
      confidence: 0.99,
    })).toBe(0.99)
  })

  it('reports absence for a noul answer, which carries no confidence', () => {
    expect(confidenceOf({ type: 'noul', noul: 0.96 })).toBeUndefined()
  })

  it('accepts the interval boundaries', () => {
    expect(confidenceOf({ confidence: 0 })).toBe(0)
    expect(confidenceOf({ confidence: 1 })).toBe(1)
  })

  it('does not require a type tag', () => {
    expect(confidenceOf({ confidence: 0.42 })).toBe(0.42)
  })

  const ABSENT: ReadonlyArray<readonly [label: string, value: unknown]> = [
    ['a confidence above one', { confidence: 1.1 }],
    ['a negative confidence', { confidence: -0.1 }],
    ['a numeric string', { confidence: '0.9' }],
    ['NaN', { confidence: Number.NaN }],
    ['a missing field', { type: 'choice', choice: 'x' }],
    ['null', null],
    ['an array', [0.5]],
    ['a string', '0.5'],
    ['a number', 0.5],
    ['undefined', undefined],
  ]

  for (const [label, value] of ABSENT) {
    it(`reports absence for ${label}`, () => {
      expect(confidenceOf(value)).toBeUndefined()
    })
  }

  it('never throws on unusable input', () => {
    for (const [, value] of ABSENT) {
      expect(() => confidenceOf(value)).not.toThrow()
    }
  })
})
