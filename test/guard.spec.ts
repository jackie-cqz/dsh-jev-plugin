/** Contract tests for the pre-execute risk gate. @module dsh-jev/test/guard */

import { describe, expect, it, vi } from 'vitest'

import type { ResolvedConfidenceConfig, ResolvedGuardConfig } from '../src/config.ts'
import { JevNetworkError, JevTimeoutError } from '../src/errors.ts'
import { JevGuard, type GuardCall } from '../src/guard.ts'
import type { ScoreAnswer } from '../src/protocol.ts'
import type { JevService } from '../src/service.ts'

const BANDS: ResolvedConfidenceConfig = { approveAt: 0.8, escalateBelow: 0.5 }

/** Gate configuration with the gate on and every tool in scope. */
function guardConfig(overrides: Partial<ResolvedGuardConfig> = {}): ResolvedGuardConfig {
  return {
    enabled: true,
    tools: [],
    question: 'How risky is this call?',
    levels: ['low', 'medium', 'high', 'critical'],
    denyAt: 3,
    askAt: 2,
    reviseAt: 3,
    escalateOnLowConfidence: true,
    onError: 'allow',
    ...overrides,
  }
}

/** A well-formed score answer. */
function answer(score: number, confidence = 0.9): ScoreAnswer {
  return { type: 'score', score, confidence, probabilities: {} }
}

/** Build a gate over a recording service double. */
function fixture(
  resolution: ScoreAnswer | (() => Promise<ScoreAnswer>) = answer(0),
  config: ResolvedGuardConfig = guardConfig(),
  bands: ResolvedConfidenceConfig = BANDS,
): { guard: JevGuard; score: ReturnType<typeof vi.fn> } {
  const score = vi.fn(typeof resolution === 'function' ? resolution : async () => resolution)
  const service = { score } as unknown as JevService
  return { guard: new JevGuard({ service, config, bands }), score }
}

const CALL: GuardCall = { name: 'bash', arguments: { command: 'ls' } }

describe('scope', () => {
  it('allows everything without asking Jev when the gate is off', async () => {
    const { guard, score } = fixture(answer(3), guardConfig({ enabled: false }))

    expect(await guard.decide(CALL)).toEqual({ kind: 'allow' })
    expect(score).not.toHaveBeenCalled()
    expect(guard.stats()).toEqual({ inspected: 0, allowed: 0, revised: 0, asked: 0, denied: 0, errors: 0 })
  })

  it('skips tools outside the configured list without counting them', async () => {
    const { guard, score } = fixture(answer(3), guardConfig({ tools: ['bash'] }))

    expect(await guard.decide({ name: 'read', arguments: {} })).toEqual({ kind: 'allow' })
    expect(score).not.toHaveBeenCalled()
    expect(guard.stats().inspected).toBe(0)

    expect(await guard.decide({ name: 'bash', arguments: {} })).toEqual({ kind: 'deny', reason: expect.any(String) })
    expect(guard.stats().inspected).toBe(1)
  })

  it('inspects every tool when the list is empty', async () => {
    const { guard, score } = fixture(answer(0), guardConfig({ tools: [] }))

    await guard.decide({ name: 'read', arguments: {} })
    await guard.decide({ name: 'write', arguments: {} })

    expect(score).toHaveBeenCalledTimes(2)
    expect(guard.stats().inspected).toBe(2)
  })
})

describe('score bands', () => {
  it('denies at exactly denyAt', async () => {
    const { guard } = fixture(answer(3))

    const decision = await guard.decide(CALL)

    expect(decision.kind).toBe('deny')
    expect(guard.stats()).toEqual({ inspected: 1, allowed: 0, revised: 0, asked: 0, denied: 1, errors: 0 })
  })

  it('asks at exactly askAt', async () => {
    const { guard } = fixture(answer(2))

    const decision = await guard.decide(CALL)

    expect(decision.kind).toBe('ask')
    expect(guard.stats()).toEqual({ inspected: 1, allowed: 0, revised: 0, asked: 1, denied: 0, errors: 0 })
  })

  it('allows below askAt with a confident answer', async () => {
    const { guard } = fixture(answer(1, 0.9))

    expect(await guard.decide(CALL)).toEqual({ kind: 'allow' })
    expect(guard.stats()).toEqual({ inspected: 1, allowed: 1, revised: 0, asked: 0, denied: 0, errors: 0 })
  })

  it('puts the level label in the reason', async () => {
    const { guard } = fixture(answer(3))

    const decision = await guard.decide(CALL)

    expect(decision.kind === 'deny' && decision.reason).toContain('critical')
    expect(decision.kind === 'deny' && decision.reason).toContain('3/3')
  })
})

describe('low-confidence escalation', () => {
  it('asks when confidence falls below the configured threshold', async () => {
    const { guard } = fixture(answer(1, 0.31))

    const decision = await guard.decide(CALL)

    expect(decision.kind).toBe('ask')
    expect(decision.kind === 'ask' && decision.reason).toContain('0.31')
    expect(guard.stats().asked).toBe(1)
  })

  it('allows the same answer when the escalation is switched off', async () => {
    const { guard } = fixture(answer(1, 0.31), guardConfig({ escalateOnLowConfidence: false }))

    expect(await guard.decide(CALL)).toEqual({ kind: 'allow' })
    expect(guard.stats().allowed).toBe(1)
  })

  it('does not escalate exactly at the threshold', async () => {
    const { guard } = fixture(answer(1, 0.5))

    expect(await guard.decide(CALL)).toEqual({ kind: 'allow' })
  })
})

describe('out-of-scale scores', () => {
  it.each([-5, 99])('does not throw or print an undefined label for score %s', async (value) => {
    const { guard } = fixture(answer(value))

    const decision = await guard.decide(CALL)

    expect(decision.kind === 'deny' && decision.reason).not.toContain('undefined')
    expect(guard.stats().errors).toBe(0)
  })
})

describe('Jev failures', () => {
  it('allows under onError: allow and counts the error', async () => {
    const { guard } = fixture(async () => { throw new JevNetworkError('socket closed') }, guardConfig({ onError: 'allow' }))

    expect(await guard.decide(CALL)).toEqual({ kind: 'allow' })
    expect(guard.stats()).toEqual({ inspected: 1, allowed: 1, revised: 0, asked: 0, denied: 0, errors: 1 })
  })

  it('denies under onError: deny and counts the error', async () => {
    const { guard } = fixture(async () => { throw new JevTimeoutError('Jev request timed out after 10000 ms.') }, guardConfig({ onError: 'deny' }))

    const decision = await guard.decide(CALL)

    expect(decision.kind).toBe('deny')
    // The reason names the stable error code rather than the message: a
    // JevHttpError message carries a server response body, and a reason is
    // model-visible and durable.
    expect(decision.kind === 'deny' && decision.reason).toContain('JEV_TIMEOUT')
    expect(guard.stats()).toEqual({ inspected: 1, allowed: 0, revised: 0, asked: 0, denied: 1, errors: 1 })
  })

  it.each([
    ['an Error', new Error('boom')],
    ['a string', 'boom'],
    ['null', null],
    ['undefined', undefined],
    ['a number', 7],
  ])('never throws when the service rejects with %s', async (_label, rejection) => {
    const { guard } = fixture(async () => { throw rejection }, guardConfig({ onError: 'deny' }))

    const decision = await guard.decide(CALL)

    expect(decision.kind).toBe('deny')
    expect(guard.stats().errors).toBe(1)
  })
})

describe('reason safety', () => {
  const SECRET = 'sk-secret-value'
  const SECRET_CALL: GuardCall = { name: 'bash', arguments: { command: `curl -H "Authorization: ${SECRET}"` } }

  it.each([
    ['deny', answer(3)],
    ['ask', answer(2)],
    ['low confidence', answer(0, 0.1)],
  ])('omits the arguments from a %s reason', async (_label, resolution) => {
    const { guard } = fixture(resolution)

    const decision = await guard.decide(SECRET_CALL)

    expect(decision.kind === 'allow' ? '' : decision.reason).not.toContain(SECRET)
  })

  it('omits the arguments from an onError reason', async () => {
    const { guard } = fixture(async () => { throw new Error('failed') }, guardConfig({ onError: 'deny' }))

    const decision = await guard.decide(SECRET_CALL)

    expect(decision.kind === 'allow' ? '' : decision.reason).not.toContain(SECRET)
  })

  it('sends the tool name and arguments to Jev as the decision state', async () => {
    const { guard, score } = fixture(answer(0))

    await guard.decide(CALL)

    expect(score.mock.calls[0]?.[0]).toEqual({ tool: 'bash', arguments: { command: 'ls' } })
    expect(score.mock.calls[0]?.[1]).toBe('How risky is this call?')
    expect(score.mock.calls[0]?.[2]).toEqual(['low', 'medium', 'high', 'critical'])
  })
})

  it('omits the arguments from a revise reason', async () => {
    const secret = 'sk-secret-value'
    const { guard } = fixture(answer(2), guardConfig({ askAt: 1, reviseAt: 2, denyAt: 3 }))

    const decision = await guard.decide({
      name: 'bash',
      arguments: { command: `curl -H "Authorization: ${secret}"` },
    })

    expect(decision.kind).toBe('revise')
    expect(decision.kind === 'revise' && decision.reason).not.toContain(secret)
  })

describe('cancellation', () => {
  it('forwards the caller signal to the decision service', async () => {
    const { guard, score } = fixture(answer(0))
    const controller = new AbortController()

    await guard.decide({ ...CALL, signal: controller.signal })

    expect(score.mock.calls[0]?.[3]).toBe(controller.signal)
  })

  it('forwards undefined when the caller passed no signal', async () => {
    const { guard, score } = fixture(answer(0))

    await guard.decide(CALL)

    expect(score.mock.calls[0]?.[3]).toBeUndefined()
  })
})

describe('stats', () => {
  it('returns a snapshot that later decisions do not mutate', async () => {
    const { guard } = fixture(answer(0))

    const before = guard.stats()
    await guard.decide(CALL)

    expect(before).toEqual({ inspected: 0, allowed: 0, revised: 0, asked: 0, denied: 0, errors: 0 })
    expect(guard.stats().inspected).toBe(1)
  })
})

describe('revise band', () => {
  const WIDE = guardConfig({ askAt: 1, reviseAt: 2, denyAt: 3 })

  it('never revises under the default configuration, where reviseAt equals denyAt', async () => {
    for (const score of [0, 1, 2, 3]) {
      const { guard } = fixture(answer(score))

      expect((await guard.decide(CALL)).kind).not.toBe('revise')
    }
  })

  it('maps every band of a widened scale and counts it', async () => {
    const cases: ReadonlyArray<readonly [number, string]> = [
      [0, 'allow'],
      [1, 'ask'],
      [2, 'revise'],
      [3, 'deny'],
    ]

    for (const [score, kind] of cases) {
      const { guard } = fixture(answer(score), WIDE)

      expect((await guard.decide(CALL)).kind).toBe(kind)
    }

    const counted = fixture(answer(2), WIDE)
    await counted.guard.decide(CALL)

    expect(counted.guard.stats()).toEqual({
      inspected: 1,
      allowed: 0,
      revised: 1,
      asked: 0,
      denied: 0,
      errors: 0,
    })
  })

  it('denies rather than revises at exactly denyAt', async () => {
    const { guard } = fixture(answer(3), WIDE)

    const decision = await guard.decide(CALL)

    expect(decision.kind).toBe('deny')
    expect(guard.stats().revised).toBe(0)
  })

  it('tells the model how to rewrite the call', async () => {
    const { guard } = fixture(answer(2), WIDE)

    const decision = await guard.decide(CALL)

    const reason = decision.kind === 'revise' ? decision.reason : ''
    expect(reason).toMatch(/narrow|dry run|back up/i)
    expect(reason).toContain('2/3')
  })
})

describe('low-confidence escalation through verdictFor', () => {
  it('escalates below the band and allows at or above it', async () => {
    const below = fixture(answer(1, 0.49))
    expect((await below.guard.decide(CALL)).kind).toBe('ask')

    const atThreshold = fixture(answer(1, 0.5))
    expect((await atThreshold.guard.decide(CALL)).kind).toBe('allow')

    const confident = fixture(answer(1, 0.95))
    expect((await confident.guard.decide(CALL)).kind).toBe('allow')
  })

  it('routes a confidence outside the unit interval through onError instead of throwing', async () => {
    const { guard } = fixture(answer(1, 1.5), guardConfig({ onError: 'allow' }))

    expect(await guard.decide(CALL)).toEqual({ kind: 'allow' })
    expect(guard.stats()).toEqual({
      inspected: 1,
      allowed: 1,
      revised: 0,
      asked: 0,
      denied: 0,
      errors: 1,
    })
  })

  it('still denies that answer under onError: deny', async () => {
    const { guard } = fixture(answer(1, Number.NaN), guardConfig({ onError: 'deny' }))

    const decision = await guard.decide(CALL)

    expect(decision.kind).toBe('deny')
    expect(guard.stats().errors).toBe(1)
  })
})
