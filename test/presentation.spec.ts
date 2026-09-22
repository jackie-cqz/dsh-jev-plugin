/** Presentable card facts derived from canonical tool output. @module dsh-jev/test/presentation */

import { describe, expect, it } from 'vitest'

import {
  decidePresentationMeta,
  decideProjection,
  evaluatePresentationMeta,
  evaluateProjection,
} from '../src/presentation.ts'

/** A canonical `jev_decide` envelope around one answer. */
function decideEnvelope(answer: unknown): unknown {
  return { model: 'jev-1.13.0', answer, usage: { input_tokens: 1, output_tokens: 1 } }
}

/** A canonical `jev_evaluate` envelope around an answer map. */
function evaluateEnvelope(answers: unknown): unknown {
  return { model: 'jev-1.13.0', answers, usage: { input_tokens: 1, output_tokens: 1 } }
}

describe('decidePresentationMeta', () => {
  it('projects a noul answer', () => {
    expect(decidePresentationMeta(decideEnvelope({ type: 'noul', noul: 0.93 }))).toEqual({
      tool: 'jev_decide',
      answers: [{ kind: 'noul', id: 'decision', probability: 0.93 }],
    })
  })

  it('projects a choice answer with its distribution and confidence', () => {
    expect(decidePresentationMeta(decideEnvelope({
      type: 'choice',
      choice: 'billing',
      probabilities: { billing: 0.9, technical: 0.1 },
      confidence: 0.8,
    }))).toEqual({
      tool: 'jev_decide',
      answers: [{
        kind: 'choice',
        id: 'decision',
        chosen: 'billing',
        confidence: 0.8,
        probabilities: { billing: 0.9, technical: 0.1 },
      }],
    })
  })

  it('projects a score answer with its legend', () => {
    expect(decidePresentationMeta(decideEnvelope({
      type: 'score',
      score: 2.99,
      legend: { 0: 'low', 1: 'medium', 2: 'high', 3: 'critical' },
      probabilities: { 0: 0, 1: 0, 2: 0.01, 3: 0.99 },
      confidence: 0.99,
    }))).toEqual({
      tool: 'jev_decide',
      answers: [{
        kind: 'score',
        id: 'decision',
        score: 2.99,
        legend: { 0: 'low', 1: 'medium', 2: 'high', 3: 'critical' },
        confidence: 0.99,
        probabilities: { 0: 0, 1: 0, 2: 0.01, 3: 0.99 },
      }],
    })
  })

  it('keeps a chosen label that is missing from the distribution', () => {
    // An incomplete distribution must not cost the card its headline label.
    const meta = decidePresentationMeta(decideEnvelope({ type: 'choice', choice: 'sales', probabilities: {} }))
    expect(meta?.answers[0]).toEqual({ kind: 'choice', id: 'decision', chosen: 'sales', probabilities: {} })
  })

  it('keeps a zero score, which is a real answer rather than an absent one', () => {
    const meta = decidePresentationMeta(decideEnvelope({ type: 'score', score: 0, probabilities: {} }))
    expect(meta?.answers[0]).toEqual({ kind: 'score', id: 'decision', score: 0, probabilities: {} })
  })
})

describe('malformed input', () => {
  it('skips a noul answer whose probability is out of range or not a number', () => {
    expect(decidePresentationMeta(decideEnvelope({ type: 'noul', noul: 1.5 }))).toBeUndefined()
    expect(decidePresentationMeta(decideEnvelope({ type: 'noul', noul: -0.1 }))).toBeUndefined()
    expect(decidePresentationMeta(decideEnvelope({ type: 'noul', noul: 'high' }))).toBeUndefined()
    expect(decidePresentationMeta(decideEnvelope({ type: 'noul', noul: Number.NaN }))).toBeUndefined()
  })

  it('skips an answer whose type is unknown', () => {
    expect(decidePresentationMeta(decideEnvelope({ type: 'nonsense', value: 1 }))).toBeUndefined()
  })

  it('skips a choice without a usable label and a score without a number', () => {
    expect(decidePresentationMeta(decideEnvelope({ type: 'choice', choice: '' }))).toBeUndefined()
    expect(decidePresentationMeta(decideEnvelope({ type: 'score', score: 'high' }))).toBeUndefined()
  })

  it('returns undefined for envelopes it cannot read', () => {
    expect(decidePresentationMeta(null)).toBeUndefined()
    expect(decidePresentationMeta('text')).toBeUndefined()
    expect(decidePresentationMeta([1, 2])).toBeUndefined()
    expect(decidePresentationMeta({ model: 'x' })).toBeUndefined()
    expect(decidePresentationMeta(decideEnvelope('text'))).toBeUndefined()
    expect(evaluatePresentationMeta(evaluateEnvelope({}))).toBeUndefined()
    expect(evaluatePresentationMeta(evaluateEnvelope([]))).toBeUndefined()
  })

  it('never throws on hostile input', () => {
    for (const value of [undefined, null, 0, true, '', [], {}, { answer: {} }, { answers: { a: null } }]) {
      expect(() => decidePresentationMeta(value)).not.toThrow()
      expect(() => evaluatePresentationMeta(value)).not.toThrow()
      expect(() => decideProjection(value)).not.toThrow()
      expect(() => evaluateProjection(value)).not.toThrow()
    }
  })

  it('drops a confidence outside the unit interval instead of clamping it', () => {
    const meta = decidePresentationMeta(decideEnvelope({
      type: 'choice',
      choice: 'billing',
      probabilities: { billing: 1 },
      confidence: 1.5,
    }))
    expect(meta?.answers[0]).toEqual({
      kind: 'choice',
      id: 'decision',
      chosen: 'billing',
      probabilities: { billing: 1 },
    })
    expect(meta?.answers[0] !== undefined && 'confidence' in meta.answers[0]).toBe(false)
  })

  it('keeps only string legend entries and drops the key when none survive', () => {
    const kept = decidePresentationMeta(decideEnvelope({
      type: 'score',
      score: 1,
      legend: { 0: 'low', 1: 7 },
      probabilities: {},
    }))
    expect(kept?.answers[0]).toEqual({ kind: 'score', id: 'decision', score: 1, legend: { 0: 'low' }, probabilities: {} })

    const dropped = decidePresentationMeta(decideEnvelope({
      type: 'score',
      score: 1,
      legend: { 0: 7, 1: null },
      probabilities: {},
    }))
    expect(dropped?.answers[0]).toEqual({ kind: 'score', id: 'decision', score: 1, probabilities: {} })
    expect(dropped?.answers[0] !== undefined && 'legend' in dropped.answers[0]).toBe(false)
  })

  it('keeps only numeric probability entries', () => {
    const meta = decidePresentationMeta(decideEnvelope({
      type: 'choice',
      choice: 'billing',
      probabilities: { billing: 0.9, technical: 'high', sales: null },
    }))
    expect(meta?.answers[0]).toEqual({
      kind: 'choice',
      id: 'decision',
      chosen: 'billing',
      probabilities: { billing: 0.9 },
    })
  })
})

describe('evaluatePresentationMeta', () => {
  it('projects every answer in response order', () => {
    expect(evaluatePresentationMeta(evaluateEnvelope({
      department: { type: 'choice', choice: 'billing', probabilities: { billing: 0.9 }, confidence: 0.8 },
      is_urgent: { type: 'noul', noul: 0.97 },
      frustration: { type: 'score', score: 1.72, legend: { 0: 'calm', 1: 'annoyed', 2: 'angry' }, probabilities: {} },
    }))).toEqual({
      tool: 'jev_evaluate',
      answers: [
        { kind: 'choice', id: 'department', chosen: 'billing', confidence: 0.8, probabilities: { billing: 0.9 } },
        { kind: 'noul', id: 'is_urgent', probability: 0.97 },
        { kind: 'score', id: 'frustration', score: 1.72, legend: { 0: 'calm', 1: 'annoyed', 2: 'angry' }, probabilities: {} },
      ],
    })
  })

  it('keeps the answers it can render when a sibling is unreadable', () => {
    const meta = evaluatePresentationMeta(evaluateEnvelope({
      good: { type: 'noul', noul: 0.5 },
      bad: { type: 'nonsense' },
    }))
    expect(meta?.answers).toEqual([{ kind: 'noul', id: 'good', probability: 0.5 }])
  })
})

describe('redaction and purity', () => {
  it('carries nothing beyond the declared fields', () => {
    const meta = decidePresentationMeta({
      model: 'jev-1.13.0',
      answer: {
        type: 'noul',
        noul: 0.5,
        state: 'sk-secret-value',
        arguments: { token: 'sk-secret-value' },
        usage: { input_tokens: 1 },
      },
      usage: { input_tokens: 1, output_tokens: 1 },
      apiKey: 'sk-secret-value',
      state: 'sk-secret-value',
    })
    expect(meta).toEqual({ tool: 'jev_decide', answers: [{ kind: 'noul', id: 'decision', probability: 0.5 }] })
    expect(JSON.stringify(meta)).not.toContain('sk-secret-value')
  })

  it('is a pure projection: the same input twice gives equal output', () => {
    const value = evaluateEnvelope({
      a: { type: 'noul', noul: 0.2 },
      b: { type: 'choice', choice: 'x', probabilities: { x: 1 }, confidence: 1 },
    })
    expect(evaluatePresentationMeta(value)).toEqual(evaluatePresentationMeta(value))
  })
})

describe('projections', () => {
  it('never returns undefined, which the registry rejects as invalid output', () => {
    // The registry snapshots the projection and fails the call when it is
    // undefined, so an underivable card must still be a well-formed JSON value.
    expect(decideProjection(null)).toEqual({ tool: 'jev_decide', answers: [] })
    expect(evaluateProjection(null)).toEqual({ tool: 'jev_evaluate', answers: [] })
    expect(decideProjection(decideEnvelope({ type: 'nonsense' }))).toEqual({ tool: 'jev_decide', answers: [] })
  })

  it('passes a derivable card straight through', () => {
    expect(decideProjection(decideEnvelope({ type: 'noul', noul: 0.4 }))).toEqual({
      tool: 'jev_decide',
      answers: [{ kind: 'noul', id: 'decision', probability: 0.4 }],
    })
  })
})
