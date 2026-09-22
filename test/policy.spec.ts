/** Contract tests for the call-admission policy. @module dsh-jev/test/policy */

import { describe, expect, it } from 'vitest'

import type { ResolvedPolicyConfig } from '../src/config.ts'
import { JevCircuitOpenError } from '../src/errors.ts'
import { JevPolicy } from '../src/policy.ts'
import { isRetryable } from '../src/retry.ts'

const BASE: ResolvedPolicyConfig = {
  enabled: true,
  failureThreshold: 3,
  openMs: 1000,
  minIntervalMs: 0,
}

/**
 * Build a policy over a controllable clock.
 * The injected wait advances that clock, which is what makes the spacing gap
 * observable to the next call.
 * @param overrides - policy fields replacing the base configuration.
 * @returns the policy, a clock handle, and the recorded wait durations.
 */
function harness(overrides: Partial<ResolvedPolicyConfig> = {}): {
  policy: JevPolicy
  advance: (ms: number) => void
  waits: number[]
} {
  let time = 0
  const waits: number[] = []
  const policy = new JevPolicy({
    config: { ...BASE, ...overrides },
    now: () => time,
    sleep: async (ms: number) => {
      waits.push(ms)
      time += ms
    },
  })
  return { policy, advance: (ms: number) => { time += ms }, waits }
}

/** Capture the rejection from one `admit()` call. */
async function refusal(policy: JevPolicy): Promise<unknown> {
  return policy.admit().then(
    () => undefined,
    (error: unknown) => error,
  )
}

describe('disabled policy', () => {
  it('admits every call and counts nothing', async () => {
    const { policy } = harness({ enabled: false })

    await policy.admit()
    for (let index = 0; index < 10; index += 1) policy.record('failure')
    await policy.admit()

    expect(policy.stats()).toEqual({
      rejectedByCircuit: 0,
      spacedCalls: 0,
      circuitOpens: 0,
      circuit: 'closed',
    })
  })

  it('never waits even with a spacing interval configured', async () => {
    const { policy, waits } = harness({ enabled: false, minIntervalMs: 500 })

    await policy.admit()
    await policy.admit()

    expect(waits).toEqual([])
  })
})

describe('circuit breaker', () => {
  it('opens once the failure streak reaches the threshold', async () => {
    const { policy } = harness()

    policy.record('failure')
    policy.record('failure')
    await expect(policy.admit()).resolves.toBeUndefined()
    policy.record('failure')

    const error = await refusal(policy)
    expect(error).toBeInstanceOf(JevCircuitOpenError)
    expect((error as JevCircuitOpenError).code).toBe('JEV_CIRCUIT_OPEN')
    expect(policy.stats()).toMatchObject({ circuit: 'open', circuitOpens: 1, rejectedByCircuit: 1 })
  })

  it('refuses every call while the open window lasts, counting each one', async () => {
    const { policy, advance } = harness({ openMs: 1000 })
    for (let index = 0; index < 3; index += 1) policy.record('failure')

    advance(999)
    expect(await refusal(policy)).toBeInstanceOf(JevCircuitOpenError)
    expect(await refusal(policy)).toBeInstanceOf(JevCircuitOpenError)

    expect(policy.stats()).toMatchObject({ circuit: 'open', rejectedByCircuit: 2 })
  })

  it('admits exactly one probe once the window elapses', async () => {
    const { policy, advance } = harness({ openMs: 1000 })
    for (let index = 0; index < 3; index += 1) policy.record('failure')

    advance(1000)
    await expect(policy.admit()).resolves.toBeUndefined()
    expect(policy.stats().circuit).toBe('half-open')

    expect(await refusal(policy)).toBeInstanceOf(JevCircuitOpenError)
    expect(await refusal(policy)).toBeInstanceOf(JevCircuitOpenError)
    expect(policy.stats()).toMatchObject({ circuit: 'half-open', rejectedByCircuit: 2 })
  })

  it('closes and clears the streak when the probe succeeds', async () => {
    const { policy, advance } = harness({ openMs: 1000 })
    for (let index = 0; index < 3; index += 1) policy.record('failure')

    advance(1000)
    await policy.admit()
    policy.record('success')

    expect(policy.stats()).toMatchObject({ circuit: 'closed', circuitOpens: 1 })
    // The streak restarted, so two more failures must not reopen the circuit.
    policy.record('failure')
    policy.record('failure')
    await expect(policy.admit()).resolves.toBeUndefined()
    expect(policy.stats().circuit).toBe('closed')
  })

  it('reopens and restarts the window when the probe fails', async () => {
    const { policy, advance } = harness({ openMs: 1000 })
    for (let index = 0; index < 3; index += 1) policy.record('failure')

    advance(1000)
    await policy.admit()
    policy.record('failure')

    expect(policy.stats()).toMatchObject({ circuit: 'open', circuitOpens: 2 })
    advance(999)
    expect(await refusal(policy)).toBeInstanceOf(JevCircuitOpenError)
    advance(1)
    await expect(policy.admit()).resolves.toBeUndefined()
  })

  it('probes immediately when the open window is zero', async () => {
    const { policy } = harness({ openMs: 0 })
    for (let index = 0; index < 3; index += 1) policy.record('failure')

    await expect(policy.admit()).resolves.toBeUndefined()
    expect(policy.stats().circuit).toBe('half-open')
  })

  it('clears the failure streak on a success while closed', async () => {
    const { policy } = harness({ failureThreshold: 3 })

    policy.record('failure')
    policy.record('failure')
    policy.record('success')
    policy.record('failure')
    policy.record('failure')

    await expect(policy.admit()).resolves.toBeUndefined()
    expect(policy.stats()).toMatchObject({ circuit: 'closed', circuitOpens: 0 })
  })

  it('reports a snapshot that later activity does not mutate', async () => {
    const { policy } = harness()

    const before = policy.stats()
    for (let index = 0; index < 3; index += 1) policy.record('failure')
    await refusal(policy)

    expect(before).toMatchObject({ rejectedByCircuit: 0, circuitOpens: 0, circuit: 'closed' })
    expect(policy.stats()).toMatchObject({ rejectedByCircuit: 1, circuitOpens: 1, circuit: 'open' })
  })

  it('produces an error that is never retried', () => {
    expect(isRetryable(new JevCircuitOpenError('open'))).toBe(false)
  })
})

describe('call spacing', () => {
  it('does not wait for the first call', async () => {
    const { policy, waits } = harness({ minIntervalMs: 200 })

    await policy.admit()

    expect(waits).toEqual([])
    expect(policy.stats().spacedCalls).toBe(0)
  })

  it('waits exactly the remaining gap', async () => {
    const { policy, waits, advance } = harness({ minIntervalMs: 200 })

    await policy.admit()
    advance(150)
    await policy.admit()

    expect(waits).toEqual([50])
    expect(policy.stats().spacedCalls).toBe(1)
  })

  it('waits the whole interval when calls arrive back to back', async () => {
    const { policy, waits } = harness({ minIntervalMs: 200 })

    await policy.admit()
    await policy.admit()
    await policy.admit()

    expect(waits).toEqual([200, 200])
    expect(policy.stats().spacedCalls).toBe(2)
  })

  it('does not wait once the interval has already elapsed', async () => {
    const { policy, waits, advance } = harness({ minIntervalMs: 200 })

    await policy.admit()
    advance(500)
    await policy.admit()

    expect(waits).toEqual([])
    expect(policy.stats().spacedCalls).toBe(0)
  })

  it('never waits when the interval is zero', async () => {
    const { policy, waits } = harness({ minIntervalMs: 0 })

    await policy.admit()
    await policy.admit()

    expect(waits).toEqual([])
  })

  it('does not let a refused call move the spacing clock', async () => {
    const { policy, waits, advance } = harness({ minIntervalMs: 200, openMs: 250 })
    await policy.admit()
    for (let index = 0; index < 3; index += 1) policy.record('failure')

    // Refused at 100, probed at 250. Measured from the last admitted call the gap
    // is the full 250 ms, so no wait is due; had the refusal moved the clock the
    // gap would read 150 ms and this call would wait 50 ms.
    advance(100)
    expect(await refusal(policy)).toBeInstanceOf(JevCircuitOpenError)
    advance(150)
    await policy.admit()

    expect(waits).toEqual([])
  })
})
