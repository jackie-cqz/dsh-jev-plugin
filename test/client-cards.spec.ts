/** Derivation of card models from rendered tool results. @module dsh-jev/test/client-cards */

import { describe, expect, it } from 'vitest'
import { cardsFromMeta, toCardModels } from '../src/client/cards.ts'

/** One rendered score result, exactly as the tool emits it. */
const SCORE_TEXT = `score: 2.99/3 = 紧急 (confidence=0.99)

{
  "model": "jev-1.13.0",
  "answer": {
    "type": "score",
    "score": 2.99,
    "legend": { "0": "低", "1": "中", "2": "高", "3": "紧急" },
    "probabilities": { "0": 0, "1": 0, "2": 0.01, "3": 0.99 },
    "confidence": 0.99
  },
  "usage": { "input_tokens": 335, "output_tokens": 17 }
}`

/** Wrap rendered text as a single text content block. */
function blocks(text: string): readonly unknown[] {
  return [{ type: 'text', text }]
}

describe('toCardModels', () => {
  it('derives a score card with its legend-derived maximum and level', () => {
    expect(toCardModels(blocks(SCORE_TEXT), false)).toEqual([
      { kind: 'score', id: 'decision', score: 2.99, max: 3, level: '紧急', confidence: 0.99 },
    ])
  })

  it('derives a noul card', () => {
    const text = '{\n  "model": "m",\n  "answer": { "type": "noul", "noul": 0.93 },\n  "usage": {}\n}'
    expect(toCardModels(blocks(text), false)).toEqual([
      { kind: 'noul', id: 'decision', probability: 0.93 },
    ])
  })

  it('orders choice options by descending probability', () => {
    const text = '{"model":"m","answer":{"type":"choice","choice":"billing",'
      + '"probabilities":{"sales":0.07,"billing":0.73,"technical":0.2},"confidence":0.87},"usage":{}}'
    expect(toCardModels(blocks(text), false)).toEqual([
      {
        kind: 'choice',
        id: 'decision',
        chosen: 'billing',
        confidence: 0.87,
        options: [
          { label: 'billing', probability: 0.73 },
          { label: 'technical', probability: 0.2 },
          { label: 'sales', probability: 0.07 },
        ],
      },
    ])
  })

  it('adds a chosen label the distribution omits, keeping the order', () => {
    const text = '{"model":"m","answer":{"type":"choice","choice":"refunds",'
      + '"probabilities":{"billing":0.5,"sales":0.5}},"usage":{}}'
    const [model] = toCardModels(blocks(text), false)
    expect(model?.kind === 'choice' && model.options).toEqual([
      { label: 'billing', probability: 0.5 },
      { label: 'sales', probability: 0.5 },
      { label: 'refunds', probability: 0 },
    ])
  })

  it('derives one card per answer for a multi-question result', () => {
    const text = '{"model":"m","answers":{'
      + '"department":{"type":"choice","choice":"billing","probabilities":{"billing":1}},'
      + '"is_urgent":{"type":"noul","noul":0.97}},"usage":{}}'
    expect(toCardModels(blocks(text), false)).toEqual([
      {
        kind: 'choice',
        id: 'department',
        chosen: 'billing',
        options: [{ label: 'billing', probability: 1 }],
      },
      { kind: 'noul', id: 'is_urgent', probability: 0.97 },
    ])
  })

  it('defers to the generic row for an empty answer map', () => {
    // An empty list means "no card": the host keeps its generic tool row, which
    // still shows the raw result.
    expect(toCardModels(blocks('{"model":"m","answers":{},"usage":{}}'), false)).toEqual([])
  })

  it.each([
    ['an error result', blocks(SCORE_TEXT), true],
    ['no blocks', [], false],
    ['a non-text block', [{ type: 'image', data: 'x' }], false],
    ['text without an envelope', blocks('score: 2.99/3 = 紧急'), false],
    ['a truncated envelope', blocks('{\n  "model": "m",\n  "answer": {'), false],
    ['an envelope without answers', blocks('{"model":"m","usage":{}}'), false],
    ['an unrecognised answer type', blocks('{"model":"m","answer":{"type":"bogus"},"usage":{}}'), false],
  ])('defers to the generic row for %s', (_label, content, isError) => {
    expect(toCardModels(content, isError)).toEqual([])
  })

  it('skips an out-of-range probability instead of rendering it', () => {
    const text = '{"model":"m","answers":{'
      + '"ok":{"type":"noul","noul":0.5},"bad":{"type":"noul","noul":1.5}},"usage":{}}'
    expect(toCardModels(blocks(text), false)).toEqual([
      { kind: 'noul', id: 'ok', probability: 0.5 },
    ])
  })

  it('is deterministic', () => {
    expect(toCardModels(blocks(SCORE_TEXT), false)).toEqual(toCardModels(blocks(SCORE_TEXT), false))
  })

  it('carries no field the answer did not declare', () => {
    const text = '{"model":"m","answer":{"type":"noul","noul":0.5,'
      + '"state":"sk-secret-value","arguments":{"token":"sk-secret-value"}},"usage":{}}'
    expect(JSON.stringify(toCardModels(blocks(text), false))).not.toContain('sk-secret-value')
  })
})

describe('cardsFromMeta', () => {
  it('derives every kind from the projected metadata', () => {
    expect(cardsFromMeta({
      tool: 'jev_evaluate',
      answers: [
        { kind: 'noul', id: 'is_urgent', probability: 0.97 },
        {
          kind: 'choice',
          id: 'department',
          chosen: 'billing',
          confidence: 0.87,
          probabilities: { billing: 0.73, sales: 0.07 },
        },
        {
          kind: 'score',
          id: 'urgency',
          score: 2.99,
          legend: { '0': '低', '3': '紧急' },
          confidence: 0.99,
          probabilities: { '3': 0.99 },
        },
      ],
    }, false)).toEqual([
      { kind: 'noul', id: 'is_urgent', probability: 0.97 },
      {
        kind: 'choice',
        id: 'department',
        chosen: 'billing',
        confidence: 0.87,
        options: [
          { label: 'billing', probability: 0.73 },
          { label: 'sales', probability: 0.07 },
        ],
      },
      { kind: 'score', id: 'urgency', score: 2.99, max: 3, level: '紧急', confidence: 0.99 },
    ])
  })

  it.each([
    ['an error result', { answers: [{ kind: 'noul', id: 'x', probability: 1 }] }, true],
    ['absent metadata', undefined, false],
    ['a non-object', 'nope', false],
    ['no answers array', { tool: 'jev_decide' }, false],
    ['an empty answers array', { tool: 'jev_decide', answers: [] }, false],
    ['an unrecognised kind', { answers: [{ kind: 'bogus', id: 'x' }] }, false],
    ['an out-of-range probability', { answers: [{ kind: 'noul', id: 'x', probability: 2 }] }, false],
    ['an answer without an id', { answers: [{ kind: 'noul', probability: 1 }] }, false],
  ])('returns no cards for %s', (_label, meta, isError) => {
    // An empty list hands the row back to the host rather than rendering noise.
    expect(cardsFromMeta(meta, isError)).toEqual([])
  })

  it('carries no field the projection did not declare', () => {
    const models = cardsFromMeta({
      answers: [{ kind: 'noul', id: 'x', probability: 1, state: 'sk-secret-value' }],
      state: 'sk-secret-value',
    }, false)
    expect(JSON.stringify(models)).not.toContain('sk-secret-value')
  })
})
