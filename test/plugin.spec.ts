/** Plugin assembly: registration, registry dispatch, rendering, and disposal. @module dsh-jev/test/plugin */

import { Context } from '@deepseek-ai/cordis'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { defineTool, type ToolExecutionSuccess } from '@deepseek-ai/dsh-tools'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { Config, ResolvedRetryConfig } from '../src/config.ts'
import * as JevPlugin from '../src/index.ts'
import type { JevResponse } from '../src/protocol.ts'

const INSTANT_RETRY: ResolvedRetryConfig = { maxAttempts: 1, baseDelayMs: 0, maxDelayMs: 0 }

const DECIDE_RESPONSE: JevResponse = {
  model: 'jev-1.13.0',
  answers: { decision: { type: 'noul', noul: 0.93 } },
  usage: { input_tokens: 312, output_tokens: 20 },
}

const EVALUATE_RESPONSE: JevResponse = {
  model: 'jev-1.13.0',
  answers: {
    department: { type: 'choice', choice: 'billing', probabilities: { billing: 0.9 }, confidence: 0.8 },
    is_urgent: { type: 'noul', noul: 1 },
  },
  usage: { input_tokens: 392, output_tokens: 65 },
}

/**
 * Replace `fetch` with one canned JSON response.
 * @param response - body the transport receives.
 * @returns the recording fetch double.
 */
function stubFetch(response: JevResponse): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn(async () => new Response(JSON.stringify(response), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  }))
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

/**
 * Mount the prompt and tool services, then the plugin under test.
 * @param config - plugin configuration overrides.
 * @param apiKey - configured API key, or `null` to leave the plugin without one.
 * @returns the context, the plugin's fork, and a registry-backed call helper.
 */
async function fixture(config: Partial<Config> = {}, apiKey: string | null = 'test-key') {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  const fork = await ctx.plugin(JevPlugin, { ...apiKey === null ? {} : { apiKey }, ...config })
  const call = (name: string, args: unknown) => ctx.tools.execute({
    name,
    arguments: args,
    callId: ToolCallId('jev-call'),
    signal: new AbortController().signal,
  })
  return { ctx, fork, call }
}

/**
 * Narrow one registry outcome to a successful execution.
 * @param result - outcome returned by `ctx.tools.execute`.
 * @returns the successful outcome.
 */
function success(result: Awaited<ReturnType<ToolRuntime['execute']>>): ToolExecutionSuccess {
  if (result.isError) throw new Error(`expected a successful call, received: ${JSON.stringify(result.content)}`)
  return result
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('dsh-jev plugin assembly', () => {
  it('exports the bundle identity and configuration schema', () => {
    expect(JevPlugin.name).toBe('tool-jev')
    expect(JevPlugin.inject).toEqual(['tools'])
    expect(typeof JevPlugin.Config).toBe('function')
  })

  it('registers both Jev tools', async () => {
    const { ctx, fork } = await fixture()

    expect(ctx.tools.get('jev_decide')?.name).toBe('jev_decide')
    expect(ctx.tools.get('jev_evaluate')?.name).toBe('jev_evaluate')

    await fork.dispose()
    await ctx.fiber.dispose()
  })

  it('exposes the shared service, and the tools count against that same instance', async () => {
    stubFetch(DECIDE_RESPONSE)
    const { ctx, call } = await fixture({ retry: INSTANT_RETRY })

    expect(ctx.jev).toBeDefined()
    expect(ctx.jev.stats().calls).toBe(0)

    await call('jev_decide', { state: 'x', question: 'y', kind: 'noul' })

    // A dispatch reaching the service proves the tools hold the service the
    // context publishes, not a second instance built beside it.
    expect(ctx.jev.stats().calls).toBe(1)
    await ctx.fiber.dispose()
  })

  it('withdraws the service when the plugin fiber is disposed', async () => {
    const { ctx, fork } = await fixture()

    expect(ctx.jev).toBeDefined()
    await fork.dispose()

    expect(ctx.jev).toBeUndefined()
    await ctx.fiber.dispose()
  })

  it('unregisters both tools when the plugin fiber is disposed', async () => {
    const { ctx, fork } = await fixture()

    await fork.dispose()

    expect(ctx.tools.get('jev_decide')).toBeUndefined()
    expect(ctx.tools.get('jev_evaluate')).toBeUndefined()
    await ctx.fiber.dispose()
  })

  it('dispatches jev_decide and renders a summary followed by the canonical envelope', async () => {
    const fetchMock = stubFetch(DECIDE_RESPONSE)
    const { ctx, call } = await fixture({ retry: INSTANT_RETRY })

    const result = success(await call('jev_decide', {
      state: 'Payouts have been failing for three days.',
      question: 'Does this message convey urgency?',
      kind: 'noul',
    }))

    expect(result.value).toEqual({
      model: 'jev-1.13.0',
      answer: { type: 'noul', noul: 0.93 },
      usage: { input_tokens: 312, output_tokens: 20 },
    })
    // The model sees a readable summary line and then the complete canonical
    // envelope, so nothing is lost to the nicer presentation.
    expect(result.content).toHaveLength(1)
    const block = result.content[0]
    const text = block?.type === 'text' ? block.text : ''
    expect(text).toMatch(/noul: yes, p=0\.93/)
    expect(text.endsWith(JSON.stringify(result.value, null, 2))).toBe(true)
    const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)) as Record<string, unknown>
    expect(body['questions']).toEqual({
      decision: { type: 'noul', instructions: 'Does this message convey urgency?' },
    })
    await ctx.fiber.dispose()
  })

  it('dispatches jev_evaluate and passes the native question map through', async () => {
    const fetchMock = stubFetch(EVALUATE_RESPONSE)
    const { ctx, call } = await fixture({ retry: INSTANT_RETRY })

    const questions = {
      department: { type: 'choice', instructions: 'Which team?', criteria: { billing: null, technical: null } },
      is_urgent: { type: 'noul', instructions: 'Is it urgent?' },
    }
    const result = success(await call('jev_evaluate', { state: { ticket: 42 }, questions }))

    expect(result.value).toEqual({
      model: 'jev-1.13.0',
      answers: EVALUATE_RESPONSE.answers,
      usage: { input_tokens: 392, output_tokens: 65 },
    })
    const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)) as Record<string, unknown>
    expect(body['state']).toEqual({ ticket: 42 })
    expect(body['questions']).toEqual(questions)
    await ctx.fiber.dispose()
  })

  it('targets the configured base URL, model, and bearer token', async () => {
    const fetchMock = stubFetch(DECIDE_RESPONSE)
    const { ctx, call } = await fixture({
      apiKey: 'secret-key',
      baseURL: 'https://example.test/v1',
      model: 'jev-1.13.0',
      retry: INSTANT_RETRY,
    })

    await call('jev_decide', { state: 'x', question: 'y', kind: 'noul' })

    const [url, init] = fetchMock.mock.calls[0] ?? []
    expect(url).toBe('https://example.test/v1/systemone')
    expect(init?.headers).toMatchObject({ Authorization: 'Bearer secret-key' })
    expect(JSON.parse(String(init?.body))).toMatchObject({ model: 'jev-1.13.0' })
    await ctx.fiber.dispose()
  })

  it('reports a missing API key as a failed call naming the environment variable', async () => {
    const fetchMock = stubFetch(DECIDE_RESPONSE)
    const { ctx, call } = await fixture({ apiKeyEnv: 'TYPESAFE_API_KEY' }, null)

    const result = await call('jev_decide', { state: 'x', question: 'y', kind: 'noul' })

    expect(result.isError).toBe(true)
    expect(JSON.stringify(result.content)).toContain('TYPESAFE_API_KEY')
    expect(fetchMock).not.toHaveBeenCalled()
    await ctx.fiber.dispose()
  })

  it('rejects arguments the parameter schema forbids', async () => {
    const { ctx, call } = await fixture()

    const result = await call('jev_decide', { state: 'x', question: 'y', kind: 'guessing' })

    expect(result.isError).toBe(true)
    expect(JSON.stringify(result.content)).toContain('kind')
    await ctx.fiber.dispose()
  })

  it('omits a tool the deployment disabled', async () => {
    const { ctx } = await fixture({ enableDecide: false })

    expect(ctx.tools.get('jev_decide')).toBeUndefined()
    expect(ctx.tools.get('jev_evaluate')?.name).toBe('jev_evaluate')
    await ctx.fiber.dispose()
  })
})

/** Question the guarded fixture asks, used to tell a risk check from a tool call. */
const RISK_QUESTION = 'How risky is this call?'

/**
 * Register the tool the gate intercepts; its body records that dispatch happened.
 * @param ctx - mounted context.
 * @param ran - counter the body increments.
 */
function registerProbe(ctx: Context, ran: { count: number }): void {
  ctx.tools.register(defineTool({
    name: 'probe_tool',
    description: 'Probe tool the risk gate inspects.',
    parameters: { note: { type: 'string', required: true, description: 'A note.' } },
    output: {
      schema: { type: 'json' },
      render: () => [{ type: 'text', text: 'probe ran' }],
    },
    execute() {
      ran.count += 1
      return Promise.resolve({ ran: true })
    },
  }))
}

/**
 * Answer the risk check with a fixed score and every other call with a noul answer.
 * @param score - risk score the gate receives.
 * @returns the recording fetch double.
 */
function stubScoredFetch(score: number): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn(async (_url: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as { questions?: Record<string, { instructions?: string }> }
    const isRiskCheck = body.questions?.['decision']?.instructions === RISK_QUESTION
    const answer = isRiskCheck
      ? { type: 'score', score, legend: { 0: 'low', 1: 'medium', 2: 'high', 3: 'critical' }, probabilities: { 0: 1 }, confidence: 0.9 }
      : { type: 'noul', noul: 0.5 }
    return new Response(JSON.stringify({
      model: 'jev-1.13.0',
      answers: { decision: answer },
      usage: { input_tokens: 10, output_tokens: 5 },
    }), { status: 200, headers: { 'content-type': 'application/json' } })
  })
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

/**
 * Mount the plugin with the risk gate enabled over `probe_tool`.
 * The returned fetch double decides what the gate scores, so the score is not a
 * parameter here.
 * @returns the context, the plugin fork, the probe's run counter, and a call helper.
 */
async function guardedFixture() {
  const ctx = new Context()
  const ran = { count: 0 }
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  registerProbe(ctx, ran)
  const fork = await ctx.plugin(JevPlugin, {
    apiKey: 'test-key',
    retry: INSTANT_RETRY,
    guard: {
      enabled: true,
      tools: ['probe_tool'],
      question: RISK_QUESTION,
      levels: ['low', 'medium', 'high', 'critical'],
      denyAt: 2,
      askAt: 1,
    },
  })
  const call = () => ctx.tools.execute({
    name: 'probe_tool',
    arguments: { note: 'do the thing' },
    callId: ToolCallId('guarded-call'),
    signal: new AbortController().signal,
  })
  return { ctx, fork, ran, call }
}

describe('pre-execute risk gate through the registry', () => {
  it('lets a low-risk call through by delegating to the next listener', async () => {
    stubScoredFetch(0)
    const { ctx, ran, call } = await guardedFixture()

    const result = await call()

    // Reaching the body proves the waterfall was delegated to rather than short-circuited.
    expect(result.isError).toBe(false)
    expect(ran.count).toBe(1)
    await ctx.fiber.dispose()
  })

  it('denies a high-risk call before its body runs', async () => {
    stubScoredFetch(3)
    const { ctx, ran, call } = await guardedFixture()

    const result = await call()

    expect(result.isError).toBe(true)
    expect(JSON.stringify(result.content)).toContain('risk gate')
    expect(ran.count).toBe(0)
    await ctx.fiber.dispose()
  })

  it('stops intercepting once the plugin fiber is disposed', async () => {
    stubScoredFetch(3)
    const { ctx, fork, ran, call } = await guardedFixture()

    await fork.dispose()
    const result = await call()

    // The same high-risk call now runs: the listener went away with its plugin.
    expect(result.isError).toBe(false)
    expect(ran.count).toBe(1)
    await ctx.fiber.dispose()
  })

  it('does not inspect anything while the gate is disabled', async () => {
    const fetchMock = stubFetch(DECIDE_RESPONSE)
    const ctx = new Context()
    const ran = { count: 0 }
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    registerProbe(ctx, ran)
    await ctx.plugin(JevPlugin, { apiKey: 'test-key', retry: INSTANT_RETRY })

    const result = await ctx.tools.execute({
      name: 'probe_tool',
      arguments: { note: 'go' },
      callId: ToolCallId('unguarded-call'),
      signal: new AbortController().signal,
    })

    expect(result.isError).toBe(false)
    expect(ran.count).toBe(1)
    expect(fetchMock).not.toHaveBeenCalled()
    await ctx.fiber.dispose()
  })
})

/** Ops records a fake telemetry backend received. */
interface FakeTelemetry {
  records: Array<{ channel: string; severity: string; attributes: Record<string, string | number>; body: unknown }>
}

/**
 * Mount the plugin with a telemetry backend provided and logging enabled.
 * @param telemetryConfig - telemetry overrides applied over `log: true`.
 * @returns the context, the recording backend, and a dispatch helper.
 */
async function telemetryFixture(telemetryConfig: Record<string, unknown> = {}) {
  const backend: FakeTelemetry = { records: [] }
  const ctx = new Context()
  // Provided before the plugin applies: the entry reads this service during
  // apply, so it must already exist to be observed at all.
  ctx.provide('sessionTelemetry', { emit: (record: FakeTelemetry['records'][number]) => { backend.records.push(record) } })
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(JevPlugin, {
    apiKey: 'test-key',
    retry: INSTANT_RETRY,
    telemetry: { log: true, ...telemetryConfig },
  })
  const call = (name: string, args: unknown) => ctx.tools.execute({
    name,
    arguments: args,
    callId: ToolCallId('telemetry-call'),
    signal: new AbortController().signal,
  })
  return { ctx, backend, call }
}

describe('observability wiring', () => {
  it('reports unknown health before the sample is large enough', async () => {
    stubFetch(DECIDE_RESPONSE)
    const { ctx, call } = await fixture({ retry: INSTANT_RETRY })

    await call('jev_decide', { state: 'x', question: 'y', kind: 'noul' })

    // One call is below the default alertMinCalls, so the verdict is undecided.
    expect(ctx.jev.health()).toEqual({ status: 'unknown', reasons: [] })
    expect(ctx.jev.stats().retries).toBe(0)
    await ctx.fiber.dispose()
  })

  it('reports degraded once a small sample exceeds the error-rate threshold', async () => {
    const fetchMock = vi.fn(async () => new Response('boom', { status: 500 }))
    vi.stubGlobal('fetch', fetchMock)
    const { ctx, call } = await fixture({
      retry: INSTANT_RETRY,
      telemetry: { alertMinCalls: 1, errorRateAlert: 0.5 },
    })

    const result = await call('jev_decide', { state: 'x', question: 'y', kind: 'noul' })

    expect(result.isError).toBe(true)
    const health = ctx.jev.health()
    expect(health.status).toBe('degraded')
    expect(health.reasons.length).toBeGreaterThan(0)
    await ctx.fiber.dispose()
  })

  it('emits one ops record per call to the provided backend', async () => {
    stubFetch(DECIDE_RESPONSE)
    const { ctx, backend, call } = await telemetryFixture()

    await call('jev_decide', { state: 'x', question: 'y', kind: 'noul' })

    expect(backend.records).toHaveLength(1)
    const record = backend.records[0]
    expect(record?.channel).toBe('ops')
    expect(record?.attributes['telemetry.op']).toBe('jev.call')
    expect(record?.attributes['jev.outcome']).toBe('success')
    expect(record?.attributes['jev.cache']).toBe('miss')
    // The redacted body carries no state, so the judged text cannot leak into a backend.
    expect(JSON.stringify(record?.body)).not.toContain('"x"')
    await ctx.fiber.dispose()
  })

  it('records a cache hit without claiming latency or tokens', async () => {
    stubFetch(DECIDE_RESPONSE)
    const backend: FakeTelemetry = { records: [] }
    const ctx = new Context()
    ctx.provide('sessionTelemetry', { emit: (record: FakeTelemetry['records'][number]) => { backend.records.push(record) } })
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(JevPlugin, {
      apiKey: 'test-key',
      retry: INSTANT_RETRY,
      cache: { enabled: true, ttlMs: 60_000, maxEntries: 10 },
      telemetry: { log: true },
    })
    const dispatch = () => ctx.tools.execute({
      name: 'jev_decide',
      arguments: { state: 'same', question: 'y', kind: 'noul' },
      callId: ToolCallId('cached-call'),
      signal: new AbortController().signal,
    })

    await dispatch()
    await dispatch()

    const hits = backend.records.filter(record => record.attributes['jev.cache'] === 'hit')
    expect(hits).toHaveLength(1)
    // A hit performs no transport work, so it reports neither latency nor tokens.
    expect(hits[0]?.attributes['jev.latency_ms']).toBe(0)
    expect(hits[0]?.attributes['jev.input_tokens']).toBe(0)
    await ctx.fiber.dispose()
  })

  it('loads and serves calls when no telemetry backend is mounted', async () => {
    stubFetch(DECIDE_RESPONSE)
    const { ctx, call } = await fixture({ retry: INSTANT_RETRY, telemetry: { log: true } })

    // No sessionTelemetry service exists here: the guarded lookup must degrade
    // to counting instead of failing the plugin load.
    const result = await call('jev_decide', { state: 'x', question: 'y', kind: 'noul' })

    expect(result.isError).toBe(false)
    expect(ctx.jev.stats().calls).toBe(1)
    await ctx.fiber.dispose()
  })
})
