/** Contract tests for the intent router. @module dsh-jev/test/intent */

import { describe, expect, it, vi } from 'vitest'

import type { ResolvedIntentConfig } from '../src/config.ts'
import { JevIntentRouter } from '../src/intent.ts'
import type { ChoiceAnswer, JevCriteria, JevState } from '../src/protocol.ts'
import type { JevService } from '../src/service.ts'

const CLASSES = ['question', 'change', 'debug', 'review']

/** One classification call the service double received. */
interface Captured {
  state: JevState
  instructions: string
  criteria: JevCriteria
  signal?: AbortSignal
}

/**
 * Resolved intent configuration with a single class carrying a directive.
 * @param overrides - fields to replace.
 * @returns resolved intent configuration.
 */
function intentConfig(overrides: Partial<ResolvedIntentConfig> = {}): ResolvedIntentConfig {
  return {
    enabled: true,
    question: 'What is the user asking for in this turn?',
    classes: [...CLASSES],
    directives: { debug: 'Start by reproducing the failure before changing anything.' },
    ...overrides,
  }
}

/**
 * Service double recording every classification call.
 * @param answer - produces the answer, or throws to exercise the failure path.
 * @returns the service and the calls it received.
 */
function fakeService(answer: () => Promise<ChoiceAnswer>): { service: JevService; calls: Captured[] } {
  const calls: Captured[] = []
  const choice = vi.fn(async (
    state: JevState,
    instructions: string,
    criteria: JevCriteria,
    signal?: AbortSignal,
  ): Promise<ChoiceAnswer> => {
    calls.push({ state, instructions, criteria, ...signal === undefined ? {} : { signal } })
    return await answer()
  })
  return { service: { choice } as unknown as JevService, calls }
}

/**
 * An answer naming one class.
 * @param choice - class the router receives.
 * @returns the typed answer.
 */
function answerFor(choice: string): ChoiceAnswer {
  return { type: 'choice', choice, probabilities: { [choice]: 1 }, confidence: 0.9 }
}

describe('JevIntentRouter', () => {
  it('skips everything while disabled and never calls the service', async () => {
    const { service, calls } = fakeService(async () => answerFor('debug'))
    const router = new JevIntentRouter({ service, config: intentConfig({ enabled: false }) })

    const decision = await router.decide({ text: 'why does the build fail?' })

    expect(decision).toEqual({ kind: 'skip' })
    expect(calls).toHaveLength(0)
    expect(router.stats()).toEqual({ classified: 0, directed: 0, skipped: 0, errors: 0 })
  })

  it.each([['an empty turn', ''], ['a whitespace-only turn', '   ']])(
    'skips %s without classifying it',
    async (_label, text) => {
      const { service, calls } = fakeService(async () => answerFor('debug'))
      const router = new JevIntentRouter({ service, config: intentConfig() })

      expect(await router.decide({ text })).toEqual({ kind: 'skip' })
      expect(calls).toHaveLength(0)
      expect(router.stats().classified).toBe(0)
    },
  )

  it('admits the configured directive for the classified class', async () => {
    const { service } = fakeService(async () => answerFor('debug'))
    const router = new JevIntentRouter({ service, config: intentConfig() })

    const decision = await router.decide({ text: 'the tests hang after the refactor' })

    expect(decision).toEqual({
      kind: 'direct',
      intent: 'debug',
      directive: 'Start by reproducing the failure before changing anything.',
    })
    expect(router.stats()).toEqual({ classified: 1, directed: 1, skipped: 0, errors: 0 })
  })

  it('admits nothing for a class that carries no directive', async () => {
    const { service } = fakeService(async () => answerFor('question'))
    const router = new JevIntentRouter({ service, config: intentConfig() })

    expect(await router.decide({ text: 'what does this function do?' })).toEqual({ kind: 'skip' })
    expect(router.stats()).toEqual({ classified: 1, directed: 0, skipped: 1, errors: 0 })
  })

  it('admits nothing for a class the deployment never configured', async () => {
    const { service } = fakeService(async () => answerFor('unexpected-class'))
    const router = new JevIntentRouter({ service, config: intentConfig() })

    expect(await router.decide({ text: 'something else' })).toEqual({ kind: 'skip' })
    expect(router.stats()).toEqual({ classified: 1, directed: 0, skipped: 1, errors: 0 })
  })

  it.each([
    ['an Error', () => Promise.reject(new Error('boom'))],
    ['a string', () => Promise.reject('boom')],
    ['null', () => Promise.reject(null)],
  ])('leaves the turn unmodified when the classification fails with %s', async (_label, answer) => {
    const { service } = fakeService(answer as () => Promise<ChoiceAnswer>)
    const router = new JevIntentRouter({ service, config: intentConfig() })

    expect(await router.decide({ text: 'anything' })).toEqual({ kind: 'skip' })
    // Counted once, as an error: a failure is never also counted as a skip.
    expect(router.stats()).toEqual({ classified: 1, directed: 0, skipped: 0, errors: 1 })
  })

  it('sends every configured class as a null-valued rubric and passes the turn through unchanged', async () => {
    const { service, calls } = fakeService(async () => answerFor('debug'))
    const router = new JevIntentRouter({ service, config: intentConfig() })

    await router.decide({ text: '  keep the surrounding spaces  ' })

    expect(calls[0]?.criteria).toEqual({ question: null, change: null, debug: null, review: null })
    expect(calls[0]?.instructions).toBe('What is the user asking for in this turn?')
    expect(calls[0]?.state).toEqual({ turn: '  keep the surrounding spaces  ' })
  })

  it('forwards the cancellation signal and omits it when the turn has none', async () => {
    const { service, calls } = fakeService(async () => answerFor('debug'))
    const router = new JevIntentRouter({ service, config: intentConfig() })
    const controller = new AbortController()

    await router.decide({ text: 'first', signal: controller.signal })
    await router.decide({ text: 'second' })

    expect(calls[0]?.signal).toBe(controller.signal)
    expect(calls[1] !== undefined && 'signal' in calls[1]).toBe(false)
  })

  it('returns a snapshot that later decisions do not mutate', async () => {
    const { service } = fakeService(async () => answerFor('debug'))
    const router = new JevIntentRouter({ service, config: intentConfig() })

    await router.decide({ text: 'first' })
    const snapshot = router.stats()
    await router.decide({ text: 'second' })
    await router.decide({ text: 'third' })

    expect(snapshot).toEqual({ classified: 1, directed: 1, skipped: 0, errors: 0 })
    expect(router.stats().classified).toBe(3)
  })
})
