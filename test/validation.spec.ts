import { describe, expect, it } from 'vitest'
import { JevValidationError } from '../src/errors.ts'
import {
  toChoiceAnswer,
  toDecideEnvelope,
  toEvaluateEnvelope,
  toJevResponse,
  toNoulAnswer,
  toScoreAnswer,
  validateChoiceOptions,
  validateQuestions,
  validateScoreOptions,
  validateState,
} from '../src/validation.ts'

/** Build a raw `POST /systemone` body, overriding individual fields per case. */
function decideResponse(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    model: 'jev-1.13.0',
    answers: { decision: { type: 'noul', noul: 0.93 } },
    usage: { input_tokens: 312, output_tokens: 20 },
    ...overrides,
  }
}

/** Build a raw multi-question `POST /systemone` body, overriding fields per case. */
function evaluateResponse(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    model: 'jev-1.13.0',
    answers: {
      department: { type: 'choice', choice: 'technical', confidence: 0.78 },
      is_urgent: { type: 'noul', noul: 1 },
    },
    usage: { input_tokens: 392, output_tokens: 65 },
    ...overrides,
  }
}

describe('validateState', () => {
  it('returns a string state unchanged', () => {
    expect(validateState('Help! My payouts have been failing.')).toBe('Help! My payouts have been failing.')
  })

  it('returns an array state by reference', () => {
    const state = [{ role: 'user' }, 'payouts failing', 7, null]
    expect(validateState(state)).toBe(state)
  })

  it('returns a plain object state by reference', () => {
    const state = { ticket: 'payouts failing', days: 3 }
    expect(validateState(state)).toBe(state)
  })

  it('accepts a null-prototype object', () => {
    const state: Record<string, unknown> = Object.create(null)
    state['ticket'] = 'payouts failing'
    expect(validateState(state)).toBe(state)
  })

  const rejected: Array<[label: string, value: unknown]> = [
    ['null', null],
    ['a number', 7],
    ['a boolean', true],
    ['undefined', undefined],
    ['a function', (): void => {}],
    ['a class instance', new Date()],
  ]

  it.each(rejected)('rejects %s and names the state field', (_label, value) => {
    expect(() => validateState(value)).toThrow(JevValidationError)
    expect(() => validateState(value)).toThrow(/state/)
  })
})

describe('validateQuestions', () => {
  it('returns the question map by reference', () => {
    const questions = { decision: { type: 'noul', instructions: 'Is this urgent?' } }
    expect(validateQuestions(questions)).toBe(questions)
  })

  const rejected: Array<[label: string, value: unknown]> = [
    ['null', null],
    ['an array', []],
    ['a string', 'x'],
    ['an empty object', {}],
  ]

  it.each(rejected)('rejects %s and names the questions field', (_label, value) => {
    expect(() => validateQuestions(value)).toThrow(JevValidationError)
    expect(() => validateQuestions(value)).toThrow(/questions/)
  })

  describe('accepted question shapes', () => {
    it('accepts noul without criteria', () => {
      const questions = { q: { type: 'noul', instructions: 'Is this urgent?' } }
      expect(validateQuestions(questions)).toBe(questions)
    })

    it('accepts noul with a rubric', () => {
      const questions = { q: { type: 'noul', instructions: 'Is this urgent?', criteria: { yes: 'act now', no: null } } }
      expect(validateQuestions(questions)).toBe(questions)
    })

    it('accepts choice with string and null rubric values', () => {
      const questions = {
        q: { type: 'choice', instructions: 'Which team?', criteria: { billing: 'payment', technical: null } },
      }
      expect(validateQuestions(questions)).toBe(questions)
    })

    it('accepts score with ordered levels', () => {
      const questions = { q: { type: 'score', instructions: 'How urgent?', criteria: ['low', 'medium', 'high'] } }
      expect(validateQuestions(questions)).toBe(questions)
    })

    it('passes a multi-question map through by reference', () => {
      const questions = {
        department: { type: 'choice', instructions: 'Which team?', criteria: { billing: null, sales: null } },
        is_urgent: { type: 'noul', instructions: 'Urgent?' },
        frustration: { type: 'score', instructions: 'How angry?', criteria: ['calm', 'angry'] },
      }
      expect(validateQuestions(questions)).toBe(questions)
    })
  })

  describe('question shape', () => {
    const rejected: Array<[label: string, question: unknown, message: RegExp]> = [
      ['a non-object question', 'nope', /questions\.q must be a JSON object/],
      ['an array question', ['noul'], /questions\.q must be a JSON object/],
      ['a missing type', { instructions: 'x' }, /questions\.q\.type is missing/],
      ['a non-string type', { type: 7, instructions: 'x' }, /questions\.q\.type must be one of/],
      ['an unknown type', { type: 'nonsense', instructions: 'x' }, /questions\.q\.type must be one of/],
      ['a missing instructions', { type: 'noul' }, /questions\.q\.instructions is missing/],
      ['a blank instructions', { type: 'noul', instructions: '   ' }, /questions\.q\.instructions must be a non-empty string/],
      ['a numeric instructions', { type: 'noul', instructions: 7 }, /questions\.q\.instructions must be a non-empty string/],
    ]

    it.each(rejected)('rejects %s', (_label, question, message) => {
      expect(() => validateQuestions({ q: question })).toThrow(JevValidationError)
      expect(() => validateQuestions({ q: question })).toThrow(message)
      expect(() => validateQuestions({ q: question })).toThrow(/questions\.q/)
    })

    it('names the received type and the accepted kinds', () => {
      expect(() => validateQuestions({ q: { type: 'nonsense', instructions: 'x' } })).toThrow(/nonsense/)
      expect(() => validateQuestions({ q: { type: 'nonsense', instructions: 'x' } })).toThrow(/"noul", "choice", "score"/)
    })

    it('names the offending question id, not just the map', () => {
      expect(() => validateQuestions({
        fine: { type: 'noul', instructions: 'ok' },
        department: { type: 'choice', instructions: 'Which team?' },
      })).toThrow(/questions\.department\.criteria/)
    })
  })

  describe('choice criteria', () => {
    const rejectedChoice: Array<[label: string, criteria: unknown, message: RegExp]> = [
      ['a missing criteria', undefined, /questions\.q\.criteria is missing/],
      ['an array criteria', ['a', 'b'], /questions\.q\.criteria must be a JSON object/],
      ['a single label', { only: null }, /between 2 and 255 labels; received 1/],
      ['an empty criteria', {}, /between 2 and 255 labels; received 0/],
      ['a numeric rubric value', { a: null, b: 7 }, /questions\.q\.criteria\.b must be a string or null/],
      ['a nested rubric value', { a: null, b: {} }, /questions\.q\.criteria\.b must be a string or null/],
    ]

    it.each(rejectedChoice)('rejects %s', (_label, criteria, message) => {
      expect(() => validateQuestions({ q: { type: 'choice', instructions: 'x', criteria } }))
        .toThrow(JevValidationError)
      expect(() => validateQuestions({ q: { type: 'choice', instructions: 'x', criteria } })).toThrow(message)
    })

    it('rejects more than 255 labels', () => {
      const criteria = Object.fromEntries(Array.from({ length: 256 }, (_, index) => [`l${index}`, null]))
      expect(() => validateQuestions({ q: { type: 'choice', instructions: 'x', criteria } }))
        .toThrow(/between 2 and 255 labels; received 256/)
    })

    it('accepts exactly 255 labels', () => {
      const criteria = Object.fromEntries(Array.from({ length: 255 }, (_, index) => [`l${index}`, null]))
      expect(validateQuestions({ q: { type: 'choice', instructions: 'x', criteria } })).toBeDefined()
    })
  })

  describe('score criteria', () => {
    const rejectedScore: Array<[label: string, criteria: unknown, message: RegExp]> = [
      ['a missing criteria', undefined, /questions\.q\.criteria is missing/],
      ['an object criteria', { a: 'low', b: 'high' }, /questions\.q\.criteria must be an array/],
      ['a single level', ['low'], /between 2 and 10 ordered levels; received 1/],
      ['an empty criteria', [], /between 2 and 10 ordered levels; received 0/],
      ['a blank level', ['low', '  '], /questions\.q\.criteria\[1\] must be a non-empty string/],
      ['a numeric level', ['low', 3], /questions\.q\.criteria\[1\] must be a non-empty string/],
    ]

    it.each(rejectedScore)('rejects %s', (_label, criteria, message) => {
      expect(() => validateQuestions({ q: { type: 'score', instructions: 'x', criteria } }))
        .toThrow(JevValidationError)
      expect(() => validateQuestions({ q: { type: 'score', instructions: 'x', criteria } })).toThrow(message)
    })

    it('rejects more than 10 levels', () => {
      const criteria = Array.from({ length: 11 }, (_, index) => `l${index}`)
      expect(() => validateQuestions({ q: { type: 'score', instructions: 'x', criteria } }))
        .toThrow(/between 2 and 10 ordered levels; received 11/)
    })
  })

  describe('noul criteria', () => {
    it('rejects a non-object rubric', () => {
      expect(() => validateQuestions({ q: { type: 'noul', instructions: 'x', criteria: ['a', 'b'] } }))
        .toThrow(/questions\.q\.criteria must be a JSON object/)
    })

    it('rejects a non-string rubric value', () => {
      expect(() => validateQuestions({ q: { type: 'noul', instructions: 'x', criteria: { yes: 1 } } }))
        .toThrow(/questions\.q\.criteria\.yes must be a string or null/)
    })
  })
})

describe('validateChoiceOptions', () => {
  it('accepts two labels and preserves their order', () => {
    expect(validateChoiceOptions(['billing', 'technical'])).toEqual(['billing', 'technical'])
  })

  it('accepts 255 labels', () => {
    const labels = Array.from({ length: 255 }, (_value, index) => `label-${index}`)
    expect(validateChoiceOptions(labels)).toHaveLength(255)
  })

  it('de-duplicates in first-seen order', () => {
    expect(validateChoiceOptions(['b', 'a', 'b'])).toEqual(['b', 'a'])
  })

  it('rejects a single label', () => {
    expect(() => validateChoiceOptions(['billing'])).toThrow(JevValidationError)
  })

  it('rejects duplicates that collapse to a single label', () => {
    expect(() => validateChoiceOptions(['a', 'a'])).toThrow(/options/)
    expect(() => validateChoiceOptions(['a', 'a'])).toThrow(/received 1/)
  })

  it('rejects 256 labels', () => {
    const labels = Array.from({ length: 256 }, (_value, index) => `label-${index}`)
    expect(() => validateChoiceOptions(labels)).toThrow(JevValidationError)
    expect(() => validateChoiceOptions(labels)).toThrow(/at most 255/)
  })

  const rejected: Array<[label: string, value: unknown]> = [
    ['an empty label', ['']],
    ['a blank label', ['a', '  ']],
    ['a non-string label', ['a', 5]],
    ['no labels at all', []],
    ['a non-array', 'billing'],
  ]

  it.each(rejected)('rejects %s and names the options field', (_label, value) => {
    expect(() => validateChoiceOptions(value)).toThrow(JevValidationError)
    expect(() => validateChoiceOptions(value)).toThrow(/options/)
  })
})

describe('validateScoreOptions', () => {
  it('accepts ordered levels and preserves their order', () => {
    expect(validateScoreOptions(['calm', 'frustrated', 'angry'])).toEqual(['calm', 'frustrated', 'angry'])
  })

  it('accepts 10 levels', () => {
    const levels = Array.from({ length: 10 }, (_value, index) => `level-${index}`)
    expect(validateScoreOptions(levels)).toHaveLength(10)
  })

  it('keeps duplicate levels', () => {
    expect(validateScoreOptions(['a', 'a'])).toEqual(['a', 'a'])
  })

  it('rejects a single level', () => {
    expect(() => validateScoreOptions(['calm'])).toThrow(JevValidationError)
  })

  it('rejects 11 levels', () => {
    const levels = Array.from({ length: 11 }, (_value, index) => `level-${index}`)
    expect(() => validateScoreOptions(levels)).toThrow(JevValidationError)
    expect(() => validateScoreOptions(levels)).toThrow(/at most 10/)
  })

  const rejected: Array<[label: string, value: unknown]> = [
    ['an empty level', ['calm', '']],
    ['a non-string level', ['calm', 3]],
    ['no levels at all', []],
    ['a non-array', 'calm'],
  ]

  it.each(rejected)('rejects %s and names the options field', (_label, value) => {
    expect(() => validateScoreOptions(value)).toThrow(JevValidationError)
    expect(() => validateScoreOptions(value)).toThrow(/options/)
  })
})

describe('toDecideEnvelope', () => {
  it('returns model, the decision answer, and usage', () => {
    const response = decideResponse()
    expect(toDecideEnvelope(response)).toEqual({
      model: 'jev-1.13.0',
      answer: { type: 'noul', noul: 0.93 },
      usage: { input_tokens: 312, output_tokens: 20 },
    })
  })

  it('passes the decision answer through by reference', () => {
    const response = decideResponse()
    const answers = response['answers'] as Record<string, unknown>
    expect(toDecideEnvelope(response).answer).toBe(answers['decision'])
  })

  const rejected: Array<[label: string, response: unknown]> = [
    ['a non-object response', 'nope'],
    ['an absent model', { answers: { decision: { type: 'noul' } }, usage: { input_tokens: 1, output_tokens: 1 } }],
    ['an empty model', decideResponse({ model: '' })],
    ['a blank model', decideResponse({ model: '   ' })],
    ['a non-string model', decideResponse({ model: 13 })],
    ['an undefined model', decideResponse({ model: undefined })],
    ['an undefined usage', decideResponse({ usage: undefined })],
    ['a non-object usage', decideResponse({ usage: 'tokens' })],
    ['a non-number input_tokens', decideResponse({ usage: { input_tokens: '312', output_tokens: 20 } })],
    ['a non-number output_tokens', decideResponse({ usage: { input_tokens: 312, output_tokens: null } })],
    ['an undefined answers', decideResponse({ answers: undefined })],
    ['a non-object answers', decideResponse({ answers: [] })],
    ['an empty answers', decideResponse({ answers: {} })],
    ['a non-object answers.decision', decideResponse({ answers: { decision: 'noul' } })],
  ]

  it.each(rejected)('rejects %s', (_label, response) => {
    expect(() => toDecideEnvelope(response)).toThrow(JevValidationError)
  })

  it('names the mistyped field path', () => {
    expect(() => toDecideEnvelope(decideResponse({ answers: {} }))).toThrow(/answers\.decision/)
    expect(() => toDecideEnvelope(decideResponse({ usage: { input_tokens: '312', output_tokens: 20 } })))
      .toThrow(/usage\.input_tokens/)
    expect(() => toDecideEnvelope(decideResponse({ model: undefined }))).toThrow(/model/)
  })
})

describe('toEvaluateEnvelope', () => {
  it('returns model, the raw answers, and usage', () => {
    expect(toEvaluateEnvelope(evaluateResponse())).toEqual({
      model: 'jev-1.13.0',
      answers: {
        department: { type: 'choice', choice: 'technical', confidence: 0.78 },
        is_urgent: { type: 'noul', noul: 1 },
      },
      usage: { input_tokens: 392, output_tokens: 65 },
    })
  })

  it('passes the answers object through by reference', () => {
    const response = evaluateResponse()
    expect(toEvaluateEnvelope(response).answers).toBe(response['answers'])
  })

  const rejected: Array<[label: string, response: unknown]> = [
    ['a non-object response', null],
    ['an absent model', { answers: { a: {} }, usage: { input_tokens: 1, output_tokens: 1 } }],
    ['an undefined model', evaluateResponse({ model: undefined })],
    ['an empty model', evaluateResponse({ model: '' })],
    ['an undefined usage', evaluateResponse({ usage: undefined })],
    ['a non-number output_tokens', evaluateResponse({ usage: { input_tokens: 1, output_tokens: 'x' } })],
    ['an undefined answers', evaluateResponse({ answers: undefined })],
    ['a non-object answers', evaluateResponse({ answers: 'answers' })],
    ['an empty answers', evaluateResponse({ answers: {} })],
    ['a non-object answer value', evaluateResponse({ answers: { department: 'technical' } })],
  ]

  it.each(rejected)('rejects %s', (_label, response) => {
    expect(() => toEvaluateEnvelope(response)).toThrow(JevValidationError)
  })

  it('names the mistyped answer path', () => {
    expect(() => toEvaluateEnvelope(evaluateResponse({ answers: { department: 'technical' } })))
      .toThrow(/answers\.department/)
  })
})

describe('toJevResponse', () => {
  it('returns model, the raw answers, and usage', () => {
    expect(toJevResponse(evaluateResponse())).toEqual({
      model: 'jev-1.13.0',
      answers: {
        department: { type: 'choice', choice: 'technical', confidence: 0.78 },
        is_urgent: { type: 'noul', noul: 1 },
      },
      usage: { input_tokens: 392, output_tokens: 65 },
    })
  })

  it('passes the answers object through by reference', () => {
    const response = evaluateResponse()
    expect(toJevResponse(response).answers).toBe(response['answers'])
  })

  const rejected: Array<[label: string, response: unknown]> = [
    ['a non-object response', 'nope'],
    ['a null response', null],
    ['an absent model', { answers: { a: {} }, usage: { input_tokens: 1, output_tokens: 1 } }],
    ['an empty model', evaluateResponse({ model: '' })],
    ['a non-string model', evaluateResponse({ model: 13 })],
    ['an absent usage', { model: 'm', answers: { a: {} } }],
    ['a non-object usage', evaluateResponse({ usage: 'tokens' })],
    ['a non-number input_tokens', evaluateResponse({ usage: { input_tokens: '1', output_tokens: 1 } })],
    ['a non-number output_tokens', evaluateResponse({ usage: { input_tokens: 1, output_tokens: null } })],
    ['an absent answers', evaluateResponse({ answers: undefined })],
    ['a non-object answers', evaluateResponse({ answers: [] })],
    ['an empty answers', evaluateResponse({ answers: {} })],
    ['a non-object answer value', evaluateResponse({ answers: { department: 'technical' } })],
  ]

  it.each(rejected)('rejects %s', (_label, response) => {
    expect(() => toJevResponse(response)).toThrow(JevValidationError)
  })

  it('names the offending answer path', () => {
    expect(() => toJevResponse(evaluateResponse({ answers: { department: 'technical' } })))
      .toThrow(/answers\.department/)
    expect(() => toJevResponse(evaluateResponse({ answers: {} }))).toThrow(/answers/)
  })
})

describe('toNoulAnswer', () => {
  it('returns the answer reduced to type and probability', () => {
    expect(toNoulAnswer({ type: 'noul', noul: 0.93 })).toEqual({ type: 'noul', noul: 0.93 })
  })

  it('drops fields the contract does not name', () => {
    expect(toNoulAnswer({ type: 'noul', noul: 0.5, extra: 'dropped' })).toEqual({ type: 'noul', noul: 0.5 })
  })

  it('accepts both interval boundaries', () => {
    expect(toNoulAnswer({ type: 'noul', noul: 0 }).noul).toBe(0)
    expect(toNoulAnswer({ type: 'noul', noul: 1 }).noul).toBe(1)
  })

  const rejected: Array<[label: string, value: unknown]> = [
    ['a non-object answer', 'noul'],
    ['an absent type', { noul: 0.5 }],
    ['a choice type', { type: 'choice', noul: 0.5 }],
    ['a score type', { type: 'score', noul: 0.5 }],
    ['an absent noul', { type: 'noul' }],
    ['a probability above one', { type: 'noul', noul: 1.5 }],
    ['a negative probability', { type: 'noul', noul: -0.1 }],
    ['a string probability', { type: 'noul', noul: '0.5' }],
    ['a NaN probability', { type: 'noul', noul: Number.NaN }],
  ]

  it.each(rejected)('rejects %s', (_label, value) => {
    expect(() => toNoulAnswer(value)).toThrow(JevValidationError)
  })

  it('names the answer field path', () => {
    expect(() => toNoulAnswer({ type: 'noul', noul: 2 })).toThrow(/answer\.noul/)
    expect(() => toNoulAnswer({ type: 'choice', noul: 0.5 })).toThrow(/answer\.type/)
  })
})

describe('toChoiceAnswer', () => {
  it('returns the answer reduced to the contract fields', () => {
    expect(toChoiceAnswer({
      type: 'choice',
      choice: 'billing',
      probabilities: { billing: 0.91, sales: 0.09 },
      confidence: 0.87,
      extra: 'dropped',
    })).toEqual({
      type: 'choice',
      choice: 'billing',
      probabilities: { billing: 0.91, sales: 0.09 },
      confidence: 0.87,
    })
  })

  it('accepts both confidence boundaries', () => {
    expect(toChoiceAnswer({ type: 'choice', choice: 'a', probabilities: { a: 1 }, confidence: 0 }).confidence).toBe(0)
    expect(toChoiceAnswer({ type: 'choice', choice: 'a', probabilities: { a: 1 }, confidence: 1 }).confidence).toBe(1)
  })

  const rejected: Array<[label: string, value: unknown]> = [
    ['a non-object answer', []],
    ['an absent type', { choice: 'billing', probabilities: { billing: 1 }, confidence: 0.5 }],
    ['a noul type', { type: 'noul', choice: 'billing', probabilities: { billing: 1 }, confidence: 0.5 }],
    ['an empty choice', { type: 'choice', choice: '', probabilities: { '': 1 }, confidence: 0.5 }],
    ['a non-string choice', { type: 'choice', choice: 7, probabilities: { 7: 1 }, confidence: 0.5 }],
    ['an absent choice', { type: 'choice', probabilities: { billing: 1 }, confidence: 0.5 }],
    ['a choice missing from probabilities', { type: 'choice', choice: 'sales', probabilities: { billing: 1 }, confidence: 0.5 }],
    ['an absent probabilities', { type: 'choice', choice: 'billing', confidence: 0.5 }],
    ['a non-object probabilities', { type: 'choice', choice: 'billing', probabilities: 1, confidence: 0.5 }],
    ['a non-number probability', { type: 'choice', choice: 'billing', probabilities: { billing: '0.9' }, confidence: 0.5 }],
    ['an absent confidence', { type: 'choice', choice: 'billing', probabilities: { billing: 1 } }],
    ['a confidence above one', { type: 'choice', choice: 'billing', probabilities: { billing: 1 }, confidence: 1.5 }],
    ['a negative confidence', { type: 'choice', choice: 'billing', probabilities: { billing: 1 }, confidence: -0.1 }],
  ]

  it.each(rejected)('rejects %s', (_label, value) => {
    expect(() => toChoiceAnswer(value)).toThrow(JevValidationError)
  })

  it('names the offending field path', () => {
    expect(() => toChoiceAnswer({ type: 'choice', choice: 'sales', probabilities: { billing: 1 }, confidence: 0.5 }))
      .toThrow(/answer\.probabilities/)
    expect(() => toChoiceAnswer({ type: 'choice', choice: 'billing', probabilities: { billing: 1 }, confidence: 2 }))
      .toThrow(/answer\.confidence/)
  })
})

describe('toScoreAnswer', () => {
  it('returns the answer with its legend', () => {
    expect(toScoreAnswer({
      type: 'score',
      score: 2.99,
      legend: { '0': 'low', '3': 'critical' },
      probabilities: { '0': 0, '3': 0.99 },
      confidence: 0.99,
      extra: 'dropped',
    })).toEqual({
      type: 'score',
      score: 2.99,
      legend: { '0': 'low', '3': 'critical' },
      probabilities: { '0': 0, '3': 0.99 },
      confidence: 0.99,
    })
  })

  it('omits legend entirely when the API sends none', () => {
    const answer = toScoreAnswer({ type: 'score', score: 1.4, probabilities: { '0': 0.2, '1': 0.8 }, confidence: 0.6 })
    expect(answer).toEqual({ type: 'score', score: 1.4, probabilities: { '0': 0.2, '1': 0.8 }, confidence: 0.6 })
    expect('legend' in answer).toBe(false)
  })

  it('accepts a fractional score outside the level count and both confidence boundaries', () => {
    expect(toScoreAnswer({ type: 'score', score: 0, probabilities: {}, confidence: 0 }).score).toBe(0)
    expect(toScoreAnswer({ type: 'score', score: 7.5, probabilities: {}, confidence: 1 }).score).toBe(7.5)
  })

  const rejected: Array<[label: string, value: unknown]> = [
    ['a non-object answer', 3],
    ['an absent type', { score: 1, probabilities: {}, confidence: 0.5 }],
    ['a choice type', { type: 'choice', score: 1, probabilities: {}, confidence: 0.5 }],
    ['an absent score', { type: 'score', probabilities: {}, confidence: 0.5 }],
    ['a NaN score', { type: 'score', score: Number.NaN, probabilities: {}, confidence: 0.5 }],
    ['an infinite score', { type: 'score', score: Number.POSITIVE_INFINITY, probabilities: {}, confidence: 0.5 }],
    ['a string score', { type: 'score', score: '2', probabilities: {}, confidence: 0.5 }],
    ['an absent confidence', { type: 'score', score: 1, probabilities: {} }],
    ['a confidence above one', { type: 'score', score: 1, probabilities: {}, confidence: 1.5 }],
    ['an absent probabilities', { type: 'score', score: 1, confidence: 0.5 }],
    ['a non-number probability', { type: 'score', score: 1, probabilities: { '0': '0.5' }, confidence: 0.5 }],
    ['a non-object legend', { type: 'score', score: 1, probabilities: {}, confidence: 0.5, legend: 'low' }],
    ['a non-string legend value', { type: 'score', score: 1, probabilities: {}, confidence: 0.5, legend: { '0': 3 } }],
  ]

  it.each(rejected)('rejects %s', (_label, value) => {
    expect(() => toScoreAnswer(value)).toThrow(JevValidationError)
  })

  it('names the offending field path', () => {
    expect(() => toScoreAnswer({ type: 'score', score: 1, probabilities: {}, confidence: 0.5, legend: { '0': 3 } }))
      .toThrow(/answer\.legend\.0/)
    expect(() => toScoreAnswer({ type: 'score', score: Number.NaN, probabilities: {}, confidence: 0.5 }))
      .toThrow(/NaN/)
  })
})
