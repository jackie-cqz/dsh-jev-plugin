/** Contract tests for the DSH session-telemetry adapter. @module dsh-jev/test/dsh-telemetry */

import { describe, expect, it, vi } from 'vitest'

import {
  sessionTelemetrySink,
  severityFor,
  toSessionRecord,
  type SessionTelemetryRecord,
  type SessionTelemetrySink,
} from '../src/dsh-telemetry.ts'
import type { JevCallRecord } from '../src/telemetry.ts'

/**
 * Build one call record, overriding whatever the case cares about.
 * @param overrides - fields to replace on the default success record.
 * @returns a complete record.
 */
function record(overrides: Partial<JevCallRecord> = {}): JevCallRecord {
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
    ...overrides,
  }
}

/** Collect the records an outlet receives. */
function collector(): { target: SessionTelemetrySink; seen: SessionTelemetryRecord[] } {
  const seen: SessionTelemetryRecord[] = []
  return { target: { emit: (emitted) => { seen.push(emitted) } }, seen }
}

describe('severityFor', () => {
  it('reports a successful call as info', () => {
    expect(severityFor(record())).toBe('info')
  })

  it('reports a service-side failure as error', () => {
    expect(severityFor(record({ outcome: 'failure', serviceFailure: true, errorCode: 'JEV_TIMEOUT' }))).toBe('error')
  })

  it('reports a caller-side failure as warn', () => {
    // A 400 means the caller asked something unusable; calling that an error
    // would drown a real outage in an error-rate dashboard.
    expect(severityFor(record({ outcome: 'failure', serviceFailure: false, errorCode: 'JEV_HTTP' }))).toBe('warn')
  })
})

describe('toSessionRecord', () => {
  it('maps a call onto an ops record carrying the original as its body', () => {
    const input = record()
    const mapped = toSessionRecord(input, 1_700_000_000_000)

    expect(mapped.channel).toBe('ops')
    expect(mapped.time).toBe(1_700_000_000_000)
    expect(mapped.severity).toBe('info')
    expect(mapped.body).toEqual(input)
  })

  it('reports the primitive call facts as flat attributes', () => {
    const mapped = toSessionRecord(record({ retries: 2, cache: 'hit', latencyMs: 12, inputTokens: 3, outputTokens: 4 }), 1)

    expect(mapped.attributes['telemetry.op']).toBe('jev.call')
    expect(mapped.attributes['jev.outcome']).toBe('success')
    expect(mapped.attributes['jev.cache']).toBe('hit')
    expect(mapped.attributes['jev.retries']).toBe(2)
    expect(mapped.attributes['jev.latency_ms']).toBe(12)
    expect(mapped.attributes['jev.input_tokens']).toBe(3)
    expect(mapped.attributes['jev.output_tokens']).toBe(4)
    expect(mapped.attributes['jev.model']).toBe('jev-1.13.0')
  })

  it('omits model and error code rather than blanking them', () => {
    const mapped = toSessionRecord(record({ model: undefined, errorCode: undefined }), 1)

    expect('jev.model' in mapped.attributes).toBe(false)
    expect('jev.error_code' in mapped.attributes).toBe(false)
  })

  it('carries the error code when a call failed', () => {
    const mapped = toSessionRecord(record({ outcome: 'failure', serviceFailure: true, errorCode: 'JEV_NETWORK' }), 1)

    expect(mapped.attributes['jev.error_code']).toBe('JEV_NETWORK')
    expect(mapped.severity).toBe('error')
  })

  it('keeps every attribute value primitive, as the outlet requires', () => {
    const mapped = toSessionRecord(record({ outcome: 'failure', serviceFailure: true, errorCode: 'JEV_HTTP' }), 1)

    for (const value of Object.values(mapped.attributes)) {
      expect(['string', 'number']).toContain(typeof value)
    }
  })

  it('is pure: the same input maps to an equal record', () => {
    const input = record()

    expect(toSessionRecord(input, 42)).toEqual(toSessionRecord(input, 42))
  })
})

describe('sessionTelemetrySink', () => {
  it('forwards a sampled record with the injected clock', () => {
    const { target, seen } = collector()
    const sink = sessionTelemetrySink(target, () => 1_234)

    sink.record(record())

    expect(seen).toHaveLength(1)
    expect(seen[0]?.time).toBe(1_234)
    expect(seen[0]?.body).toEqual(record())
  })

  it('reads the clock once per record', () => {
    const { target } = collector()
    const now = vi.fn(() => 7)
    const sink = sessionTelemetrySink(target, now)

    sink.record(record())
    sink.record(record())

    expect(now).toHaveBeenCalledTimes(2)
  })

  it.each([
    ['an Error', new Error('outlet down')],
    ['a string', 'outlet down'],
    ['undefined', undefined],
  ])('swallows %s thrown by the outlet', (_label, thrown) => {
    const sink = sessionTelemetrySink({ emit: () => { throw thrown } }, () => 1)

    expect(() => { sink.record(record()) }).not.toThrow()
  })
})
