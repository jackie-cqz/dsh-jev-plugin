/**
 * Adapter from this package's redacted call records to DSH's session telemetry.
 *
 * The record and sink types below are structural counterparts of DSH's
 * `SessionTelemetryRecord` and `SessionTelemetrySink`. They are declared here
 * rather than imported so this package keeps no dependency on DSH internals: an
 * outlet that satisfies `ctx.sessionTelemetry` fits, and so does a test double.
 *
 * Records go out on the `ops` channel: a Jev call is an operational signal with
 * no session-log home, and the `ledger` channel is reserved for events that
 * mirror the session log. Attributes stay flat and primitive because DSH limits
 * them to `string | number`; anything else belongs in the body.
 * @module dsh-jev/dsh-telemetry
 */

import type { JevCallRecord, TelemetrySink } from './telemetry.ts'

/** Structural counterpart of a DSH session telemetry record. */
export interface SessionTelemetryRecord {
  /** Ledger records mirror session events; ops records carry operational signals. */
  channel: 'ledger' | 'ops'
  /** Unix epoch milliseconds, supplied by the caller so mapping stays pure. */
  time: number
  /** Alerting severity the outlet maps onto its own signal. */
  severity: 'info' | 'warn' | 'error'
  /** Flat identity attributes; DSH permits only `string | number` values. */
  attributes: Record<string, string | number>
  /** Complete payload; the redacted call record. */
  body: unknown
}

/** The minimum outlet this adapter needs; `ctx.sessionTelemetry` satisfies it. */
export interface SessionTelemetrySink {
  /**
   * Enqueue one record. Implementations must not block and must not throw.
   * @param record - the record to report.
   */
  emit(record: SessionTelemetryRecord): void
}

/**
 * Pick the severity one call deserves.
 *
 * A caller-side failure stays a warning: a `400` or `401` says the caller asked
 * something unusable, not that the service is unhealthy, and reporting those as
 * errors would drown a real outage in a dashboard.
 * @param record - the completed call.
 * @returns `info` on success, `error` for a service-side failure, `warn` otherwise.
 */
export function severityFor(record: JevCallRecord): 'info' | 'warn' | 'error' {
  if (record.outcome === 'success') return 'info'
  return record.serviceFailure ? 'error' : 'warn'
}

/**
 * Map one call record onto an `ops` telemetry record.
 * @param record - the redacted call record.
 * @param time - Unix epoch milliseconds for the record.
 * @returns the telemetry record, carrying `record` unchanged as its body.
 */
export function toSessionRecord(record: JevCallRecord, time: number): SessionTelemetryRecord {
  const attributes: Record<string, string | number> = {
    'telemetry.op': 'jev.call',
    'jev.outcome': record.outcome,
    'jev.cache': record.cache,
    'jev.retries': record.retries,
    'jev.latency_ms': record.latencyMs,
    'jev.input_tokens': record.inputTokens,
    'jev.output_tokens': record.outputTokens,
  }
  // An absent value is omitted rather than blanked: an attribute present with an
  // empty string would read as a reported model id of "".
  if (record.model !== undefined) attributes['jev.model'] = record.model
  if (record.errorCode !== undefined) attributes['jev.error_code'] = record.errorCode
  return { channel: 'ops', time, severity: severityFor(record), attributes, body: record }
}

/**
 * Adapt a session telemetry outlet into this package's record sink.
 * @param target - outlet receiving mapped records, such as `ctx.sessionTelemetry`.
 * @param now - clock read once per record; injected so tests pin the timestamp.
 * @returns a sink that maps and forwards every record it accepts.
 */
export function sessionTelemetrySink(target: SessionTelemetrySink, now: () => number): TelemetrySink {
  return {
    record(record: JevCallRecord): void {
      try {
        target.emit(toSessionRecord(record, now()))
      } catch {
        // `JevTelemetry` counts a throwing sink and discards the error; catching
        // here too keeps a hostile outlet from reaching the Jev call path.
      }
    },
  }
}
