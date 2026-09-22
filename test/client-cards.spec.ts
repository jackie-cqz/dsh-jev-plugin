/** Derivation of card models from rendered tool results. @module dsh-jev/test/client-cards */

import { describe, expect, it } from 'vitest'
import { toCardModels } from '../src/client/cards.ts'

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

  it('reports an empty answer map rather than guessing', () => {
    expect(toCardModels(blocks('{"model":"m","answers":{},"usage":{}}'), false)).toEqual([
      { kind: 'empty' },
    ])
  })

  it.each([
    ['an error result', blocks(SCORE_TEXT), true],
    ['no blocks', [], false],
    ['a non-text block', [{ type: 'image', data: 'x' }], false],
    ['text without an envelope', blocks('score: 2.99/3 = 紧急'), false],
    ['a truncated envelope', blocks('{\n  "model": "m",\n  "answer": {'), false],
    ['an envelope without answers', blocks('{"model":"m","usage":{}}'), false],
    ['an unrecognised answer type', blocks('{"model":"m","answer":{"type":"bogus"},"usage":{}}'), false],
  ])('falls back to pending for %s', (_label, content, isError) => {
    expect(toCardModels(content, isError)).toEqual([{ kind: 'pending' }])
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
