/**
 * Replayable presentation facts for the Web decision card.
 *
 * `output.presentationMeta` runs on live streaming and again on session-log
 * replay, so every function here is a pure projection of the canonical value:
 * no clock, no I/O, no session state, and nothing that throws. The record holds
 * only probabilities, labels, scores, and confidences — `state`, tool
 * arguments, tool results, and credentials have no field to travel in.
 *
 * The card types are aliases rather than interfaces: `JsonValue` is an object
 * type with an index signature, and an interface has no implicit one, so an
 * interface could not be handed to the projector contract.
 *
 * @module dsh-jev/presentation
 */

import type { JsonValue } from '@deepseek-ai/dsh-util-values'

/** One answer's card facts. */
export type JevCardAnswer =
  | { kind: 'noul'; id: string; probability: number }
  | {
    kind: 'choice'
    id: string
    chosen: string
    confidence?: number
    probabilities: Record<string, number>
  }
  | {
    kind: 'score'
    id: string
    score: number
    legend?: Record<string, string>
    confidence?: number
    probabilities: Record<string, number>
  }

/** Bounded facts a card needs to rebuild one tool result. */
export type JevCardMeta = {
  /** The tool that produced the result. */
  tool: 'jev_decide' | 'jev_evaluate'
  /** One entry per answer, in response order. */
  answers: readonly JevCardAnswer[]
}

/** Whether a value is a plain JSON object. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** The value as a finite number, or `undefined`. */
function finiteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

/** The value as a finite number inside `[0, 1]`, or `undefined`. */
function unitNumber(value: unknown): number | undefined {
  const number = finiteNumber(value)
  return number !== undefined && number >= 0 && number <= 1 ? number : undefined
}

/** Keep only the entries whose value is a number. */
function numericEntries(value: unknown): Record<string, number> {
  if (!isRecord(value)) return {}
  const kept: Record<string, number> = {}
  for (const [key, entry] of Object.entries(value)) {
    const number = finiteNumber(entry)
    if (number !== undefined) kept[key] = number
  }
  return kept
}

/** Keep only the entries whose value is a string, or `undefined` when none survive. */
function stringEntries(value: unknown): Record<string, string> | undefined {
  if (!isRecord(value)) return undefined
  const kept: Record<string, string> = {}
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry === 'string') kept[key] = entry
  }
  return Object.keys(kept).length > 0 ? kept : undefined
}

/**
 * Project one raw answer, or skip it.
 *
 * A value the card cannot render is dropped rather than defaulted, so a card
 * never shows a plausible number the model did not produce.
 * @param id - answer key from the response map.
 * @param answer - raw answer entry.
 * @returns the card answer, or `undefined` when it cannot be rendered.
 */
function projectAnswer(id: string, answer: unknown): JevCardAnswer | undefined {
  if (!isRecord(answer)) return undefined
  if (answer['type'] === 'noul') {
    const probability = unitNumber(answer['noul'])
    return probability === undefined ? undefined : { kind: 'noul', id, probability }
  }
  if (answer['type'] === 'choice') {
    const chosen = answer['choice']
    if (typeof chosen !== 'string' || chosen === '') return undefined
    const confidence = unitNumber(answer['confidence'])
    return {
      kind: 'choice',
      id,
      chosen,
      ...confidence === undefined ? {} : { confidence },
      probabilities: numericEntries(answer['probabilities']),
    }
  }
  if (answer['type'] === 'score') {
    const score = finiteNumber(answer['score'])
    if (score === undefined) return undefined
    const legend = stringEntries(answer['legend'])
    const confidence = unitNumber(answer['confidence'])
    return {
      kind: 'score',
      id,
      score,
      ...legend === undefined ? {} : { legend },
      ...confidence === undefined ? {} : { confidence },
      probabilities: numericEntries(answer['probabilities']),
    }
  }
  return undefined
}

/**
 * Project an answer map, keyed by the envelope field holding it.
 * @param value - canonical tool output.
 * @param field - `answer` for one decision, `answers` for an evaluation.
 * @returns the projected answers, or `undefined` when none can be rendered.
 */
function projectAnswers(value: unknown, field: 'answer' | 'answers'): readonly JevCardAnswer[] | undefined {
  if (!isRecord(value)) return undefined
  const raw = value[field]
  if (field === 'answer') {
    const answer = projectAnswer('decision', raw)
    return answer === undefined ? undefined : [answer]
  }
  if (!isRecord(raw)) return undefined
  const projected: JevCardAnswer[] = []
  for (const [id, answer] of Object.entries(raw)) {
    const entry = projectAnswer(id, answer)
    if (entry !== undefined) projected.push(entry)
  }
  return projected.length > 0 ? projected : undefined
}

/**
 * Derive the card facts for one `jev_decide` result.
 * @param value - canonical output (`{ model, answer, usage }`).
 * @returns the card facts, or `undefined` when the answer cannot be rendered.
 */
export function decidePresentationMeta(value: unknown): JevCardMeta | undefined {
  const answers = projectAnswers(value, 'answer')
  return answers === undefined ? undefined : { tool: 'jev_decide', answers }
}

/**
 * Derive the card facts for one `jev_evaluate` result.
 * @param value - canonical output (`{ model, answers, usage }`).
 * @returns the card facts, or `undefined` when no answer can be rendered.
 */
export function evaluatePresentationMeta(value: unknown): JevCardMeta | undefined {
  const answers = projectAnswers(value, 'answers')
  return answers === undefined ? undefined : { tool: 'jev_evaluate', answers }
}

/**
 * Adapt a card to the projector contract for `jev_decide`.
 *
 * An `undefined` projection is not a fallback: the registry snapshots the
 * returned value as lossless JSON and fails the whole call when that snapshot is
 * `undefined`, so an underivable card would turn a successful decision into a
 * tool error. It becomes a well-formed card with no answers instead, which a
 * client that validates falls back to its generic row from.
 * @param value - canonical output.
 * @returns a JSON value the registry accepts.
 */
export function decideProjection(value: unknown): JsonValue {
  return asProjection(decidePresentationMeta(value) ?? { tool: 'jev_decide', answers: [] })
}

/**
 * Adapt a card to the projector contract for `jev_evaluate`.
 * @param value - canonical output.
 * @returns a JSON value the registry accepts.
 */
export function evaluateProjection(value: unknown): JsonValue {
  return asProjection(evaluatePresentationMeta(value) ?? { tool: 'jev_evaluate', answers: [] })
}

/**
 * State that a card is lossless JSON.
 *
 * Every field is built here from JSON primitives, arrays, and plain objects, so
 * the conversion is true at runtime; the cast exists only because the card's
 * `readonly` fields are narrower than `JsonValue`'s mutable array type.
 * @param card - card built by this module.
 * @returns the same value as a `JsonValue`.
 */
function asProjection(card: JevCardMeta): JsonValue {
  return card as unknown as JsonValue
}
