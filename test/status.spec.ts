/** `/jev-status` report rendering. @module dsh-jev/test/status */

import { describe, expect, it } from 'vitest'

import { renderStatus, type JevStatusInput } from '../src/status.ts'

/** An inert but valid report: everything off, every counter zero. */
function base(overrides: Partial<JevStatusInput> = {}): JevStatusInput {
  return {
    model: 'jev-latest',
    baseURL: 'https://api.typesafe.ai/v1',
    apiKeySource: 'environment',
    tools: { decide: true, evaluate: true },
    guard: { enabled: false, inspected: 0, allowed: 0, asked: 0, denied: 0, errors: 0 },
    rules: { enabled: false, inspected: 0, denied: 0 },
    telemetry: { enabled: false, offered: 0, emitted: 0, sampled: 0, sinkErrors: 0 },
    service: { calls: 0, failures: 0, retries: 0, inputTokens: 0, outputTokens: 0, models: [] },
    health: { status: 'unknown', reasons: [] },
    ...overrides,
  }
}

/** A report from a deployment where every layer has seen work. */
function busy(): JevStatusInput {
  return base({
    apiKeySource: 'config',
    guard: { enabled: true, inspected: 12, allowed: 10, asked: 1, denied: 1, errors: 0 },
    rules: { enabled: true, inspected: 12, denied: 1 },
    telemetry: { enabled: true, offered: 12, emitted: 12, sampled: 0, sinkErrors: 0 },
    service: { calls: 11, failures: 1, retries: 2, inputTokens: 3_840, outputTokens: 210, models: ['jev-1.13.0'] },
    health: { status: 'healthy', reasons: [] },
  })
}

describe('renderStatus', () => {
  it('renders an inert deployment without throwing', () => {
    const text = renderStatus(base())

    expect(text).toContain('Jev status')
    expect(text).toContain('offline rules')
    expect(text).toContain('off')
  })

  it('names the missing key and what to set', () => {
    const text = renderStatus(base({ apiKeySource: 'missing' }))

    expect(text).toContain('missing')
    expect(text).toContain('apiKeyEnv')
  })

  it('distinguishes a configured key from an environment key', () => {
    expect(renderStatus(base({ apiKeySource: 'config' }))).toContain('from config')
    expect(renderStatus(base({ apiKeySource: 'environment' }))).toContain('from environment')
  })

  it('reports every section and counter when all layers have worked', () => {
    const text = renderStatus(busy())

    expect(text).toContain('jev-1.13.0')
    expect(text).toContain('in 3,840 / out 210')
    expect(text).toContain('retries')
    expect(text).toContain('allowed / asked / denied')
    expect(text).toContain('10 / 1 / 1')
    expect(text).toContain('healthy')
  })

  it('is deterministic for identical input', () => {
    expect(renderStatus(busy())).toStrictEqual(renderStatus(busy()))
  })

  it('surfaces records lost to sampling and to a throwing sink', () => {
    const text = renderStatus(base({
      telemetry: { enabled: true, offered: 10, emitted: 7, sampled: 2, sinkErrors: 1 },
    }))

    expect(text).toContain('sampled away')
    expect(text).toContain('sink errors')
    expect(text).toContain('dropped by sampling')
    expect(text).toContain('lost because the sink threw')
  })

  it('exposes a gate that is on but has inspected nothing', () => {
    const text = renderStatus(base({
      guard: { enabled: true, inspected: 0, allowed: 0, asked: 0, denied: 0, errors: 0 },
    }))

    expect(text).toContain('inspected nothing')
  })

  it('exposes that no interception is active at all', () => {
    expect(renderStatus(base())).toContain('no interception is active')
  })

  it('lists each health reason when the status is not healthy', () => {
    const text = renderStatus(base({
      health: { status: 'degraded', reasons: ['error rate 0.60 reached the 0.50 threshold', 'circuit is open'] },
    }))

    expect(text).toContain('degraded')
    expect(text).toContain('error rate 0.60 reached the 0.50 threshold')
    expect(text).toContain('circuit is open')
  })

  it('notes an unusable tool surface', () => {
    const text = renderStatus(base({ tools: { decide: false, evaluate: false } }))

    expect(text).toContain('both tools are disabled')
  })

  it('tolerates empty models, empty reasons, and zeroed counters', () => {
    const text = renderStatus(base({ service: { calls: 0, failures: 0, retries: 0, inputTokens: 0, outputTokens: 0, models: [] } }))

    expect(text).toContain('none recorded yet')
    expect(text).toContain('n/a')
  })

  it('says so when nothing is inert', () => {
    // Every enabled layer has seen work and nothing failed, so no note applies.
    const text = renderStatus(base({
      guard: { enabled: true, inspected: 3, allowed: 3, asked: 0, denied: 0, errors: 0 },
      rules: { enabled: true, inspected: 3, denied: 0 },
      telemetry: { enabled: true, offered: 3, emitted: 3, sampled: 0, sinkErrors: 0 },
      service: { calls: 3, failures: 0, retries: 0, inputTokens: 10, outputTokens: 5, models: ['jev-1.13.0'] },
    }))

    expect(text).toContain('nothing inert')
  })
})
