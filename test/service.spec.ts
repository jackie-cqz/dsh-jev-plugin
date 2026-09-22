/** Service-level tests for the `ctx.jev` facade. @module dsh-jev/test/service */

import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, onTestFinished, vi } from 'vitest'

import type { CallSystemOneOptions, JevClient } from '../src/client.ts'
import type { Config } from '../src/config.ts'
import { JevQuotaError } from '../src/errors.ts'
import {
  JevCircuitOpenError,
  JevConfigError,
  JevHttpError,
  JevNetworkError,
  JevValidationError,
} from '../src/errors.ts'
import type { JevAnswer, JevQuestion, JevResponse, JevState } from '../src/protocol.ts'
import { JevService, type JevServiceDeps } from '../src/service.ts'

const USAGE = { input_tokens: 10, output_tokens: 2 }

/** Build a well-formed response around one answer map. */
function response(answers: Record<string, JevAnswer>): JevResponse {
  return { model: 'jev-1.13.0', answers, usage: USAGE }
}

/** A client double that records the options it receives. */
function fakeClient(impl: (options: CallSystemOneOptions) => Promise<unknown>): {
  client: JevClient
  calls: CallSystemOneOptions[]
} {
  const calls: CallSystemOneOptions[] = []
  const callSystemOne = vi.fn(async (options: CallSystemOneOptions) => {
    calls.push(options)
    return impl(options)
  })
  return { client: { callSystemOne } as unknown as JevClient, calls }
}

/** Mount a service on a fresh context and dispose it with the test. */
function mount(config: Config = {}, deps: JevServiceDeps = {}) {
  const ctx = new Context()
  new JevService(ctx, config, deps)
  onTestFinished(() => ctx.fiber.dispose())
  return ctx
}

const NOUL_QUESTION: JevQuestion = { type: 'noul', instructions: 'Is it urgent?' }

describe('JevService registration', () => {
  it('exposes ctx.jev synchronously with zeroed counters', () => {
    const ctx = mount({}, { client: fakeClient(async () => response({ decision: { noul: 0.5 } })).client })

    expect(ctx.jev).toBeDefined()
    expect(ctx.jev.stats()).toEqual({
      calls: 0,
      failures: 0,
      quotaRejections: 0,
      retries: 0,
      tokens: { input: 0, output: 0 },
      lastLatencyMs: 0,
      totalLatencyMs: 0,
      models: [],
      policy: { rejectedByCircuit: 0, spacedCalls: 0, circuitOpens: 0, circuit: 'closed' },
      cache: { hits: 0, misses: 0, entries: 0 },
    })
  })

  it('returns a snapshot that later activity does not mutate', async () => {
    const { client } = fakeClient(async () => response({ decision: { noul: 0.5 } }))
    const ctx = mount({}, { client })
    const before = ctx.jev.stats()

    await ctx.jev.callSystemOne({ state: 'x', questions: { decision: NOUL_QUESTION } })

    expect(before.calls).toBe(0)
    expect(ctx.jev.stats().calls).toBe(1)
  })
})

describe('callSystemOne', () => {
  it('returns the validated response and forwards state and questions', async () => {
    const { client, calls } = fakeClient(async () => response({ decision: { type: 'noul', noul: 0.9 } }))
    const ctx = mount({}, { client })

    const value = await ctx.jev.callSystemOne({ state: { ticket: 1 }, questions: { decision: NOUL_QUESTION } })

    expect(value).toEqual(response({ decision: { type: 'noul', noul: 0.9 } }))
    expect(calls[0]?.state).toEqual({ ticket: 1 })
    expect(calls[0]?.questions).toEqual({ decision: NOUL_QUESTION })
  })

  it('forwards a per-call model override', async () => {
    const { client, calls } = fakeClient(async () => response({ decision: { noul: 0.5 } }))
    const ctx = mount({}, { client })

    await ctx.jev.callSystemOne({ state: 'x', questions: { decision: NOUL_QUESTION }, model: 'jev-1.12.0' })

    expect(calls[0]?.model).toBe('jev-1.12.0')
  })

  it('forwards the resolved model when the caller omits it', async () => {
    const { client, calls } = fakeClient(async () => response({ decision: { noul: 0.5 } }))
    const ctx = mount({ model: 'jev-1.13.0' }, { client })

    await ctx.jev.callSystemOne({ state: 'x', questions: { decision: NOUL_QUESTION } })

    // The resolved model is forwarded rather than the caller's option bag, so
    // the request always matches the model the cache key was derived from.
    expect(calls[0]?.model).toBe('jev-1.13.0')
  })

  const BAD_RESPONSES: ReadonlyArray<readonly [label: string, payload: unknown]> = [
    ['a missing model', { answers: { decision: { noul: 0.5 } }, usage: USAGE }],
    ['a missing usage', { model: 'm', answers: { decision: { noul: 0.5 } } }],
    ['a missing answers map', { model: 'm', usage: USAGE }],
    ['an empty answers map', { model: 'm', answers: {}, usage: USAGE }],
    ['a non-object answer', { model: 'm', answers: { decision: 'nope' }, usage: USAGE }],
  ]

  for (const [label, payload] of BAD_RESPONSES) {
    it(`rejects ${label} with JevValidationError and counts a failure`, async () => {
      const { client } = fakeClient(async () => payload)
      const ctx = mount({}, { client })

      await expect(ctx.jev.callSystemOne({ state: 'x', questions: { decision: NOUL_QUESTION } }))
        .rejects.toBeInstanceOf(JevValidationError)
      expect(ctx.jev.stats().failures).toBe(1)
    })
  }

  it('counts one call per successful request', async () => {
    const { client } = fakeClient(async () => response({ decision: { noul: 0.5 } }))
    const ctx = mount({}, { client })

    await ctx.jev.callSystemOne({ state: 'a', questions: { decision: NOUL_QUESTION } })
    await ctx.jev.callSystemOne({ state: 'b', questions: { decision: NOUL_QUESTION } })

    expect(ctx.jev.stats().calls).toBe(2)
    expect(ctx.jev.stats().failures).toBe(0)
  })

  it('propagates the transport error object unchanged', async () => {
    const failure = new JevNetworkError('socket closed')
    const { client } = fakeClient(async () => { throw failure })
    const ctx = mount({}, { client })

    await expect(ctx.jev.callSystemOne({ state: 'x', questions: { decision: NOUL_QUESTION } }))
      .rejects.toBe(failure)
  })
})

describe('response cache', () => {
  it('is inert by default, so identical calls reach the transport twice', async () => {
    const { client, calls } = fakeClient(async () => response({ decision: { noul: 0.5 } }))
    const ctx = mount({}, { client })

    await ctx.jev.callSystemOne({ state: 'x', questions: { decision: NOUL_QUESTION } })
    await ctx.jev.callSystemOne({ state: 'x', questions: { decision: NOUL_QUESTION } })

    expect(calls).toHaveLength(2)
    expect(ctx.jev.stats().cache).toEqual({ hits: 0, misses: 0, entries: 0 })
  })

  it('serves a repeated request from the cache and does not count it as a call', async () => {
    const { client, calls } = fakeClient(async () => response({ decision: { noul: 0.5 } }))
    const ctx = mount({ cache: { enabled: true, maxEntries: 10, ttlMs: 60_000 } }, { client })

    await ctx.jev.callSystemOne({ state: 'x', questions: { decision: NOUL_QUESTION } })
    await ctx.jev.callSystemOne({ state: 'x', questions: { decision: NOUL_QUESTION } })

    expect(calls).toHaveLength(1)
    expect(ctx.jev.stats().cache.hits).toBe(1)
    expect(ctx.jev.stats().calls).toBe(1)
  })

  it('treats a different state as a different request', async () => {
    const { client, calls } = fakeClient(async () => response({ decision: { noul: 0.5 } }))
    const ctx = mount({ cache: { enabled: true, maxEntries: 10, ttlMs: 60_000 } }, { client })

    await ctx.jev.callSystemOne({ state: 'a', questions: { decision: NOUL_QUESTION } })
    await ctx.jev.callSystemOne({ state: 'b', questions: { decision: NOUL_QUESTION } })

    expect(calls).toHaveLength(2)
  })

  it('treats a different model as a different request', async () => {
    const { client, calls } = fakeClient(async () => response({ decision: { noul: 0.5 } }))
    const ctx = mount({ cache: { enabled: true, maxEntries: 10, ttlMs: 60_000 } }, { client })

    await ctx.jev.callSystemOne({ state: 'x', questions: { decision: NOUL_QUESTION }, model: 'jev-1.13.0' })
    await ctx.jev.callSystemOne({ state: 'x', questions: { decision: NOUL_QUESTION }, model: 'jev-1.12.0' })

    expect(calls).toHaveLength(2)
  })
})

describe('admission policy', () => {
  const OPEN_CONFIG = { policy: { enabled: true, failureThreshold: 2, openMs: 1_000, minIntervalMs: 0 } }

  it('is inert by default, so repeated failures never refuse a call', async () => {
    const { client, calls } = fakeClient(async () => { throw new JevNetworkError('down') })
    const ctx = mount({}, { client })

    for (let attempt = 0; attempt < 4; attempt += 1) {
      await expect(ctx.jev.callSystemOne({ state: 'x', questions: { decision: NOUL_QUESTION } })).rejects.toThrow()
    }

    expect(calls).toHaveLength(4)
    expect(ctx.jev.stats().policy.circuit).toBe('closed')
  })

  it('opens after the threshold and refuses the next call without touching the transport', async () => {
    const { client, calls } = fakeClient(async () => { throw new JevNetworkError('down') })
    const ctx = mount(OPEN_CONFIG, { client })
    const call = () => ctx.jev.callSystemOne({ state: 'x', questions: { decision: NOUL_QUESTION } })

    await expect(call()).rejects.toBeInstanceOf(JevNetworkError)
    await expect(call()).rejects.toBeInstanceOf(JevNetworkError)
    await expect(call()).rejects.toBeInstanceOf(JevCircuitOpenError)

    expect(calls).toHaveLength(2)
    expect(ctx.jev.stats().policy.circuit).toBe('open')
    expect(ctx.jev.stats().policy.circuitOpens).toBe(1)
    expect(ctx.jev.stats().policy.rejectedByCircuit).toBe(1)
  })

  it('does not count a refused call as a call or a failure', async () => {
    const { client } = fakeClient(async () => { throw new JevNetworkError('down') })
    const ctx = mount(OPEN_CONFIG, { client })

    await expect(ctx.jev.callSystemOne({ state: 'x', questions: { decision: NOUL_QUESTION } })).rejects.toThrow()
    await expect(ctx.jev.callSystemOne({ state: 'x', questions: { decision: NOUL_QUESTION } })).rejects.toThrow()
    const opened = ctx.jev.stats()

    await expect(ctx.jev.callSystemOne({ state: 'x', questions: { decision: NOUL_QUESTION } }))
      .rejects.toBeInstanceOf(JevCircuitOpenError)

    expect(ctx.jev.stats().calls).toBe(opened.calls)
    expect(ctx.jev.stats().failures).toBe(opened.failures)
  })

  it('surfaces the refusal as JevCircuitOpenError with its own code', async () => {
    const { client } = fakeClient(async () => { throw new JevNetworkError('down') })
    const ctx = mount(OPEN_CONFIG, { client })

    await expect(ctx.jev.callSystemOne({ state: 'x', questions: { decision: NOUL_QUESTION } })).rejects.toThrow()
    await expect(ctx.jev.callSystemOne({ state: 'x', questions: { decision: NOUL_QUESTION } })).rejects.toThrow()

    const refusal = await ctx.jev.callSystemOne({ state: 'x', questions: { decision: NOUL_QUESTION } })
      .then(() => undefined, (error: unknown) => error as JevCircuitOpenError)
    expect(refusal).toBeInstanceOf(JevCircuitOpenError)
    expect(refusal?.code).toBe('JEV_CIRCUIT_OPEN')
  })

  it('leaves the circuit closed for caller-side rejections', async () => {
    const { client, calls } = fakeClient(async () => { throw new JevHttpError(401, 'unauthorized') })
    const ctx = mount(OPEN_CONFIG, { client })

    for (let attempt = 0; attempt < 5; attempt += 1) {
      await expect(ctx.jev.callSystemOne({ state: 'x', questions: { decision: NOUL_QUESTION } })).rejects.toThrow()
    }

    expect(calls).toHaveLength(5)
    expect(ctx.jev.stats().policy.circuit).toBe('closed')
    expect(ctx.jev.stats().failures).toBe(0)
  })
})

describe('convenience methods', () => {
  it('noul returns the typed answer and asks under the decision id', async () => {
    const { client, calls } = fakeClient(async () => response({ decision: { type: 'noul', noul: 0.9 } }))
    const ctx = mount({}, { client })

    expect(await ctx.jev.noul('text', 'Is it urgent?')).toEqual({ type: 'noul', noul: 0.9 })
    expect(calls[0]?.questions).toEqual({ decision: { type: 'noul', instructions: 'Is it urgent?' } })
  })

  it('noul forwards criteria when given', async () => {
    const { client, calls } = fakeClient(async () => response({ decision: { type: 'noul', noul: 0.9 } }))
    const ctx = mount({}, { client })

    await ctx.jev.noul('text', 'Is it urgent?', { yes: 'urgent', no: 'routine' })

    expect(calls[0]?.questions).toEqual({
      decision: { type: 'noul', instructions: 'Is it urgent?', criteria: { yes: 'urgent', no: 'routine' } },
    })
  })

  it('choice returns the typed answer and forwards the criteria map', async () => {
    const { client, calls } = fakeClient(async () => response({
      decision: { type: 'choice', choice: 'billing', probabilities: { billing: 0.9, sales: 0.1 }, confidence: 0.8 },
    }))
    const ctx = mount({}, { client })

    expect(await ctx.jev.choice('text', 'Which team?', { billing: null, sales: null })).toEqual({
      type: 'choice', choice: 'billing', probabilities: { billing: 0.9, sales: 0.1 }, confidence: 0.8,
    })
    expect(calls[0]?.questions).toEqual({
      decision: { type: 'choice', instructions: 'Which team?', criteria: { billing: null, sales: null } },
    })
  })

  it('score returns the typed answer including the legend and forwards ordered levels', async () => {
    const { client, calls } = fakeClient(async () => response({
      decision: {
        type: 'score',
        score: 2.98,
        legend: { '0': 'low', '1': 'medium', '2': 'high' },
        probabilities: { '0': 0, '1': 0.02, '2': 0.98 },
        confidence: 0.98,
      },
    }))
    const ctx = mount({}, { client })

    expect(await ctx.jev.score('text', 'How urgent?', ['low', 'medium', 'high'])).toEqual({
      type: 'score',
      score: 2.98,
      legend: { '0': 'low', '1': 'medium', '2': 'high' },
      probabilities: { '0': 0, '1': 0.02, '2': 0.98 },
      confidence: 0.98,
    })
    expect(calls[0]?.questions).toEqual({
      decision: { type: 'score', instructions: 'How urgent?', criteria: ['low', 'medium', 'high'] },
    })
  })

  const MALFORMED: ReadonlyArray<readonly [label: string, answer: unknown]> = [
    ['a noul answer with a string probability', { type: 'noul', noul: 'high' }],
    ['a choice answer whose label has no probability', { type: 'choice', choice: 'x', probabilities: {}, confidence: 0.5 }],
    ['a score answer without confidence', { type: 'score', score: 1, probabilities: { '0': 1 } }],
    ['an answer with an unknown type', { type: 'mystery' }],
  ]

  for (const [label, answer] of MALFORMED) {
    it(`rejects ${label}`, async () => {
      const { client } = fakeClient(async () => response({ decision: answer as JevAnswer }))
      const ctx = mount({}, { client })

      await expect(ctx.jev.noul('text', 'q')).rejects.toBeInstanceOf(JevValidationError)
    })
  }
})

describe('configuration', () => {
  it('surfaces a missing API key as JevConfigError without counting a service failure', async () => {
    const ctx = mount({ apiKeyEnv: 'ABSENT_JEV_KEY' })

    await expect(ctx.jev.callSystemOne({ state: 'x', questions: { decision: NOUL_QUESTION } }))
      .rejects.toBeInstanceOf(JevConfigError)
    expect(ctx.jev.stats().failures).toBe(0)
    expect(ctx.jev.stats().calls).toBe(1)
  })

  it('resolves the configured default model into the request', async () => {
    const { client, calls } = fakeClient(async () => response({ decision: { noul: 0.5 } }))
    const ctx = mount({ model: 'jev-1.13.0' }, { client })

    await ctx.jev.callSystemOne({ state: 'x', questions: { decision: NOUL_QUESTION } })

    // A caller-supplied override reaches the transport verbatim.
    await ctx.jev.callSystemOne({ state: 'x', questions: { decision: NOUL_QUESTION }, model: 'jev-1.12.0' })

    expect(calls[1]?.model).toBe('jev-1.12.0')
  })
})

describe('maxStateChars', () => {
  it('rejects a state over the limit with both the actual and the configured size', async () => {
    const { client, calls } = fakeClient(async () => response({ decision: { noul: 0.5 } }))
    const ctx = mount({ maxStateChars: 10 }, { client })

    const error = await ctx.jev.callSystemOne({ state: 'x'.repeat(11), questions: { decision: NOUL_QUESTION } })
      .then(() => undefined, (caught: unknown) => caught)

    expect(error).toBeInstanceOf(JevValidationError)
    expect((error as JevValidationError).message).toContain('11')
    expect((error as JevValidationError).message).toContain('10')
    expect(calls).toHaveLength(0)
    expect(ctx.jev.stats().calls).toBe(0)
    expect(ctx.jev.stats().failures).toBe(0)
  })

  it('accepts a state exactly at the limit', async () => {
    const { client } = fakeClient(async () => response({ decision: { noul: 0.5 } }))
    const ctx = mount({ maxStateChars: 10 }, { client })

    await expect(ctx.jev.callSystemOne({ state: 'x'.repeat(10), questions: { decision: NOUL_QUESTION } }))
      .resolves.toBeDefined()
  })

  it('treats zero as unlimited', async () => {
    const { client } = fakeClient(async () => response({ decision: { noul: 0.5 } }))
    const ctx = mount({ maxStateChars: 0 }, { client })

    await expect(ctx.jev.callSystemOne({ state: 'x'.repeat(5_000), questions: { decision: NOUL_QUESTION } }))
      .resolves.toBeDefined()
  })

  it('measures the JSON serialization rather than a string coercion', async () => {
    // String(['aaaaaaaaaa','aaaaaaaaaa']) is 21 characters; its JSON form is 27.
    // A limit of 25 therefore accepts a string-coercion implementation and rejects
    // a serialization-based one, pinning the documented measurement.
    const state = ['aaaaaaaaaa', 'aaaaaaaaaa']
    expect(String(state)).toHaveLength(21)
    expect(JSON.stringify(state)).toHaveLength(27)

    const { client } = fakeClient(async () => response({ decision: { noul: 0.5 } }))
    const ctx = mount({ maxStateChars: 25 }, { client })

    await expect(ctx.jev.callSystemOne({ state, questions: { decision: NOUL_QUESTION } }))
      .rejects.toBeInstanceOf(JevValidationError)
  })

  it('does not cache a rejected state', async () => {
    const { client } = fakeClient(async () => response({ decision: { noul: 0.5 } }))
    const ctx = mount({ maxStateChars: 3, cache: { enabled: true, maxEntries: 10, ttlMs: 60_000 } }, { client })

    await expect(ctx.jev.callSystemOne({ state: 'xxxx', questions: { decision: NOUL_QUESTION } }))
      .rejects.toBeInstanceOf(JevValidationError)

    expect(ctx.jev.stats().cache.entries).toBe(0)
  })

  it('reports a non-serializable state as JevValidationError rather than TypeError', async () => {
    const { client } = fakeClient(async () => response({ decision: { noul: 0.5 } }))
    const ctx = mount({}, { client })
    const circular: Record<string, unknown> = {}
    circular['self'] = circular

    const error = await ctx.jev
      .callSystemOne({ state: circular as unknown as JevState, questions: { decision: NOUL_QUESTION } })
      .then(() => undefined, (caught: unknown) => caught)

    expect(error).toBeInstanceOf(JevValidationError)
    expect(error).not.toBeInstanceOf(TypeError)
    expect(ctx.jev.stats().calls).toBe(0)
  })
})

describe('token accounting', () => {
  it('accumulates the usage reported by successful calls', async () => {
    const { client } = fakeClient(async () => response({ decision: { noul: 0.5 } }))
    const ctx = mount({}, { client })

    await ctx.jev.callSystemOne({ state: 'a', questions: { decision: NOUL_QUESTION } })
    expect(ctx.jev.stats().tokens).toEqual({ input: USAGE.input_tokens, output: USAGE.output_tokens })

    await ctx.jev.callSystemOne({ state: 'b', questions: { decision: NOUL_QUESTION } })
    expect(ctx.jev.stats().tokens).toEqual({
      input: USAGE.input_tokens * 2,
      output: USAGE.output_tokens * 2,
    })
  })

  it('does not count a cache hit, which performs no API call', async () => {
    const { client } = fakeClient(async () => response({ decision: { noul: 0.5 } }))
    const ctx = mount({ cache: { enabled: true, maxEntries: 10, ttlMs: 60_000 } }, { client })

    await ctx.jev.callSystemOne({ state: 'same', questions: { decision: NOUL_QUESTION } })
    await ctx.jev.callSystemOne({ state: 'same', questions: { decision: NOUL_QUESTION } })

    expect(ctx.jev.stats().cache.hits).toBe(1)
    expect(ctx.jev.stats().tokens).toEqual({ input: USAGE.input_tokens, output: USAGE.output_tokens })
  })

  it('does not count a failed call, which has no usage', async () => {
    const { client } = fakeClient(async () => {
      throw new JevNetworkError('offline')
    })
    const ctx = mount({}, { client })

    await expect(ctx.jev.callSystemOne({ state: 'x', questions: { decision: NOUL_QUESTION } }))
      .rejects.toBeInstanceOf(JevNetworkError)

    expect(ctx.jev.stats().tokens).toEqual({ input: 0, output: 0 })
  })

  it('reports the same counters through another context view', async () => {
    const { client } = fakeClient(async () => response({ decision: { noul: 0.5 } }))
    const ctx = mount({}, { client })
    const other = ctx.isolate('other-view')
    expect(other.jev).not.toBe(ctx.jev)

    await ctx.jev.callSystemOne({ state: 'x', questions: { decision: NOUL_QUESTION } })

    // Whatever the view mechanism, one context's activity must be visible from
    // another: a hook calling through its own view is what the counters describe.
    expect(other.jev.stats().tokens.input).toBe(USAGE.input_tokens)
    expect(other.jev.stats().calls).toBe(1)
  })
})

describe('observability', () => {
  /**
   * Build a clock the client double advances, so a call's latency is an exact
   * number of milliseconds without touching a real timer.
   * @param perCall - milliseconds each successive call consumes.
   * @returns the injected `now` plus the step the client double performs.
   */
  function steppingClock(perCall: readonly number[]): { now: () => number; tick: () => void } {
    let now = 0
    let index = 0
    return {
      now: () => now,
      tick: () => {
        now += perCall[index] ?? 0
        index += 1
      },
    }
  }

  /** A well-formed response carrying a specific model id. */
  function responseWithModel(model: string): JevResponse {
    return { model, answers: { decision: { noul: 0.5 } }, usage: USAGE }
  }

  it('starts with no latency and no observed model', () => {
    const { client } = fakeClient(async () => response({ decision: { noul: 0.5 } }))
    const stats = mount({}, { client }).jev.stats()

    expect(stats.lastLatencyMs).toBe(0)
    expect(stats.totalLatencyMs).toBe(0)
    expect(stats.models).toEqual([])
  })

  it('records the latency and the model of one successful call', async () => {
    const clock = steppingClock([120])
    const { client } = fakeClient(async () => {
      clock.tick()
      return responseWithModel('jev-1.13.0')
    })
    const ctx = mount({}, { client, now: clock.now })

    await ctx.jev.callSystemOne({ state: 'x', questions: { decision: NOUL_QUESTION } })

    const stats = ctx.jev.stats()
    expect(stats.lastLatencyMs).toBe(120)
    expect(stats.totalLatencyMs).toBe(120)
    expect(stats.models).toEqual(['jev-1.13.0'])
  })

  it('reports the last latency separately from the running total', async () => {
    const clock = steppingClock([120, 30])
    const { client } = fakeClient(async () => {
      clock.tick()
      return response({ decision: { noul: 0.5 } })
    })
    const ctx = mount({}, { client, now: clock.now })

    await ctx.jev.callSystemOne({ state: 'a', questions: { decision: NOUL_QUESTION } })
    await ctx.jev.callSystemOne({ state: 'b', questions: { decision: NOUL_QUESTION } })

    const stats = ctx.jev.stats()
    expect(stats.lastLatencyMs).toBe(30)
    expect(stats.totalLatencyMs).toBe(150)
  })

  it('de-duplicates a repeated model and keeps first-seen order', async () => {
    const clock = steppingClock([10, 10, 10])
    const models = ['jev-1.13.0', 'jev-1.12.0', 'jev-1.13.0']
    const { client } = fakeClient(async () => {
      clock.tick()
      return responseWithModel(models.shift() ?? 'jev-1.13.0')
    })
    const ctx = mount({}, { client, now: clock.now })

    await ctx.jev.callSystemOne({ state: 'a', questions: { decision: NOUL_QUESTION } })
    await ctx.jev.callSystemOne({ state: 'b', questions: { decision: NOUL_QUESTION } })
    await ctx.jev.callSystemOne({ state: 'c', questions: { decision: NOUL_QUESTION } })

    expect(ctx.jev.stats().models).toEqual(['jev-1.13.0', 'jev-1.12.0'])
  })

  it('leaves latency untouched when the response comes from the cache', async () => {
    const clock = steppingClock([120, 999])
    const { client } = fakeClient(async () => {
      clock.tick()
      return response({ decision: { noul: 0.5 } })
    })
    const ctx = mount({ cache: { enabled: true, maxEntries: 10, ttlMs: 60_000 } }, { client, now: clock.now })

    await ctx.jev.callSystemOne({ state: 'x', questions: { decision: NOUL_QUESTION } })
    await ctx.jev.callSystemOne({ state: 'x', questions: { decision: NOUL_QUESTION } })

    const stats = ctx.jev.stats()
    expect(stats.cache.hits).toBe(1)
    expect(stats.lastLatencyMs).toBe(120)
    expect(stats.totalLatencyMs).toBe(120)
    expect(stats.models).toEqual(['jev-1.13.0'])
  })

  it('leaves latency and models untouched when the call fails', async () => {
    const clock = steppingClock([50, 50])
    const { client } = fakeClient(async () => {
      clock.tick()
      throw new JevNetworkError('socket closed')
    })
    const ctx = mount({}, { client, now: clock.now })

    await expect(ctx.jev.callSystemOne({ state: 'x', questions: { decision: NOUL_QUESTION } }))
      .rejects.toBeInstanceOf(JevNetworkError)

    const stats = ctx.jev.stats()
    expect(stats.calls).toBe(1)
    expect(stats.failures).toBe(1)
    expect(stats.lastLatencyMs).toBe(0)
    expect(stats.totalLatencyMs).toBe(0)
    expect(stats.models).toEqual([])
  })

  it('returns a snapshot whose model list later activity does not mutate', async () => {
    const clock = steppingClock([10, 10])
    const models = ['jev-1.13.0', 'jev-1.12.0']
    const { client } = fakeClient(async () => {
      clock.tick()
      return responseWithModel(models.shift() ?? 'jev-1.13.0')
    })
    const ctx = mount({}, { client, now: clock.now })

    await ctx.jev.callSystemOne({ state: 'a', questions: { decision: NOUL_QUESTION } })
    const before = ctx.jev.stats()
    await ctx.jev.callSystemOne({ state: 'b', questions: { decision: NOUL_QUESTION } })

    expect(before.models).toEqual(['jev-1.13.0'])
    expect(before.lastLatencyMs).toBe(10)
    expect(ctx.jev.stats().models).toEqual(['jev-1.13.0', 'jev-1.12.0'])
  })

  it('reports the same observability counters through another context view', async () => {
    const clock = steppingClock([80])
    const { client } = fakeClient(async () => {
      clock.tick()
      return responseWithModel('jev-1.13.0')
    })
    const ctx = mount({}, { client, now: clock.now })
    const other = ctx.isolate('other-view')

    await ctx.jev.callSystemOne({ state: 'x', questions: { decision: NOUL_QUESTION } })

    expect(other.jev.stats().lastLatencyMs).toBe(80)
    expect(other.jev.stats().totalLatencyMs).toBe(80)
    expect(other.jev.stats().models).toEqual(['jev-1.13.0'])
  })
})

describe('retry auditing', () => {
  it('starts at zero retries', () => {
    const { client } = fakeClient(async () => response({ decision: { noul: 0.5 } }))
    const ctx = mount({}, { client })

    expect(ctx.jev.stats().retries).toBe(0)
  })

  it('counts retries performed by the transport the service built', async () => {
    const payload = {
      model: 'jev-1.13.0',
      answers: { decision: { type: 'noul', noul: 0.5 } },
      usage: USAGE,
    }
    const fetchMock = vi.fn()
      .mockRejectedValueOnce(new Error('offline'))
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValue(new Response(JSON.stringify(payload), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }))
    vi.stubGlobal('fetch', fetchMock)
    onTestFinished(() => { vi.unstubAllGlobals() })
    const ctx = mount({ apiKey: 'test-key', retry: { maxAttempts: 3, baseDelayMs: 0, maxDelayMs: 0 } })

    await ctx.jev.callSystemOne({ state: 'x', questions: { decision: NOUL_QUESTION } })

    expect(ctx.jev.stats().retries).toBe(2)
    expect(ctx.jev.stats().calls).toBe(1)
  })

  it('cannot observe retries inside an injected transport', async () => {
    // The injected double never retries, and a retrying one would be invisible:
    // the service counts only the transport it constructed itself.
    const { client } = fakeClient(async () => response({ decision: { noul: 0.5 } }))
    const ctx = mount({ retry: { maxAttempts: 3, baseDelayMs: 0, maxDelayMs: 0 } }, { client })

    await ctx.jev.callSystemOne({ state: 'x', questions: { decision: NOUL_QUESTION } })

    expect(ctx.jev.stats().retries).toBe(0)
  })
})

describe('quota exhaustion', () => {
  it('counts the failure and stops reaching the transport during the cooldown', async () => {
    const { client, calls } = fakeClient(async () => { throw new JevQuotaError('quota exhausted') })
    // The admission policy is explicitly off here: the cooldown lives in the
    // service precisely so that a deployment running only the offline rule layer
    // still gets it, which is the whole reason it is not a policy setting.
    const ctx = mount({ policy: { enabled: false } }, { client })

    await expect(
      ctx.jev.callSystemOne({ state: 'x', questions: { decision: NOUL_QUESTION } }),
    ).rejects.toBeInstanceOf(JevQuotaError)

    expect(ctx.jev.stats().failures).toBe(1)
    expect(calls).toHaveLength(1)

    await expect(
      ctx.jev.callSystemOne({ state: 'x', questions: { decision: NOUL_QUESTION } }),
    ).rejects.toBeInstanceOf(JevQuotaError)

    // A refusal is not a call: the transport is untouched, and the counter says
    // how many requests the cooldown saved.
    expect(calls).toHaveLength(1)
    expect(ctx.jev.stats().calls).toBe(1)
    expect(ctx.jev.stats().quotaRejections).toBe(1)
  })

  it('resumes once the cooldown elapses', async () => {
    let now = 1_000
    const { client, calls } = fakeClient(async () => { throw new JevQuotaError('quota exhausted') })
    const ctx = mount({ quotaCooldownMs: 60_000 }, { client, now: () => now })

    const call = () => ctx.jev.callSystemOne({ state: 'x', questions: { decision: NOUL_QUESTION } })
    await expect(call()).rejects.toBeInstanceOf(JevQuotaError)
    await expect(call()).rejects.toBeInstanceOf(JevQuotaError)
    expect(calls).toHaveLength(1)

    now += 60_000
    await expect(call()).rejects.toBeInstanceOf(JevQuotaError)
    // The cooldown expired, so this attempt really reached the transport.
    expect(calls).toHaveLength(2)
  })

  it('treats a zero cooldown as no cooldown', async () => {
    const { client, calls } = fakeClient(async () => { throw new JevQuotaError('quota exhausted') })
    const ctx = mount({ quotaCooldownMs: 0 }, { client })

    const call = () => ctx.jev.callSystemOne({ state: 'x', questions: { decision: NOUL_QUESTION } })
    await expect(call()).rejects.toBeInstanceOf(JevQuotaError)
    await expect(call()).rejects.toBeInstanceOf(JevQuotaError)

    expect(calls).toHaveLength(2)
    expect(ctx.jev.stats().quotaRejections).toBe(0)
  })
})
