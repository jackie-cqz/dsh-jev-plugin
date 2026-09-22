/** Contract tests for the model router. @module dsh-jev/test/routing */

import { describe, expect, it, vi } from 'vitest'

import { resolveConfig, type RoutingConfig } from '../src/config.ts'
import type { JevService } from '../src/service.ts'
import { JevRouter, type RoutingRequest } from '../src/routing.ts'

/** One captured `score` invocation. */
interface ScoreCall {
  state: unknown
  instructions: string
  criteria: string[]
  signal?: AbortSignal
}

/**
 * Build a service double whose scorer records its arguments.
 * @param respond - answer factory, or a value returned as the answer.
 * @returns the service double and the captured calls.
 */
function fakeService(respond: unknown | (() => unknown)): { service: JevService; calls: ScoreCall[] } {
  const calls: ScoreCall[] = []
  const score = vi.fn(async (state: unknown, instructions: string, criteria: string[], signal?: AbortSignal) => {
    calls.push({ state, instructions, criteria, ...signal === undefined ? {} : { signal } })
    return typeof respond === 'function' ? (respond as () => unknown)() : respond
  })
  return { service: { score } as unknown as JevService, calls }
}

/**
 * Resolve a routing configuration through the real config contract.
 * @param overrides - raw routing overrides.
 * @returns the resolved routing configuration.
 */
function routing(overrides: RoutingConfig = {}) {
  return resolveConfig({
    routing: {
      enabled: true,
      levels: ['simple', 'moderate', 'complex'],
      models: ['m-fast', 'm-mid', 'm-strong'],
      ...overrides,
    },
  }).routing
}

/** A score answer for the band under test. */
const scored = (score: number, confidence = 0.9) => ({
  type: 'score',
  score,
  legend: { 0: 'simple', 1: 'moderate', 2: 'complex' },
  probabilities: { 0: 1 },
  confidence,
})

const REQUEST: RoutingRequest = { model: 'm-default', state: { prompt: 'refactor this module' } }

describe('JevRouter while disabled', () => {
  it('keeps the requested model without scoring anything', async () => {
    const { service, calls } = fakeService(scored(2))
    const router = new JevRouter({ service, config: routing({ enabled: false }) })

    const decision = await router.decide(REQUEST)

    expect(decision).toEqual({ kind: 'keep' })
    expect(calls).toHaveLength(0)
    expect(router.stats()).toEqual({ scored: 0, kept: 0, routed: 0, errors: 0 })
  })
})

describe('JevRouter band mapping', () => {
  it('routes to the model of the scored band', async () => {
    const { service } = fakeService(scored(2))
    const router = new JevRouter({ service, config: routing() })

    expect(await router.decide(REQUEST)).toEqual({ kind: 'route', model: 'm-strong' })
    expect(router.stats()).toEqual({ scored: 1, kept: 0, routed: 1, errors: 0 })
  })

  it('rounds a fractional score to the nearest band', async () => {
    const { service } = fakeService(scored(1.6))
    const router = new JevRouter({ service, config: routing() })

    expect(await router.decide(REQUEST)).toEqual({ kind: 'route', model: 'm-strong' })
  })

  it.each([
    ['a negative score', -5, 'm-fast'],
    ['a score past the top band', 99, 'm-strong'],
  ])('clamps %s to an endpoint', async (_label, score, expected) => {
    const { service } = fakeService(scored(score))
    const router = new JevRouter({ service, config: routing() })

    expect(await router.decide(REQUEST)).toEqual({ kind: 'route', model: expected })
  })

  it('keeps the request when the band names no model', async () => {
    const { service } = fakeService(scored(0))
    const router = new JevRouter({ service, config: routing({ models: ['', 'm-mid', 'm-strong'] }) })

    expect(await router.decide(REQUEST)).toEqual({ kind: 'keep' })
    expect(router.stats()).toEqual({ scored: 1, kept: 1, routed: 0, errors: 0 })
  })

  it('keeps the request when the band names the model it already uses', async () => {
    const { service } = fakeService(scored(1))
    const router = new JevRouter({ service, config: routing({ models: ['m-fast', 'm-default', 'm-strong'] }) })

    expect(await router.decide(REQUEST)).toEqual({ kind: 'keep' })
    expect(router.stats()).toEqual({ scored: 1, kept: 1, routed: 0, errors: 0 })
  })
})

describe('JevRouter failure policy', () => {
  const FAILING = [
    ['an Error', new Error('offline')],
    ['a string', 'offline'],
    ['null', null],
    ['undefined', undefined],
  ] as const

  it.each(FAILING)('never throws when the scorer rejects with %s', async (_label, error) => {
    const { service } = fakeService(() => { throw error })
    const router = new JevRouter({ service, config: routing({ onError: 'keep' }) })

    await expect(router.decide(REQUEST)).resolves.toEqual({ kind: 'keep' })
    expect(router.stats()).toEqual({ scored: 1, kept: 1, routed: 0, errors: 1 })
  })

  it('keeps the request when onError is keep', async () => {
    const { service } = fakeService(() => { throw new Error('offline') })
    const router = new JevRouter({ service, config: routing({ onError: 'keep' }) })

    expect(await router.decide(REQUEST)).toEqual({ kind: 'keep' })
  })

  it('falls back to the top band when onError is capable', async () => {
    const { service } = fakeService(() => { throw new Error('offline') })
    const router = new JevRouter({ service, config: routing({ onError: 'capable' }) })

    expect(await router.decide(REQUEST)).toEqual({ kind: 'route', model: 'm-strong' })
    expect(router.stats()).toEqual({ scored: 1, kept: 0, routed: 1, errors: 1 })
  })

  it('keeps the request when onError is capable but the top band names no model', async () => {
    const { service } = fakeService(() => { throw new Error('offline') })
    const router = new JevRouter({
      service,
      config: routing({ onError: 'capable', models: ['m-fast', 'm-mid', ''] }),
    })

    expect(await router.decide(REQUEST)).toEqual({ kind: 'keep' })
    expect(router.stats()).toEqual({ scored: 1, kept: 1, routed: 0, errors: 1 })
  })

  it('treats an unusable score as a failed check', async () => {
    const { service } = fakeService(scored(Number.NaN))
    const router = new JevRouter({ service, config: routing({ onError: 'capable' }) })

    expect(await router.decide(REQUEST)).toEqual({ kind: 'route', model: 'm-strong' })
    expect(router.stats()).toEqual({ scored: 1, kept: 0, routed: 1, errors: 1 })
  })
})

describe('JevRouter passthrough and reporting', () => {
  it('forwards the state, question, levels, and signal unchanged', async () => {
    const { service, calls } = fakeService(scored(0))
    const controller = new AbortController()
    const config = routing({ question: 'How demanding is this?' })
    const router = new JevRouter({ service, config })
    const state = { prompt: 'do the thing' }

    await router.decide({ model: 'm-default', state, signal: controller.signal })

    expect(calls).toHaveLength(1)
    expect(calls[0]?.state).toBe(state)
    expect(calls[0]?.instructions).toBe('How demanding is this?')
    expect(calls[0]?.criteria).toBe(config.levels)
    expect(calls[0]?.signal).toBe(controller.signal)
  })

  it('omits the signal when the request carries none', async () => {
    const { service, calls } = fakeService(scored(0))
    const router = new JevRouter({ service, config: routing() })

    await router.decide({ model: 'm-default', state: 'plain text' })

    expect(calls[0] !== undefined && 'signal' in calls[0]).toBe(false)
  })

  it('returns a stats snapshot that later decisions do not mutate', async () => {
    const { service } = fakeService(scored(2))
    const router = new JevRouter({ service, config: routing() })

    await router.decide(REQUEST)
    const snapshot = router.stats()
    await router.decide(REQUEST)

    expect(snapshot).toEqual({ scored: 1, kept: 0, routed: 1, errors: 0 })
    expect(router.stats()).toEqual({ scored: 2, kept: 0, routed: 2, errors: 0 })
  })
})
