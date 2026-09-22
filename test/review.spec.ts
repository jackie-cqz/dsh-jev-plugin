/** Contract tests for the post-execute result review. @module dsh-jev/test/review */

import { describe, expect, it, vi } from 'vitest'

import type { ResolvedReviewConfig } from '../src/config.ts'
import { JevNetworkError } from '../src/errors.ts'
import { JevReview, type ReviewCall, type ReviewDecision } from '../src/review.ts'
import type { JevService } from '../src/service.ts'

const QUESTION = 'Did this call fail?'

const CONFIG: ResolvedReviewConfig = {
  enabled: true,
  tools: [],
  question: QUESTION,
  blockAt: 0.8,
  onError: 'accept',
}

/**
 * Build review configuration from the enabled baseline.
 * @param overrides - fields to replace.
 * @returns the resolved configuration under test.
 */
function reviewConfig(overrides: Partial<ResolvedReviewConfig> = {}): ResolvedReviewConfig {
  return { ...CONFIG, ...overrides }
}

/** One captured service call. */
interface CapturedCall {
  state: unknown
  instructions: string
  criteria: unknown
  signal: AbortSignal | undefined
}

/**
 * Build a review backed by a recording fake service.
 * @param answer - probability the fake service resolves with, or a value it throws.
 * @param config - resolved review policy.
 * @returns the review, the captured calls, and the service double.
 */
function fixture(
  answer: number | (() => never),
  config: ResolvedReviewConfig = reviewConfig(),
): { review: JevReview; calls: CapturedCall[]; service: JevService } {
  const calls: CapturedCall[] = []
  const noul = vi.fn(async (state: unknown, instructions: string, criteria: unknown, signal?: AbortSignal) => {
    calls.push({ state, instructions, criteria, signal })
    if (typeof answer === 'function') answer()
    return { type: 'noul' as const, noul: answer }
  })
  const service = { noul } as unknown as JevService
  return { review: new JevReview({ service, config }), calls, service }
}

/** The call every test reviews unless it says otherwise. */
const CALL: ReviewCall = { name: 'bash', arguments: { command: 'ls' }, result: { stdout: 'file.txt' } }

/** Read the feedback of a blocking decision. */
function feedbackOf(decision: ReviewDecision): string {
  return decision.kind === 'block' ? decision.feedback : ''
}

describe('scope', () => {
  it('accepts everything without asking while disabled', async () => {
    const { review, service } = fixture(0.99, reviewConfig({ enabled: false }))

    const decision = await review.decide(CALL)

    expect(decision).toEqual({ kind: 'accept' })
    expect(service.noul).not.toHaveBeenCalled()
    expect(review.stats()).toEqual({ reviewed: 0, accepted: 0, blocked: 0, errors: 0 })
  })

  it('skips a tool outside the configured scope without counting it', async () => {
    const { review, service } = fixture(0.99, reviewConfig({ tools: ['bash'] }))

    expect(await review.decide({ ...CALL, name: 'read' })).toEqual({ kind: 'accept' })
    expect(service.noul).not.toHaveBeenCalled()
    expect(review.stats().reviewed).toBe(0)
  })

  it('reviews every tool when the scope list is empty', async () => {
    const { review } = fixture(0.99, reviewConfig({ tools: [] }))

    await review.decide({ ...CALL, name: 'read' })

    expect(review.stats().reviewed).toBe(1)
  })
})

describe('probability mapping', () => {
  it('blocks at exactly the configured threshold', async () => {
    const { review } = fixture(0.8)

    const decision = await review.decide(CALL)

    expect(decision.kind).toBe('block')
    expect(feedbackOf(decision)).toContain('0.80')
    expect(review.stats()).toEqual({ reviewed: 1, accepted: 0, blocked: 1, errors: 0 })
  })

  it('accepts just below the threshold', async () => {
    const { review } = fixture(0.79)

    expect(await review.decide(CALL)).toEqual({ kind: 'accept' })
    expect(review.stats()).toEqual({ reviewed: 1, accepted: 1, blocked: 0, errors: 0 })
  })
})

describe('what the service receives', () => {
  it('sends the tool, its arguments, and its result as state', async () => {
    const { review, calls } = fixture(0.1)

    await review.decide(CALL)

    expect(calls[0]?.state).toEqual({ tool: 'bash', arguments: { command: 'ls' }, result: { stdout: 'file.txt' } })
    expect(calls[0]?.instructions).toBe(QUESTION)
    expect(calls[0]?.criteria).toBeUndefined()
  })

  it('forwards the signal by reference and omits it when absent', async () => {
    const controller = new AbortController()
    const { review, calls } = fixture(0.1)

    await review.decide({ ...CALL, signal: controller.signal })
    await review.decide(CALL)

    expect(calls[0]?.signal).toBe(controller.signal)
    expect(calls[1]?.signal).toBeUndefined()
  })
})

describe('failures never escape', () => {
  it.each([
    ['an Error', () => { throw new Error('boom') }],
    ['a string', () => { throw 'boom' }],
    ['null', () => { throw null }],
    ['undefined', () => { throw undefined }],
  ])('accepts after %s under onError: accept', async (_label, thrown) => {
    const { review } = fixture(thrown as () => never, reviewConfig({ onError: 'accept' }))

    expect(await review.decide(CALL)).toEqual({ kind: 'accept' })
    expect(review.stats()).toEqual({ reviewed: 1, accepted: 1, blocked: 0, errors: 1 })
  })

  it('blocks under onError: block and names the code rather than the message', async () => {
    const { review } = fixture(
      () => { throw new JevNetworkError('socket 10.0.0.1 closed while sending sk-secret-value') },
      reviewConfig({ onError: 'block' }),
    )

    const decision = await review.decide(CALL)

    expect(decision.kind).toBe('block')
    expect(feedbackOf(decision)).toContain('JEV_NETWORK')
    expect(feedbackOf(decision)).not.toContain('socket')
    expect(review.stats()).toEqual({ reviewed: 1, accepted: 0, blocked: 1, errors: 1 })
  })
})

describe('feedback never quotes the call', () => {
  const SECRET = 'sk-secret-value'
  const SECRET_CALL: ReviewCall = {
    name: 'bash',
    arguments: { token: SECRET },
    result: { body: SECRET },
  }

  it.each([
    ['a block', 0.9, 'accept'],
    ['an accept', 0.1, 'accept'],
    ['a failure under accept', () => { throw new JevNetworkError(SECRET) }, 'accept'],
    ['a failure under block', () => { throw new JevNetworkError(SECRET) }, 'block'],
  ] as const)('keeps the secret out of %s', async (_label, answer, onError) => {
    const { review } = fixture(answer as number | (() => never), reviewConfig({ onError }))

    const decision = await review.decide(SECRET_CALL)

    expect(JSON.stringify(decision)).not.toContain(SECRET)
  })
})

describe('stats', () => {
  it('returns a snapshot that later decisions do not mutate', async () => {
    const { review } = fixture(0.1)

    const before = review.stats()
    await review.decide(CALL)

    expect(before).toEqual({ reviewed: 0, accepted: 0, blocked: 0, errors: 0 })
    expect(review.stats().reviewed).toBe(1)
  })
})
