/** Tool-argument and Jev-response validation shared by both Jev tools. @module dsh-jev/validation */

import { JevValidationError } from './errors.ts'
import type {
  ChoiceAnswer,
  DecideEnvelope,
  EvaluateEnvelope,
  JevAnswer,
  JevQuestions,
  JevResponse,
  JevState,
  JevUsage,
  NoulAnswer,
  ScoreAnswer,
} from './protocol.ts'

/** Choice questions carry at most 255 labels (TypeSafe API limit). */
const MAX_CHOICE_OPTIONS = 255

/** Score questions carry at most 10 ordered levels (TypeSafe API limit). */
const MAX_SCORE_LEVELS = 10

/** Either option list needs at least two entries to express a decision. */
const MIN_OPTIONS = 2

/**
 * Test whether a value is a JSON object rather than an array or class instance.
 * @param value - candidate read from tool arguments or a Jev response.
 * @returns True only for objects whose prototype is `Object.prototype` or null.
 */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null) return false
  const prototype: unknown = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

/**
 * Name the received type for an actionable failure message.
 * @param value - rejected value.
 * @returns A short article phrase such as `a string` or `an instance of Date`.
 */
function describeValue(value: unknown): string {
  if (value === null) return 'null'
  if (Array.isArray(value)) return 'an array'
  if (typeof value === 'string') return 'a string'
  if (typeof value === 'number') return 'a number'
  if (typeof value === 'boolean') return 'a boolean'
  if (typeof value === 'undefined') return 'undefined'
  if (typeof value === 'function') return 'a function'
  if (typeof value === 'symbol') return 'a symbol'
  if (typeof value === 'bigint') return 'a bigint'
  const constructor = (value as { constructor?: unknown }).constructor
  return typeof constructor === 'function' && constructor.name !== ''
    ? `an instance of ${constructor.name}`
    : 'a non-plain object'
}

/**
 * Require a plain-object value, reporting the field path and the received type.
 * @param value - candidate value.
 * @param path - dotted field path used in the failure message.
 * @returns The value narrowed to a JSON object.
 * @throws JevValidationError when `value` is not a plain object.
 */
function requirePlainObject(value: unknown, path: string): Record<string, unknown> {
  if (!isPlainObject(value)) {
    throw new JevValidationError(`${path} must be a JSON object; received ${describeValue(value)}.`)
  }
  return value
}

/**
 * Require an array value, reporting the field path and the received type.
 * @param value - candidate value.
 * @param path - field path used in the failure message.
 * @returns The array as read-only unknown items.
 * @throws JevValidationError when `value` is not an array.
 */
function requireArray(value: unknown, path: string): readonly unknown[] {
  if (!Array.isArray(value)) {
    throw new JevValidationError(`${path} must be an array; received ${describeValue(value)}.`)
  }
  return value as readonly unknown[]
}

/**
 * Read a required field, distinguishing an absent field from a mistyped one.
 * @param record - validated response object.
 * @param key - field name to read.
 * @param path - dotted field path used in the failure message.
 * @returns The field value.
 * @throws JevValidationError when the field is absent.
 */
function requireField(record: Record<string, unknown>, key: string, path: string): unknown {
  const value = record[key]
  if (value === undefined) {
    throw new JevValidationError(`${path} is missing; the Jev response must include ${path}.`)
  }
  return value
}

/**
 * Require a non-empty string field.
 * @param value - candidate field value.
 * @param path - dotted field path used in the failure message.
 * @returns The original string.
 * @throws JevValidationError when the value is not a string or is blank.
 */
function requireNonEmptyString(value: unknown, path: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new JevValidationError(`${path} must be a non-empty string; received ${describeValue(value)}.`)
  }
  return value
}

/**
 * Require one non-empty string label.
 * @param value - candidate array element.
 * @param index - element position used in the failure message.
 * @returns The label unchanged.
 * @throws JevValidationError when the element is not a string or is blank.
 */
function requireOptionLabel(value: unknown, index: number): string {
  if (typeof value !== 'string') {
    throw new JevValidationError(`options[${index}] must be a non-empty string; received ${describeValue(value)}.`)
  }
  if (value.trim() === '') {
    throw new JevValidationError(`options[${index}] must be a non-empty string; received a blank string.`)
  }
  return value
}

/**
 * Validate the `usage` object both envelopes expose. The token counts are
 * checked because {@link JevUsage} promises them as numbers.
 * @param value - candidate `usage` field.
 * @param path - dotted field path used in the failure message.
 * @returns The value asserted as {@link JevUsage}.
 * @throws JevValidationError when `usage` is not an object or a token count is not a number.
 */
function requireUsage(value: unknown, path: string): JevUsage {
  const usage = requirePlainObject(value, path)
  const inputTokens = usage['input_tokens']
  const outputTokens = usage['output_tokens']
  if (typeof inputTokens !== 'number') {
    throw new JevValidationError(`${path}.input_tokens must be a number; received ${describeValue(inputTokens)}.`)
  }
  if (typeof outputTokens !== 'number') {
    throw new JevValidationError(`${path}.output_tokens must be a number; received ${describeValue(outputTokens)}.`)
  }
  return usage as unknown as JevUsage
}

/**
 * Require a finite number, naming the received value so `NaN` and `Infinity`
 * are distinguishable from a wrong type.
 * @param value - candidate field value.
 * @param path - dotted field path used in the failure message.
 * @returns The original number.
 * @throws JevValidationError when the value is not a finite number.
 */
function requireFiniteNumber(value: unknown, path: string): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  const received = typeof value === 'number' ? String(value) : describeValue(value)
  throw new JevValidationError(`${path} must be a finite number; received ${received}.`)
}

/**
 * Require a finite number inside the closed unit interval.
 * @param value - candidate field value.
 * @param path - dotted field path used in the failure message.
 * @returns The original number.
 * @throws JevValidationError when the value is not a finite number in `[0, 1]`.
 */
function requireUnitInterval(value: unknown, path: string): number {
  if (typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1) return value
  const received = typeof value === 'number' ? String(value) : describeValue(value)
  throw new JevValidationError(`${path} must be a finite number between 0 and 1; received ${received}.`)
}

/**
 * Require an object whose every value is a number.
 * @param value - candidate field value.
 * @param path - dotted field path used in the failure message.
 * @returns The value asserted as a number map.
 * @throws JevValidationError when the value is not a plain object or holds a non-number entry.
 */
function requireNumberRecord(value: unknown, path: string): Record<string, number> {
  const record = requirePlainObject(value, path)
  for (const [key, entry] of Object.entries(record)) {
    if (typeof entry !== 'number') {
      throw new JevValidationError(`${path}.${key} must be a number; received ${describeValue(entry)}.`)
    }
  }
  return record as Record<string, number>
}

/**
 * Require an object whose every value is a string.
 * @param value - candidate field value.
 * @param path - dotted field path used in the failure message.
 * @returns The value asserted as a string map.
 * @throws JevValidationError when the value is not a plain object or holds a non-string entry.
 */
function requireStringRecord(value: unknown, path: string): Record<string, string> {
  const record = requirePlainObject(value, path)
  for (const [key, entry] of Object.entries(record)) {
    if (typeof entry !== 'string') {
      throw new JevValidationError(`${path}.${key} must be a string; received ${describeValue(entry)}.`)
    }
  }
  return record as Record<string, string>
}

/** Answer kinds the TypeSafe API can return for one question. */
type AnswerKind = 'noul' | 'choice' | 'score'

/**
 * Require the answer's `type` discriminant, quoting the received value so a
 * wrong kind is reported as the kind rather than as "a string".
 * @param record - validated answer object.
 * @param expected - discriminant the caller can interpret.
 * @param path - dotted field path used in the failure message.
 * @throws JevValidationError when `type` is absent or names a different kind.
 */
function requireAnswerType(record: Record<string, unknown>, expected: AnswerKind, path: string): void {
  const type = record['type']
  if (type === expected) return
  const received = typeof type === 'string' ? `"${type}"` : describeValue(type)
  throw new JevValidationError(`${path}.type must be "${expected}"; received ${received}.`)
}

/**
 * Validate the `state` argument's top-level JSON type. Nested values pass
 * through unvalidated: deep validation belongs to the TypeSafe API.
 * @param value - raw tool argument.
 * @returns The same value, asserted as {@link JevState}.
 * @throws JevValidationError when `value` is null, a number, a boolean, a function, or a class instance.
 */
export function validateState(value: unknown): JevState {
  if (typeof value === 'string') return value
  if (Array.isArray(value)) return value as unknown as JevState
  if (isPlainObject(value)) return value as unknown as JevState
  throw new JevValidationError(
    `state must be a string, an array, or a plain object; received ${describeValue(value)}. `
    + 'Send the text, JSON object, or JSON array to judge.',
  )
}

/** Question kinds the TypeSafe API accepts. */
const QUESTION_TYPES = ['noul', 'choice', 'score'] as const

/** One accepted question kind. */
type QuestionType = (typeof QUESTION_TYPES)[number]

/** The accepted kinds, quoted for a failure message. */
const QUESTION_TYPE_LIST = QUESTION_TYPES.map(type => `"${type}"`).join(', ')

/**
 * Test whether a value names an accepted question kind.
 * @param value - candidate `type` field.
 * @returns True for `noul`, `choice`, or `score`.
 */
function isQuestionType(value: unknown): value is QuestionType {
  return typeof value === 'string' && (QUESTION_TYPES as readonly string[]).includes(value)
}

/**
 * Quote a string literal, or name the received type when it is not one.
 * @param value - rejected value.
 * @returns A quoted string, or a phrase such as `a number`.
 */
function describeLiteral(value: unknown): string {
  return typeof value === 'string' ? `"${value}"` : describeValue(value)
}

/**
 * Require a non-empty string, naming a blank value as blank rather than as "a string".
 * @param value - candidate field value.
 * @param path - dotted field path used in the failure message.
 * @returns The original string.
 * @throws JevValidationError when the value is not a string or is blank.
 */
function requireQuestionText(value: unknown, path: string): string {
  if (typeof value !== 'string') {
    throw new JevValidationError(`${path} must be a non-empty string; received ${describeValue(value)}.`)
  }
  if (value.trim() === '') {
    throw new JevValidationError(`${path} must be a non-empty string; received a blank string.`)
  }
  return value
}

/**
 * Require one question field, distinguishing absence from a mistyped value.
 * @param question - validated question object.
 * @param key - field name to read.
 * @param path - dotted field path used in the failure message.
 * @returns The field value.
 * @throws JevValidationError when the field is absent.
 */
function requireQuestionField(question: Record<string, unknown>, key: string, path: string): unknown {
  const value = question[key]
  if (value === undefined) {
    throw new JevValidationError(`${path} is missing; every question needs ${path}.`)
  }
  return value
}

/**
 * Require a rubric map whose values are rubric strings or `null`.
 * @param value - candidate `criteria` field.
 * @param path - dotted field path used in the failure message.
 * @returns The rubric map.
 * @throws JevValidationError when the map or one of its values has the wrong type.
 */
function requireRubric(value: unknown, path: string): Record<string, string | null> {
  const rubric = requirePlainObject(value, path)
  for (const label of Object.keys(rubric)) {
    const text = rubric[label]
    if (text !== null && typeof text !== 'string') {
      throw new JevValidationError(`${path}.${label} must be a string or null; received ${describeValue(text)}.`)
    }
  }
  return rubric as Record<string, string | null>
}

/**
 * Validate one question against the shape its `type` requires.
 * Reads the question without rewriting it, so the caller's object passes through unchanged.
 * @param value - one entry of the questions map.
 * @param path - dotted field path used in failure messages, such as `questions.department`.
 * @throws JevValidationError when the question is not an object, lacks `instructions`, names an
 * unknown `type`, or carries `criteria` of the wrong shape for that type.
 */
function validateQuestion(value: unknown, path: string): void {
  const question = requirePlainObject(value, path)
  const type = requireQuestionField(question, 'type', `${path}.type`)
  if (!isQuestionType(type)) {
    throw new JevValidationError(
      `${path}.type must be one of ${QUESTION_TYPE_LIST}; received ${describeLiteral(type)}.`,
    )
  }
  requireQuestionText(requireQuestionField(question, 'instructions', `${path}.instructions`), `${path}.instructions`)

  const criteria = question['criteria']
  if (type === 'noul') {
    // A `noul` rubric is optional and keyed by the yes/no reading, so only its values are checked.
    if (criteria !== undefined) requireRubric(criteria, `${path}.criteria`)
    return
  }
  if (criteria === undefined) {
    throw new JevValidationError(`${path}.criteria is missing; a ${type} question needs ${path}.criteria.`)
  }
  if (type === 'choice') {
    const labels = Object.keys(requireRubric(criteria, `${path}.criteria`))
    if (labels.length < MIN_OPTIONS || labels.length > MAX_CHOICE_OPTIONS) {
      throw new JevValidationError(
        `${path}.criteria must contain between ${MIN_OPTIONS} and ${MAX_CHOICE_OPTIONS} labels;`
        + ` received ${labels.length}.`,
      )
    }
    return
  }
  const levels = requireArray(criteria, `${path}.criteria`)
  if (levels.length < MIN_OPTIONS || levels.length > MAX_SCORE_LEVELS) {
    throw new JevValidationError(
      `${path}.criteria must contain between ${MIN_OPTIONS} and ${MAX_SCORE_LEVELS} ordered levels;`
      + ` received ${levels.length}.`,
    )
  }
  for (let index = 0; index < levels.length; index++) {
    requireQuestionText(levels[index], `${path}.criteria[${index}]`)
  }
}

/**
 * Validate the `questions` map and every question in it.
 * Each question must carry an accepted `type`, non-empty `instructions`, and the
 * `criteria` its type requires. The map passes through by reference: nothing is
 * copied, reordered, or rewritten, because `jev_evaluate` forwards it verbatim.
 * @param value - raw tool argument.
 * @returns The same object, asserted as {@link JevQuestions}.
 * @throws JevValidationError when the map is empty, an entry is not a question
 * object, or any question field has the wrong shape.
 */
export function validateQuestions(value: unknown): JevQuestions {
  const questions = requirePlainObject(value, 'questions')
  const ids = Object.keys(questions)
  if (ids.length === 0) {
    throw new JevValidationError('questions must contain at least one question; received an empty object.')
  }
  for (const id of ids) {
    validateQuestion(questions[id], `questions.${id}`)
  }
  return questions as unknown as JevQuestions
}

/**
 * Validate `choice` labels: non-empty strings de-duplicated in first-seen order,
 * between 2 and 255 entries after de-duplication.
 * @param value - raw `options` argument.
 * @returns The de-duplicated labels.
 * @throws JevValidationError when `options` is not an array, holds a non-string or blank label, or falls outside 2–255 entries.
 */
export function validateChoiceOptions(value: unknown): string[] {
  const items = requireArray(value, 'options')
  const seen = new Set<string>()
  const labels: string[] = []
  for (let index = 0; index < items.length; index++) {
    const label = requireOptionLabel(items[index], index)
    if (seen.has(label)) continue
    seen.add(label)
    labels.push(label)
  }
  if (labels.length < MIN_OPTIONS) {
    throw new JevValidationError(
      `options must contain at least ${MIN_OPTIONS} distinct non-empty labels; received ${labels.length}`
      + ` after de-duplication (${JSON.stringify(labels)}).`,
    )
  }
  if (labels.length > MAX_CHOICE_OPTIONS) {
    throw new JevValidationError(
      `options must contain at most ${MAX_CHOICE_OPTIONS} labels; received ${labels.length} after de-duplication.`,
    )
  }
  return labels
}

/**
 * Validate `score` levels: non-empty strings, between 2 and 10 entries. Duplicate
 * levels are kept because the API reads them positionally.
 * @param value - raw `options` argument.
 * @returns The levels unchanged.
 * @throws JevValidationError when `options` is not an array, holds a non-string or blank level, or falls outside 2–10 entries.
 */
export function validateScoreOptions(value: unknown): string[] {
  const items = requireArray(value, 'options')
  const levels: string[] = []
  for (let index = 0; index < items.length; index++) {
    levels.push(requireOptionLabel(items[index], index))
  }
  if (levels.length < MIN_OPTIONS) {
    throw new JevValidationError(
      `options must contain at least ${MIN_OPTIONS} ordered levels; received ${levels.length} (${JSON.stringify(levels)}).`,
    )
  }
  if (levels.length > MAX_SCORE_LEVELS) {
    throw new JevValidationError(
      `options must contain at most ${MAX_SCORE_LEVELS} ordered levels; received ${levels.length}.`,
    )
  }
  return levels
}

/**
 * Validate a raw `POST /systemone` response body.
 * @param value - parsed JSON body of the API call.
 * @returns The body with `model`, `answers`, and `usage` validated.
 * @throws JevValidationError when the body is not a plain object, `model` is blank,
 * `usage` token counts are not numbers, or `answers` is absent, empty, or holds a
 * non-object answer.
 */
export function toJevResponse(value: unknown): JevResponse {
  const body = requirePlainObject(value, 'response')
  const model = requireNonEmptyString(requireField(body, 'model', 'model'), 'model')
  const usage = requireUsage(requireField(body, 'usage', 'usage'), 'usage')
  const answers = requirePlainObject(requireField(body, 'answers', 'answers'), 'answers')
  const ids = Object.keys(answers)
  if (ids.length === 0) {
    throw new JevValidationError('answers must contain at least one question result; received an empty object.')
  }
  for (const id of ids) {
    requirePlainObject(answers[id], `answers.${id}`)
  }
  return { model, answers: answers as Record<string, JevAnswer>, usage }
}

/**
 * Build the `jev_decide` envelope from a raw Jev response. `model`, `usage`, and
 * the `answers.decision` answer are the plugin's stable promise to the model, so
 * a missing or mistyped one fails the call instead of degrading the result.
 * @param response - parsed JSON body of `POST /systemone`.
 * @returns The envelope `{ model, answer, usage }`, where `answer` is `answers.decision`.
 * @throws JevValidationError when `model`, `usage`, `answers`, or `answers.decision` is absent or mistyped.
 */
export function toDecideEnvelope(response: unknown): DecideEnvelope {
  // The decision answer is read before delegating so that a response omitting it
  // reports the `answers.decision` field path, which a caller can act on, instead
  // of the empty-answers message `toJevResponse` raises for the same body.
  const body = requirePlainObject(response, 'response')
  const answers = requirePlainObject(requireField(body, 'answers', 'answers'), 'answers')
  const answer = requirePlainObject(requireField(answers, 'decision', 'answers.decision'), 'answers.decision')
  const { model, usage } = toJevResponse(response)
  return { model, answer: answer as JevAnswer, usage }
}

/**
 * Build the `jev_evaluate` envelope from a raw Jev response, passing `answers`
 * through unchanged.
 * @param response - parsed JSON body of `POST /systemone`.
 * @returns The envelope `{ model, answers, usage }`.
 * @throws JevValidationError when `model`, `usage`, or `answers` is absent or mistyped, `answers` is empty, or an answer is not a plain object.
 */
export function toEvaluateEnvelope(response: unknown): EvaluateEnvelope {
  const { model, answers, usage } = toJevResponse(response)
  return { model, answers, usage }
}

/** Field path used when an answer is validated on its own rather than inside a response. */
const ANSWER_PATH = 'answer'

/**
 * Narrow one answer to the `noul` variant.
 * @param value - candidate answer, typically one entry of a response's `answers`.
 * @returns The answer reduced to `{ type, noul }`.
 * @throws JevValidationError when the answer is not a plain object, is not of type
 * `noul`, or `noul` is not a finite number inside `[0, 1]`.
 */
export function toNoulAnswer(value: unknown): NoulAnswer {
  const answer = requirePlainObject(value, ANSWER_PATH)
  requireAnswerType(answer, 'noul', ANSWER_PATH)
  const path = `${ANSWER_PATH}.noul`
  return { type: 'noul', noul: requireUnitInterval(requireField(answer, 'noul', path), path) }
}

/**
 * Narrow one answer to the `choice` variant.
 * @param value - candidate answer, typically one entry of a response's `answers`.
 * @returns The answer reduced to `{ type, choice, probabilities, confidence }`.
 * @throws JevValidationError when the answer is not a plain object, is not of type
 * `choice`, `choice` is blank, `probabilities` is not a number map carrying the
 * chosen label, or `confidence` is not a finite number inside `[0, 1]`.
 */
export function toChoiceAnswer(value: unknown): ChoiceAnswer {
  const answer = requirePlainObject(value, ANSWER_PATH)
  requireAnswerType(answer, 'choice', ANSWER_PATH)

  const choicePath = `${ANSWER_PATH}.choice`
  const choice = requireNonEmptyString(requireField(answer, 'choice', choicePath), choicePath)

  const probabilitiesPath = `${ANSWER_PATH}.probabilities`
  const probabilities = requireNumberRecord(requireField(answer, 'probabilities', probabilitiesPath), probabilitiesPath)
  if (!Object.hasOwn(probabilities, choice)) {
    throw new JevValidationError(`${probabilitiesPath} must carry the chosen label "${choice}".`)
  }

  const confidencePath = `${ANSWER_PATH}.confidence`
  const confidence = requireUnitInterval(requireField(answer, 'confidence', confidencePath), confidencePath)
  return { type: 'choice', choice, probabilities, confidence }
}

/**
 * Narrow one answer to the `score` variant.
 * @param value - candidate answer, typically one entry of a response's `answers`.
 * @returns The answer reduced to `{ type, score, legend?, probabilities, confidence }`,
 * omitting `legend` when the API did not send one.
 * @throws JevValidationError when the answer is not a plain object, is not of type
 * `score`, `score` is not a finite number, `confidence` is not a finite number
 * inside `[0, 1]`, `probabilities` is not a number map, or a present `legend` is
 * not a string map.
 */
export function toScoreAnswer(value: unknown): ScoreAnswer {
  const answer = requirePlainObject(value, ANSWER_PATH)
  requireAnswerType(answer, 'score', ANSWER_PATH)

  const scorePath = `${ANSWER_PATH}.score`
  const score = requireFiniteNumber(requireField(answer, 'score', scorePath), scorePath)

  const probabilitiesPath = `${ANSWER_PATH}.probabilities`
  const probabilities = requireNumberRecord(requireField(answer, 'probabilities', probabilitiesPath), probabilitiesPath)

  const confidencePath = `${ANSWER_PATH}.confidence`
  const confidence = requireUnitInterval(requireField(answer, 'confidence', confidencePath), confidencePath)

  const legend = answer['legend']
  if (legend === undefined) return { type: 'score', score, probabilities, confidence }
  return { type: 'score', score, legend: requireStringRecord(legend, `${ANSWER_PATH}.legend`), probabilities, confidence }
}
