/**
 * Redacted structured call records, sampled before they leave the process.
 *
 * The point of this module is what a record *cannot* carry. {@link JevCallRecord}
 * has no field for `state`, tool arguments, tool results, or the API key, and
 * {@link JevTelemetry.record} rebuilds the outgoing object from an explicit field
 * whitelist, so an incoming object with extra properties cannot smuggle them
 * through. `errorCode` carries a machine-readable code only, never an error
 * message: a `JevHttpError` message embeds a server response body.
 *
 * Logging is off by default, and a telemetry failure is swallowed rather than
 * propagated — an observation path must never be able to fail a Jev call.
 * @module dsh-jev/telemetry
 */

import type { ResolvedTelemetryConfig } from './config.ts'

/** One redacted record of a completed call. */
export interface JevCallRecord {
  /** Whether the call succeeded. */
  outcome: 'success' | 'failure'
  /** Model id reported by the response; `undefined` for a failed call. */
  model: string | undefined
  /** End-to-end duration of the call in milliseconds. */
  latencyMs: number
  /** Prompt tokens reported by the response; 0 when the call failed. */
  inputTokens: number
  /** Completion tokens reported by the response; 0 when the call failed. */
  outputTokens: number
  /** Transport attempts beyond the first, as observed by the retry wrapper. */
  retries: number
  /** Whether the answer came from the response cache instead of the transport. */
  cache: 'hit' | 'miss'
  /** Machine-readable code for a service-side failure, never a message. */
  errorCode: string | undefined
  /**
   * Whether the failure was the service's (transport, timeout, protocol,
   * envelope, retryable status) rather than the caller's. Telemetry outlets pick
   * their severity from this: reporting a `400` or `401` as an error would
   * pollute an error-rate dashboard with caller mistakes.
   */
  serviceFailure: boolean
}

/** Where accepted records go. */
export interface TelemetrySink {
  /**
   * Accept one record.
   * @param record - the redacted record.
   */
  record(record: JevCallRecord): void
}

/** What the telemetry path has seen since construction. */
export interface JevTelemetryStats {
  /** Records considered, after the `log` gate; includes sampled-out ones. */
  offered: number
  /** Calls made to `sink.record`, including calls where the sink then threw. */
  emitted: number
  /** Records dropped by sampling. */
  sampled: number
  /** Sink calls that threw; a subset of {@link JevTelemetryStats.emitted}. */
  sinkErrors: number
}

/** Construction options. */
export interface JevTelemetryOptions {
  /** Resolved telemetry configuration; `log: false` turns the module inert. */
  config: ResolvedTelemetryConfig
  /** Record sink; absent means records are counted but not written anywhere. */
  sink?: TelemetrySink
  /** Random source in `[0, 1)`; defaults to `Math.random`. */
  random?: () => number
}

/**
 * Rebuild one record from the interface's own fields.
 *
 * Reconstruction, rather than forwarding the caller's object, is what makes the
 * redaction guarantee structural: a record carrying an undeclared property is
 * reduced to the fields below instead of being passed along.
 * @param record - candidate record, possibly carrying extra properties.
 * @returns a record holding exactly the declared fields.
 */
function whitelist(record: JevCallRecord): JevCallRecord {
  return {
    outcome: record.outcome,
    model: record.model,
    latencyMs: record.latencyMs,
    inputTokens: record.inputTokens,
    outputTokens: record.outputTokens,
    retries: record.retries,
    cache: record.cache,
    errorCode: record.errorCode,
    serviceFailure: record.serviceFailure,
  }
}

/**
 * Sample, redact, and forward one call record.
 *
 * With a sink, every considered record ends up either sampled out or emitted, so
 * `offered === sampled + emitted`. Without a sink, a record that passes sampling
 * is counted in `offered` and nowhere else.
 */
export class JevTelemetry {
  private readonly config: ResolvedTelemetryConfig
  private readonly sink: TelemetrySink | undefined
  private readonly random: () => number
  private readonly counters = { offered: 0, emitted: 0, sampled: 0, sinkErrors: 0 }

  /** @param options - resolved configuration plus the sink and random seams. */
  constructor(options: JevTelemetryOptions) {
    this.config = options.config
    this.sink = options.sink
    this.random = options.random ?? Math.random
  }

  /**
   * Offer one record.
   * @param record - the call record to consider; extra properties are dropped.
   */
  record(record: JevCallRecord): void {
    if (!this.config.log) return
    this.counters.offered += 1

    // `Math.random()` cannot return 1, so a full-rate deployment would still be
    // sampled by an invisible hair; short-circuit it instead.
    const accepted = this.config.sampleRate >= 1 || this.random() < this.config.sampleRate
    if (!accepted) {
      this.counters.sampled += 1
      return
    }

    const sink = this.sink
    if (sink === undefined) return

    this.counters.emitted += 1
    try {
      sink.record(whitelist(record))
    } catch {
      // The sink is an observation path: its failure must not surface as a Jev
      // call failure, so the error is counted and discarded.
      this.counters.sinkErrors += 1
    }
  }

  /**
   * Read the counters.
   * @returns a snapshot; later activity does not mutate it.
   */
  stats(): Readonly<JevTelemetryStats> {
    return { ...this.counters }
  }
}
