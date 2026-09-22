/** Contract tests for the redacted, sampled call-record path. @module dsh-jev/test/telemetry */

import { describe, expect, it, vi } from 'vitest'

import type { ResolvedTelemetryConfig } from '../src/config.ts'
import { JevTelemetry, type JevCallRecord, type TelemetrySink } from '../src/telemetry.ts'

/** Logging on at full rate: the configuration that makes sampling a no-op. */
const FULL: ResolvedTelemetryConfig = { log: true, sampleRate: 1, errorRateAlert: 0.5, alertMinCalls: 10 }

/** The nine fields a record is allowed to carry, in construction order. */
const RECORD_FIELDS = [
  'outcome',
  'model',
  'latencyMs',
  'inputTokens',
  'outputTokens',
  'retries',
  'cache',
  'errorCode',
  'serviceFailure',
] as const

/** One well-formed success record. */
function successRecord(): JevCallRecord {
  return {
    outcome: 'success',
    model: 'jev-1.13.0',
    latencyMs: 250,
    inputTokens: 300,
    outputTokens: 20,
    retries: 0,
    cache: 'miss',
    errorCode: undefined,
    serviceFailure: false,
  }
}

/**
 * Collect records handed to a sink.
 * @returns the sink and the array it appends to.
 */
function collector(): { sink: TelemetrySink; seen: JevCallRecord[] } {
  const seen: JevCallRecord[] = []
  return { sink: { record: (record) => { seen.push(record) } }, seen }
}

describe('gate and sampling', () => {
  it('does nothing at all while logging is off', () => {
    const { sink, seen } = collector()
    const telemetry = new JevTelemetry({ config: { ...FULL, log: false }, sink })

    telemetry.record(successRecord())
    telemetry.record(successRecord())

    expect(seen).toHaveLength(0)
    expect(telemetry.stats()).toEqual({ offered: 0, emitted: 0, sampled: 0, sinkErrors: 0 })
  })

  it('emits every record at full rate without consulting the random source', () => {
    const { sink, seen } = collector()
    const random = vi.fn(() => 0.999)
    const telemetry = new JevTelemetry({ config: FULL, sink, random })

    telemetry.record(successRecord())

    expect(seen).toHaveLength(1)
    expect(random).not.toHaveBeenCalled()
    expect(telemetry.stats().emitted).toBe(1)
  })

  it('drops every record at rate zero', () => {
    const { sink, seen } = collector()
    const telemetry = new JevTelemetry({ config: { ...FULL, sampleRate: 0 }, sink })

    telemetry.record(successRecord())

    expect(seen).toHaveLength(0)
    expect(telemetry.stats()).toEqual({ offered: 1, emitted: 0, sampled: 1, sinkErrors: 0 })
  })

  it('keeps a record whose draw equals the rate, because the test is strict', () => {
    const { sink, seen } = collector()
    const telemetry = new JevTelemetry({ config: { ...FULL, sampleRate: 0.5 }, sink, random: () => 0.5 })

    telemetry.record(successRecord())

    expect(seen).toHaveLength(0)
    expect(telemetry.stats().sampled).toBe(1)
  })

  it('keeps a record whose draw falls below the rate', () => {
    const { sink, seen } = collector()
    const telemetry = new JevTelemetry({ config: { ...FULL, sampleRate: 0.5 }, sink, random: () => 0.499 })

    telemetry.record(successRecord())

    expect(seen).toHaveLength(1)
  })

  it('balances offered against sampled plus emitted whenever a sink exists', () => {
    const { sink } = collector()
    const draws = [0.1, 0.9, 0.2, 0.8]
    let index = 0
    const telemetry = new JevTelemetry({
      config: { ...FULL, sampleRate: 0.5 },
      sink,
      random: () => draws[index++] ?? 0.5,
    })

    for (const _ of draws) telemetry.record(successRecord())

    const stats = telemetry.stats()
    expect(stats.offered).toBe(draws.length)
    expect(stats.offered).toBe(stats.sampled + stats.emitted)
  })
})

describe('sink failures', () => {
  it('swallows a throwing sink, counts it, and still counts the emission', () => {
    const sink: TelemetrySink = { record: () => { throw new Error('sink offline') } }
    const telemetry = new JevTelemetry({ config: FULL, sink })

    expect(() => { telemetry.record(successRecord()) }).not.toThrow()
    expect(telemetry.stats()).toEqual({ offered: 1, emitted: 1, sampled: 0, sinkErrors: 1 })
  })

  it('survives a sink that throws a non-Error value', () => {
    const sink: TelemetrySink = { record: () => { throw 'nope' } }
    const telemetry = new JevTelemetry({ config: FULL, sink })

    telemetry.record(successRecord())

    expect(telemetry.stats().sinkErrors).toBe(1)
  })

  it('counts an accepted record without emitting it when no sink is configured', () => {
    const telemetry = new JevTelemetry({ config: FULL })

    telemetry.record(successRecord())

    expect(telemetry.stats()).toEqual({ offered: 1, emitted: 0, sampled: 0, sinkErrors: 0 })
  })
})

describe('redaction', () => {
  it('forwards exactly the declared fields and nothing else', () => {
    const { sink, seen } = collector()
    const telemetry = new JevTelemetry({ config: FULL, sink })
    const smuggled = {
      ...successRecord(),
      state: 'sk-secret-value',
      arguments: { token: 'sk-secret-value' },
    } as unknown as JevCallRecord

    telemetry.record(smuggled)

    expect(seen).toHaveLength(1)
    expect(Object.keys(seen[0] ?? {}).sort()).toEqual([...RECORD_FIELDS].sort())
    expect(JSON.stringify(seen[0])).not.toContain('sk-secret-value')
  })

  it('passes a service-side failure code through as a code', () => {
    const { sink, seen } = collector()
    const telemetry = new JevTelemetry({ config: FULL, sink })

    telemetry.record({
      outcome: 'failure',
      model: undefined,
      latencyMs: 10_000,
      inputTokens: 0,
      outputTokens: 0,
      retries: 2,
      cache: 'miss',
      errorCode: 'JEV_TIMEOUT',
      serviceFailure: true,
    })

    expect(seen[0]?.errorCode).toBe('JEV_TIMEOUT')
    expect(seen[0]?.retries).toBe(2)
    expect(seen[0]?.serviceFailure).toBe(true)
  })

  it('flags a caller-side failure as not a service failure', () => {
    const { sink, seen } = collector()
    const telemetry = new JevTelemetry({ config: FULL, sink })

    telemetry.record({
      outcome: 'failure',
      model: undefined,
      latencyMs: 30,
      inputTokens: 0,
      outputTokens: 0,
      retries: 0,
      cache: 'miss',
      errorCode: 'JEV_HTTP',
      serviceFailure: false,
    })

    expect(seen[0]?.serviceFailure).toBe(false)
  })

  it('records a cache hit without transport figures', () => {
    const { sink, seen } = collector()
    const telemetry = new JevTelemetry({ config: FULL, sink })

    telemetry.record({ ...successRecord(), cache: 'hit', latencyMs: 0, retries: 0 })

    expect(seen[0]?.cache).toBe('hit')
  })
})

describe('stats', () => {
  it('returns a snapshot that later records do not mutate', () => {
    const { sink } = collector()
    const telemetry = new JevTelemetry({ config: FULL, sink })

    telemetry.record(successRecord())
    const snapshot = telemetry.stats()
    telemetry.record(successRecord())

    expect(snapshot.offered).toBe(1)
    expect(telemetry.stats().offered).toBe(2)
  })
})
