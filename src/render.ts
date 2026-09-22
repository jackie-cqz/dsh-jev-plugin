/** Model-visible rendering shared by the Jev tools. @module dsh-jev/render */

import type { JsonValue } from '@deepseek-ai/dsh-util-values'

/** A single model-visible text block. */
export interface TextContentBlock {
  type: 'text'
  text: string
}

/**
 * Render a canonical tool value as the one text block the model sees.
 * @param value - canonical tool output, already validated against the output schema.
 * @returns one text block holding the pretty-printed JSON.
 */
export function renderJson(value: JsonValue): TextContentBlock[] {
  return [{ type: 'text', text: JSON.stringify(value, null, 2) }]
}

/**
 * Read a value as a plain record.
 * @param value - candidate read from a canonical envelope.
 * @returns the record, or `undefined` for arrays, `null`, and primitives.
 */
function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  return value as Record<string, unknown>
}

/**
 * Read a finite number.
 * @param value - candidate field.
 * @returns the number, or `undefined` for other types and non-finite values.
 */
function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

/**
 * Read a string.
 * @param value - candidate field.
 * @returns the string, or `undefined` for other types.
 */
function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

/**
 * Round a number so a summary line stays short and byte-identical across runs.
 * @param value - raw number from an answer.
 * @param digits - decimals to keep.
 * @returns the rounded number.
 */
function round(value: number, digits: number): number {
  const factor = 10 ** digits
  return Math.round(value * factor) / factor
}

/**
 * Map a `score` answer's legend indices to their labels, skipping entries whose
 * key is not an integer or whose label is not a string.
 * @param legend - raw `legend` value from an answer.
 * @returns labels keyed by integer index, or `undefined` when nothing usable was found.
 */
function legendLabels(legend: unknown): Map<number, string> | undefined {
  const record = asRecord(legend)
  if (record === undefined) return undefined
  const labels = new Map<number, string>()
  for (const [key, value] of Object.entries(record)) {
    const index = Number(key)
    const label = asString(value)
    if (Number.isInteger(index) && label !== undefined) labels.set(index, label)
  }
  return labels.size > 0 ? labels : undefined
}

/**
 * Describe one Jev answer as a single summary line.
 *
 * The answer is recognised by its distinctive field — `noul`, `choice`, then
 * `score` — rather than by its `type` tag, so a response that omits the tag still
 * renders. `choice` and `score` degrade field by field: a missing probability,
 * legend, or confidence only drops that part of the line.
 * @param answer - raw answer value from a canonical envelope.
 * @returns the summary text, or `undefined` when the answer carries none of the three fields.
 */
export function describeAnswer(answer: unknown): string | undefined {
  const record = asRecord(answer)
  if (record === undefined) return undefined

  const noul = asNumber(record['noul'])
  if (noul !== undefined) {
    return `noul: ${noul >= 0.5 ? 'yes' : 'no'}, p=${round(noul, 3)} (${Math.round(noul * 100)}%)`
  }

  const choice = asString(record['choice'])
  if (choice !== undefined) {
    const parts: string[] = []
    const probabilities = asRecord(record['probabilities'])
    const probability = probabilities === undefined ? undefined : asNumber(probabilities[choice])
    if (probability !== undefined) parts.push(`p=${round(probability, 3)}`)
    const confidence = asNumber(record['confidence'])
    if (confidence !== undefined) parts.push(`confidence=${round(confidence, 3)}`)
    return parts.length === 0 ? `choice: ${choice}` : `choice: ${choice} (${parts.join(', ')})`
  }

  const score = asNumber(record['score'])
  if (score !== undefined) {
    const labels = legendLabels(record['legend'])
    const top = labels === undefined ? undefined : Math.max(...labels.keys())
    const label = labels?.get(Math.round(score))
    const head = top === undefined
      ? `score: ${round(score, 2)}`
      : `score: ${round(score, 2)}/${top}`
    const withLabel = label === undefined ? head : `${head} = ${label}`
    const confidence = asNumber(record['confidence'])
    return confidence === undefined ? withLabel : `${withLabel} (confidence=${round(confidence, 3)})`
  }

  return undefined
}

/**
 * Build the summary lines for a canonical envelope.
 * @param value - canonical `jev_decide` or `jev_evaluate` output.
 * @returns one line per answer, or an empty list when nothing is describable.
 */
function summaryLines(value: JsonValue): string[] {
  const envelope = asRecord(value)
  if (envelope === undefined) return []

  if (envelope['answer'] !== undefined) {
    const description = describeAnswer(envelope['answer'])
    return description === undefined ? [] : [description]
  }

  const answers = asRecord(envelope['answers'])
  if (answers === undefined) return []
  return Object.entries(answers).map(
    ([id, answer]) => `${id}: ${describeAnswer(answer) ?? '(unrecognized answer)'}`,
  )
}

/**
 * Render a canonical Jev envelope as a summary followed by its canonical JSON.
 *
 * `output.render` is a display path that must not throw, so every failure here
 * degrades instead: an envelope whose answers are absent or unrecognised renders
 * as the canonical JSON alone, which the model can still read in full.
 * @param value - canonical envelope from `jev_decide` or `jev_evaluate`.
 * @returns exactly one text block.
 */
export function renderDecision(value: JsonValue): TextContentBlock[] {
  const json = JSON.stringify(value, null, 2)
  const lines = summaryLines(value)
  return [{ type: 'text', text: lines.length === 0 ? json : `${lines.join('\n')}\n\n${json}` }]
}
