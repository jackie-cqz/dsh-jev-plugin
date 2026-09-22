/**
 * Derive decision-card models from a Jev tool result's content blocks.
 *
 * The host hands a tool-row component the result's durable content blocks, and
 * this plugin's rendered text is a one-line summary followed by the canonical
 * envelope, so the envelope is recoverable here without any extra host-side
 * metadata channel. Everything below is pure: the React half only lays out what
 * these functions return.
 *
 * @module dsh-jev/client/cards
 */

/** One option row of a `choice` card. */
export interface CardOption {
  /** Candidate label. */
  label: string
  /** Probability the answer assigned it, within `[0, 1]`. */
  probability: number
}

/** What a decision card renders. Free of React so it can be tested in Node. */
export type CardModel =
  | { kind: 'pending' }
  | { kind: 'noul'; id: string; probability: number }
  | {
    kind: 'choice'
    id: string
    chosen: string
    confidence?: number
    options: readonly CardOption[]
  }
  | {
    kind: 'score'
    id: string
    score: number
    max: number
    level?: string
    confidence?: number
  }

/** Whether a value is a plain object. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Concatenate the text blocks of a tool result. */
function textOf(content: readonly unknown[]): string {
  const parts: string[] = []
  for (const block of content) {
    if (!isRecord(block)) continue
    if (block['type'] === 'text' && typeof block['text'] === 'string') parts.push(block['text'])
  }
  return parts.join('\n')
}

/**
 * Recover the canonical envelope from rendered text.
 *
 * The summary line precedes the envelope, so the widest brace-delimited span is
 * the candidate; a span that does not parse yields nothing rather than a throw.
 * @param text - concatenated text blocks.
 * @returns the parsed envelope, or `undefined` when none is recoverable.
 */
function parseEnvelope(text: string): Record<string, unknown> | undefined {
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start === -1 || end <= start) return undefined
  try {
    const parsed: unknown = JSON.parse(text.slice(start, end + 1))
    return isRecord(parsed) ? parsed : undefined
  } catch {
    // A truncated or interleaved envelope is not a card: fall back to the
    // generic row instead of guessing at partial content.
    return undefined
  }
}

/** Read a value that must be a probability in `[0, 1]`. */
function probabilityOf(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1
    ? value
    : undefined
}

/**
 * Build one card's options, highest probability first.
 *
 * A chosen label missing from the distribution is added at its recorded
 * probability so the card never claims a label the model did not pick.
 * @param probabilities - distribution as reported by the answer.
 * @param chosen - the selected label.
 * @returns options in descending probability, ties broken by label.
 */
function optionsOf(probabilities: unknown, chosen: string): CardOption[] {
  const options: CardOption[] = []
  if (isRecord(probabilities)) {
    for (const [label, value] of Object.entries(probabilities)) {
      const probability = probabilityOf(value)
      if (probability !== undefined) options.push({ label, probability })
    }
  }
  if (!options.some(option => option.label === chosen)) {
    const recorded = isRecord(probabilities) ? probabilityOf(probabilities[chosen]) : undefined
    options.push({ label: chosen, probability: recorded ?? 0 })
  }
  return options.sort((left, right) => right.probability - left.probability
    || (left.label < right.label ? -1 : left.label > right.label ? 1 : 0))
}

/** Derive a `score` card. */
function scoreModel(id: string, answer: Record<string, unknown>): CardModel | undefined {
  const score = answer['score']
  if (typeof score !== 'number' || !Number.isFinite(score)) return undefined
  const legend = answer['legend']
  let max = 0
  let level: string | undefined
  if (isRecord(legend)) {
    for (const key of Object.keys(legend)) {
      const index = Number(key)
      if (Number.isInteger(index) && index > max) max = index
    }
    const label = legend[String(Math.round(score))]
    if (typeof label === 'string') level = label
  }
  const confidence = probabilityOf(answer['confidence'])
  return {
    kind: 'score',
    id,
    score,
    max,
    ...level === undefined ? {} : { level },
    ...confidence === undefined ? {} : { confidence },
  }
}

/** Derive one card from one answer. */
function answerModel(id: string, raw: unknown): CardModel | undefined {
  if (!isRecord(raw)) return undefined
  switch (raw['type']) {
    case 'noul': {
      const probability = probabilityOf(raw['noul'])
      return probability === undefined ? undefined : { kind: 'noul', id, probability }
    }
    case 'choice': {
      const chosen = raw['choice']
      if (typeof chosen !== 'string' || chosen === '') return undefined
      const confidence = probabilityOf(raw['confidence'])
      return {
        kind: 'choice',
        id,
        chosen,
        options: optionsOf(raw['probabilities'], chosen),
        ...confidence === undefined ? {} : { confidence },
      }
    }
    case 'score':
      return scoreModel(id, raw)
    default:
      return undefined
  }
}

/**
 * Derive the cards for one finished Jev call.
 * @param content - the result's content blocks; the shape is treated as unknown.
 * @param isError - whether the result failed; a failure is never card-rendered.
 * @returns one model per answer, or an empty list when this plugin has nothing
 * to visualise and the host should keep its generic tool row instead.
 */
export function toCardModels(content: readonly unknown[], isError: boolean): readonly CardModel[] {
  // An empty list means "this card does not take over": rendering a placeholder
  // in place of the host's generic row would only add noise.
  if (isError) return []
  const envelope = parseEnvelope(textOf(content))
  if (envelope === undefined) return []

  const answers = envelope['answers']
  if (isRecord(answers)) {
    const ids = Object.keys(answers)
    if (ids.length === 0) return []
    return ids
      .map(id => answerModel(id, answers[id]))
      .filter((model): model is CardModel => model !== undefined)
  }

  const single = envelope['answer']
  const derived = isRecord(single) ? answerModel('decision', single) : undefined
  return derived === undefined ? [] : [derived]
}

/**
 * Derive the cards from the host's presentation metadata.
 *
 * This is the primary path: the tools project a `JevCardMeta` onto every result,
 * so the client reads structured answers rather than re-parsing rendered text.
 * `meta.answers` is empty when the host had nothing to project, which means
 * "no card" — the host then keeps its generic tool row.
 * @param meta - the projected metadata; its shape is treated as unknown.
 * @param isError - whether the result failed; a failure is never card-rendered.
 * @returns one model per answer, or an empty list when there is nothing to show.
 */
export function cardsFromMeta(meta: unknown, isError: boolean): readonly CardModel[] {
  if (isError) return []
  if (!isRecord(meta)) return []
  const answers = meta['answers']
  if (!Array.isArray(answers) || answers.length === 0) return []
  return answers
    .map(entry => metaAnswerModel(entry))
    .filter((model): model is CardModel => model !== undefined)
}

/** Derive one card from one projected answer. */
function metaAnswerModel(raw: unknown): CardModel | undefined {
  if (!isRecord(raw)) return undefined
  const id = raw['id']
  if (typeof id !== 'string' || id === '') return undefined
  switch (raw['kind']) {
    case 'noul': {
      const probability = probabilityOf(raw['probability'])
      return probability === undefined ? undefined : { kind: 'noul', id, probability }
    }
    case 'choice': {
      const chosen = raw['chosen']
      if (typeof chosen !== 'string' || chosen === '') return undefined
      const confidence = probabilityOf(raw['confidence'])
      return {
        kind: 'choice',
        id,
        chosen,
        options: optionsOf(raw['probabilities'], chosen),
        ...confidence === undefined ? {} : { confidence },
      }
    }
    case 'score': {
      const score = raw['score']
      if (typeof score !== 'number' || !Number.isFinite(score)) return undefined
      return scoreModel(id, raw)
    }
    default:
      return undefined
  }
}

/** The id a single-answer envelope is rendered under. */
export const SINGLE_ANSWER_ID = 'decision'
