import { describe, expect, it, vi } from 'vitest'

import { resolveConfig, type ResolvedContextConfig } from '../src/config.ts'
import type { CallSystemOneOptions } from '../src/client.ts'
import { JevContext, type ContextMessage } from '../src/context.ts'
import type { JevAnswer, JevResponse } from '../src/protocol.ts'
import type { JevService } from '../src/service.ts'

/** Pruning configuration used by most cases: 4 messages trigger, newest 2 reserved. */
const CONFIG: ResolvedContextConfig = resolveConfig({
  context: { enabled: true, triggerMessages: 4, keepRecent: 2, dropBelow: 0.3 },
}).context

/**
 * Build a conversation of numbered messages.
 * @param count - number of messages.
 * @returns messages oldest first, each carrying its index in the text.
 */
function conversation(count: number): ContextMessage[] {
  return Array.from({ length: count }, (_, index) => ({ role: 'user', text: `message ${String(index)}` }))
}

/**
 * Build a response carrying one `noul` answer per key.
 * @param probabilities - answer key to probability.
 * @returns a well-formed Jev response.
 */
function scored(probabilities: Record<string, number>): JevResponse {
  const answers: Record<string, JevAnswer> = {}
  for (const [key, noul] of Object.entries(probabilities)) answers[key] = { type: 'noul', noul }
  return { model: 'jev-1.13.0', answers, usage: { input_tokens: 1, output_tokens: 1 } }
}

/**
 * Build a context hook over a recording service double.
 * @param respond - produces the response for one call, or rejects.
 * @param config - pruning configuration; defaults to {@link CONFIG}.
 * @returns the hook and the options each call received.
 */
function harness(
  respond: (options: CallSystemOneOptions) => Promise<unknown>,
  config: ResolvedContextConfig = CONFIG,
): { context: JevContext; calls: CallSystemOneOptions[] } {
  const calls: CallSystemOneOptions[] = []
  const callSystemOne = vi.fn(async (options: CallSystemOneOptions) => {
    calls.push(options)
    return respond(options)
  })
  const service = { callSystemOne } as unknown as JevService
  return { context: new JevContext({ service, config }), calls }
}

/** Answer every candidate with one probability. */
const always = (noul: number) => async (options: CallSystemOneOptions) =>
  scored(Object.fromEntries(Object.keys(options.questions).map(key => [key, noul])))

describe('JevContext scope', () => {
  it('keeps everything while pruning is disabled', async () => {
    const disabled = resolveConfig({ context: { enabled: false } }).context
    const { context, calls } = harness(always(0), disabled)

    expect(await context.plan(conversation(50))).toEqual({ kind: 'keep' })
    expect(calls).toHaveLength(0)
    expect(context.stats()).toEqual({ passes: 0, dropped: 0, errors: 0 })
  })

  it('keeps everything below the trigger without counting a pass', async () => {
    const { context, calls } = harness(always(0))

    expect(await context.plan(conversation(3))).toEqual({ kind: 'keep' })
    expect(calls).toHaveLength(0)
    expect(context.stats().passes).toBe(0)
  })

  it('judges exactly at the trigger', async () => {
    const { context, calls } = harness(always(0))

    // Four messages with the newest two reserved leaves two candidates, both scored 0.
    expect(await context.plan(conversation(4))).toEqual({ kind: 'prune', drop: [0, 1] })
    expect(calls).toHaveLength(1)
    expect(context.stats().passes).toBe(1)
  })
})

describe('JevContext candidate range', () => {
  it('only asks about the prefix before the reserved tail', async () => {
    const { context, calls } = harness(always(1))

    await context.plan(conversation(6))

    expect(Object.keys(calls[0]?.questions ?? {})).toEqual(['m0', 'm1', 'm2', 'm3'])
  })

  it('only sends the prunable prefix as state', async () => {
    const { context, calls } = harness(always(1))

    await context.plan(conversation(6))

    const state = calls[0]?.state as { messages: { text: string }[] }
    expect(state.messages.map(message => message.text)).toEqual([
      'message 0', 'message 1', 'message 2', 'message 3',
    ])
  })

  it('asks a noul question per candidate', async () => {
    const { context, calls } = harness(always(1))

    await context.plan(conversation(5))

    expect(calls[0]?.questions['m0']).toEqual({ type: 'noul', instructions: CONFIG.question })
    expect(Object.keys(calls[0]?.questions ?? {})).toHaveLength(3)
  })
})

describe('JevContext decisions', () => {
  it('drops only the messages scored below the threshold, ascending', async () => {
    const { context } = harness(async () => scored({ m0: 0.1, m1: 0.9, m2: 0.05, m3: 0.8 }))

    expect(await context.plan(conversation(6))).toEqual({ kind: 'prune', drop: [0, 2] })
    expect(context.stats().dropped).toBe(2)
  })

  it('keeps a candidate whose answer is missing', async () => {
    const { context } = harness(async () => scored({ m0: 0.01, m2: 0.01 }))

    expect(await context.plan(conversation(6))).toEqual({ kind: 'prune', drop: [0, 2] })
  })

  it('keeps a candidate whose probability is not a number', async () => {
    const { context } = harness(async () => ({
      model: 'jev-1.13.0',
      answers: { m0: { type: 'noul', noul: '0.01' }, m1: { type: 'noul', noul: 0.01 }, m2: {}, m3: { type: 'noul', noul: 0.01 } },
      usage: { input_tokens: 1, output_tokens: 1 },
    }))

    expect(await context.plan(conversation(6))).toEqual({ kind: 'prune', drop: [1, 3] })
  })

  it('never drops the newest message when keepRecent is 0', async () => {
    const config = resolveConfig({ context: { enabled: true, triggerMessages: 3, keepRecent: 0, dropBelow: 0.3 } }).context
    const { context } = harness(always(0), config)

    expect(await context.plan(conversation(4))).toEqual({ kind: 'prune', drop: [0, 1, 2] })
  })

  it('returns keep rather than an empty prune', async () => {
    const { context } = harness(always(0.9))

    expect(await context.plan(conversation(6))).toEqual({ kind: 'keep' })
    expect(context.stats().dropped).toBe(0)
  })
})

describe('JevContext failures', () => {
  it.each([
    ['an Error', new Error('boom')],
    ['a string', 'boom'],
    ['null', null],
  ])('keeps everything when the judgement rejects with %s', async (_label, rejection) => {
    const { context } = harness(async () => { throw rejection })

    expect(await context.plan(conversation(6))).toEqual({ kind: 'keep' })
    expect(context.stats()).toEqual({ passes: 1, dropped: 0, errors: 1 })
  })
})

describe('JevContext bookkeeping', () => {
  it('forwards the cancellation signal', async () => {
    const { context, calls } = harness(always(1))
    const controller = new AbortController()

    await context.plan(conversation(4), controller.signal)

    expect(calls[0]?.signal).toBe(controller.signal)
  })

  it('omits the signal key when none is passed', async () => {
    const { context, calls } = harness(always(1))

    await context.plan(conversation(4))

    expect(calls[0] !== undefined && 'signal' in calls[0]).toBe(false)
  })

  it('accumulates passes and drops across calls', async () => {
    const { context } = harness(async () => scored({ m0: 0.1, m1: 0.1 }))

    await context.plan(conversation(4))
    await context.plan(conversation(4))
    await context.plan(conversation(1))

    expect(context.stats()).toEqual({ passes: 2, dropped: 4, errors: 0 })
  })

  it('returns a snapshot that later passes do not mutate', async () => {
    const { context } = harness(async () => scored({ m0: 0.1, m1: 0.1 }))

    await context.plan(conversation(4))
    const snapshot = context.stats()
    await context.plan(conversation(4))

    expect(snapshot).toEqual({ passes: 1, dropped: 2, errors: 0 })
  })
})
