/** TypeSafe Jev request/response protocol types. @module dsh-jev/protocol */

import type { JsonValue } from '@deepseek-ai/dsh-util-values'

/** State accepted by the Jev API. */
export type JevState = string | JsonValue[] | { [key: string]: JsonValue }

/** Rubric map keyed by label; `null` means "no rubric text for this label". */
export type JevCriteria = Record<string, string | null>

/** `noul` question: a yes/no decision answered with a 0–1 probability. */
export interface NoulQuestion {
  type: 'noul'
  instructions: string
  /** Optional rubric keyed by the `true` / `false` reading of the question. */
  criteria?: JevCriteria
}

/** `choice` question: pick one label, answered with a probability distribution. */
export interface ChoiceQuestion {
  type: 'choice'
  instructions: string
  /** Candidate labels, at most 255. */
  criteria: JevCriteria
}

/** `score` question: place the state on ordered levels. */
export interface ScoreQuestion {
  type: 'score'
  instructions: string
  /** Ordered levels from lowest to highest, at most 10. */
  criteria: string[]
}

/** One TypeSafe question. */
export type JevQuestion = NoulQuestion | ChoiceQuestion | ScoreQuestion

/** Question map keyed by answer id. */
export type JevQuestions = Record<string, JevQuestion>

/** Request body for `POST {baseURL}/systemone`. */
export interface SystemOneRequest {
  model: string
  state: JevState
  questions: JevQuestions
}

/** One TypeSafe answer object. */
export type JevAnswer = { [key: string]: JsonValue }

/**
 * Jev token usage object.
 * The response types below are type aliases rather than interfaces so they keep
 * an implicit index signature and satisfy `JsonValue` where a tool returns them.
 */
export type JevUsage = Record<string, JsonValue> & {
  input_tokens: number
  output_tokens: number
}

/** Raw Jev response. */
export type JevResponse = {
  model: string
  answers: Record<string, JevAnswer>
  usage: JevUsage
}

/** `jev_decide` canonical output envelope. */
export type DecideEnvelope = {
  model: string
  answer: JevAnswer
  usage: JevUsage
}

/** `jev_evaluate` canonical output envelope. */
export type EvaluateEnvelope = {
  model: string
  answers: Record<string, JevAnswer>
  usage: JevUsage
}

/**
 * `noul` answer: a yes/no decision answered with a 0-1 probability.
 * These three answer types are type aliases rather than interfaces because an
 * interface carries no implicit index signature and therefore cannot satisfy
 * `JsonValue`.
 */
export type NoulAnswer = {
  type: 'noul'
  noul: number
}

/** `choice` answer: the chosen label, its probability distribution, and confidence. */
export type ChoiceAnswer = {
  type: 'choice'
  choice: string
  probabilities: Record<string, number>
  confidence: number
}

/** `score` answer: the level position, its legend, distribution, and confidence. */
export type ScoreAnswer = {
  type: 'score'
  score: number
  /** Level labels by stringified index; absent when the API omits it. */
  legend?: Record<string, string>
  probabilities: Record<string, number>
  confidence: number
}

/** One of the three typed answers. */
export type TypedJevAnswer = NoulAnswer | ChoiceAnswer | ScoreAnswer
