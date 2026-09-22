/** Model-visible rendering: summary lines, degradation, and canonical JSON. @module dsh-jev/test/render */

import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import { describe, expect, it } from 'vitest'

import { describeAnswer, renderDecision, renderJson } from '../src/render.ts'

const USAGE = { input_tokens: 1, output_tokens: 2 }

/** Build a `jev_decide`-shaped envelope. */
function decide(answer: unknown): JsonValue {
  return { model: 'jev-1.13.0', answer, usage: USAGE } as unknown as JsonValue
}

/** Build a `jev_evaluate`-shaped envelope. */
function evaluate(answers: Record<string, unknown>): JsonValue {
  return { model: 'jev-1.13.0', answers, usage: USAGE } as unknown as JsonValue
}

/** The single text block's text. */
function textOf(value: JsonValue): string {
  const blocks = renderDecision(value)
  expect(blocks).toHaveLength(1)
  const block = blocks[0]
  if (block === undefined) throw new Error('renderDecision returned no block')
  return block.text
}

describe('describeAnswer', () => {
  it('describes noul with a probability and a percentage', () => {
    expect(describeAnswer({ type: 'noul', noul: 0.93 })).toBe('noul: yes, p=0.93 (93%)')
  })

  it('reads noul below one half as no', () => {
    expect(describeAnswer({ type: 'noul', noul: 0.04 })).toBe('noul: no, p=0.04 (4%)')
  })

  it('rounds a long probability', () => {
    expect(describeAnswer({ noul: 0.9111111 })).toBe('noul: yes, p=0.911 (91%)')
  })

  it('describes choice with the selected label probability and confidence', () => {
    const answer = { type: 'choice', choice: 'billing', probabilities: { billing: 0.91, sales: 0.09 }, confidence: 0.87 }
    expect(describeAnswer(answer)).toBe('choice: billing (p=0.91, confidence=0.87)')
  })

  it('drops the probability when the distribution omits the selected label', () => {
    const answer = { type: 'choice', choice: 'billing', probabilities: { sales: 0.2 }, confidence: 0.5 }
    expect(describeAnswer(answer)).toBe('choice: billing (confidence=0.5)')
  })

  it('describes a bare choice label', () => {
    expect(describeAnswer({ choice: 'billing' })).toBe('choice: billing')
  })

  it('describes score against its legend', () => {
    const answer = { type: 'score', score: 2.99, confidence: 0.99, legend: { 0: '低', 1: '中', 2: '高', 3: '紧急' } }
    expect(describeAnswer(answer)).toBe('score: 2.99/3 = 紧急 (confidence=0.99)')
  })

  it('rounds the score to its nearest legend level', () => {
    const answer = { score: 1.4, confidence: 0.6, legend: { 0: '低', 1: '中', 2: '高', 3: '紧急' } }
    expect(describeAnswer(answer)).toBe('score: 1.4/3 = 中 (confidence=0.6)')
  })

  it('falls back to a bare score when the legend is missing', () => {
    expect(describeAnswer({ type: 'score', score: 1.5 })).toBe('score: 1.5')
  })

  it('omits the label when the score is outside the legend', () => {
    const answer = { score: 5, legend: { 0: 'low', 1: 'high' } }
    expect(describeAnswer(answer)).toBe('score: 5/1')
  })

  it('ignores legend entries that are not integer-keyed strings', () => {
    const answer = { score: 1, legend: { 0: 'low', 1: 'high', x: 'nope', 2: 7 } }
    expect(describeAnswer(answer)).toBe('score: 1/1 = high')
  })

  it('returns undefined for values carrying none of the three fields', () => {
    expect(describeAnswer({ type: 'noul' })).toBeUndefined()
    expect(describeAnswer(null)).toBeUndefined()
    expect(describeAnswer('nope')).toBeUndefined()
    expect(describeAnswer([1, 2])).toBeUndefined()
    expect(describeAnswer({ noul: 'high' })).toBeUndefined()
  })
})

describe('renderDecision', () => {
  it('puts the summary above the canonical JSON', () => {
    const value = decide({ type: 'noul', noul: 0.93 })
    expect(textOf(value)).toBe(`noul: yes, p=0.93 (93%)\n\n${JSON.stringify(value, null, 2)}`)
  })

  it('lists one line per evaluate answer in the original key order', () => {
    const value = evaluate({
      department: { type: 'choice', choice: 'billing', probabilities: { billing: 0.9 }, confidence: 0.8 },
      is_urgent: { type: 'noul', noul: 0.97 },
      frustration: { type: 'score', score: 1.72, legend: { 0: 'Calm', 1: 'Frustrated', 2: 'Very angry' }, confidence: 0.62 },
    })

    expect(textOf(value)).toBe([
      'department: choice: billing (p=0.9, confidence=0.8)',
      'is_urgent: noul: yes, p=0.97 (97%)',
      'frustration: score: 1.72/2 = Very angry (confidence=0.62)',
      '',
      JSON.stringify(value, null, 2),
    ].join('\n'))
  })

  it('marks an unrecognised answer instead of dropping the answer id', () => {
    const value = evaluate({ known: { noul: 1 }, unknown: { type: 'mystery' } })
    expect(textOf(value)).toContain('unknown: (unrecognized answer)')
  })

  it('always ends with the canonical JSON', () => {
    const value = evaluate({ a: { noul: 0.2 }, b: { choice: 'x' } })
    expect(textOf(value).endsWith(JSON.stringify(value, null, 2))).toBe(true)
  })

  it('produces identical text for identical input', () => {
    const value = decide({ score: 2.5, legend: { 0: 'a', 1: 'b', 2: 'c' }, confidence: 0.7 })
    expect(textOf(value)).toBe(textOf(value))
  })

  const DEGRADED: ReadonlyArray<readonly [label: string, value: unknown]> = [
    ['null', null],
    ['a string', 'nope'],
    ['an array', [1, 2]],
    ['an empty object', {}],
    ['an envelope without an answer', { model: 'm', usage: USAGE }],
    ['an envelope with an empty answers map', evaluate({})],
    ['an unrecognised answer', decide({ type: 'mystery' })],
    ['an answers field that is not an object', { answers: 'nope' }],
  ]

  for (const [label, raw] of DEGRADED) {
    it(`degrades to canonical JSON for ${label} without throwing`, () => {
      const value = raw as JsonValue
      const text = textOf(value)
      expect(text).toBe(JSON.stringify(value, null, 2))
    })
  }
})

describe('renderJson', () => {
  it('stays a pure canonical JSON renderer', () => {
    const value = decide({ type: 'noul', noul: 0.93 })
    expect(renderJson(value)).toEqual([{ type: 'text', text: JSON.stringify(value, null, 2) }])
  })
})
