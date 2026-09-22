/** Service health derived from call counters. @module dsh-jev/health */

/** Current health of the Jev service. */
export type JevHealthStatus = 'healthy' | 'degraded' | 'unknown'

/** One assessment. */
export interface JevHealth {
  /** `unknown` means the sample is too small to judge, not that anything is wrong. */
  status: JevHealthStatus
  /** Human-readable causes, in a stable order; empty when nothing is wrong. */
  reasons: readonly string[]
}

/** The counters an assessment reads. */
export interface JevHealthInput {
  /** Calls that reached the transport. */
  calls: number
  /** Service-side failures among those calls. */
  failures: number
  /** Breaker state from the admission policy. */
  circuit: 'closed' | 'open' | 'half-open'
}

/** Deployment thresholds for an assessment. */
export interface JevHealthThresholds {
  /** Error rate at or above which the service is degraded. */
  errorRateAlert: number
  /** Calls required before the error-rate alert may fire. */
  alertMinCalls: number
}

/**
 * Assess service health from counters and the breaker state.
 *
 * Below `alertMinCalls` the result is `unknown` rather than healthy: one failure
 * out of two calls is a 0.5 error rate and no evidence at all, and an alert that
 * fires on that sample is noise the operator will learn to ignore.
 *
 * Reasons carry numbers, status names, and the configured threshold only. They
 * never quote a `state`, arguments, or an error message, because a reason is
 * read by operators and may be persisted by whatever consumes this result.
 *
 * The function is pure: it reads no clock and no environment, has no side
 * effects, and never throws — `thresholds` was range-checked when configuration
 * was resolved.
 * @param input - call counters and current breaker state.
 * @param thresholds - resolved alert thresholds.
 * @returns the status plus every reason that produced it.
 */
export function assessHealth(input: JevHealthInput, thresholds: JevHealthThresholds): JevHealth {
  if (input.calls < thresholds.alertMinCalls) return { status: 'unknown', reasons: [] }

  const errorRate = input.failures / input.calls
  const reasons: string[] = []

  if (errorRate >= thresholds.errorRateAlert) {
    reasons.push(
      `error rate ${errorRate.toFixed(2)} is at or above the ${thresholds.errorRateAlert.toFixed(2)} threshold`
      + ` (${String(input.failures)} of ${String(input.calls)} calls failed)`,
    )
  }
  if (input.circuit !== 'closed') {
    reasons.push(`circuit breaker is ${input.circuit}`)
  }

  return { status: reasons.length > 0 ? 'degraded' : 'healthy', reasons }
}
