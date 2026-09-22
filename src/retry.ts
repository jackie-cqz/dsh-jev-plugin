/** Retry policy execution for transient Jev failures. @module dsh-jev/retry */

import type { ResolvedRetryConfig } from './config.ts'
import { JevHttpError, JevNetworkError } from './errors.ts'

/** Retry policy plus the seams tests use to observe backoff without waiting. */
export interface RetryOptions {
  /** Resolved retry policy; `maxAttempts` counts the first attempt. */
  policy: ResolvedRetryConfig
  /** Cancellation propagated from the tool call. */
  signal?: AbortSignal
  /** Backoff sink; defaults to {@link defaultSleep}. */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>
  /** Jitter source in `[0, 1)`; defaults to `Math.random`. */
  random?: () => number
  /**
   * Observes one imminent retry, before its backoff wait begins.
   * A throwing observer cannot change the retry outcome.
   * @param attempt - 1-based number of the attempt that just failed.
   * @param delayMs - backoff about to be waited out.
   * @param error - value thrown by that attempt.
   */
  onRetry?: (attempt: number, delayMs: number, error: unknown) => void
}

/**
 * Wait for `ms`, rejecting with the abort reason if `signal` fires first.
 * @param ms - delay in milliseconds; a non-positive value resolves immediately.
 * @param signal - cancellation that ends the wait early.
 * @returns a promise that settles when the delay ends or the signal aborts.
 */
export async function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted()
  if (ms <= 0) return
  await new Promise<void>((resolve, reject) => {
    const onAbort = (): void => {
      clearTimeout(timer)
      reject(signal?.reason)
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

/**
 * Decide whether a failed attempt may be repeated.
 * @param error - value thrown by the failed attempt.
 * @returns `true` for transient transport and HTTP failures, `false` for everything else,
 * including aborts, configuration errors, and malformed responses.
 */
export function isRetryable(error: unknown): boolean {
  if (error instanceof JevNetworkError) return true
  if (error instanceof JevHttpError) return error.retryable
  return false
}

/**
 * Compute the backoff before the attempt following a failed one.
 * A server-provided `Retry-After` wins over the exponential schedule, and either
 * value is capped by `maxDelayMs`.
 * @param attempt - 1-based number of the attempt that just failed.
 * @param error - value thrown by that attempt.
 * @param options - resolved policy and the injectable jitter source.
 * @returns delay in milliseconds, never negative and never above `maxDelayMs`.
 */
export function nextDelayMs(attempt: number, error: unknown, options: RetryOptions): number {
  const { policy } = options
  if (error instanceof JevHttpError && error.retryAfterMs !== undefined) {
    return Math.min(Math.max(0, error.retryAfterMs), policy.maxDelayMs)
  }
  const base = Math.min(policy.maxDelayMs, policy.baseDelayMs * 2 ** (attempt - 1))
  const random = options.random ?? Math.random
  return Math.round(base * random())
}

/**
 * Run an operation under the retry policy.
 * @param operation - one attempt, receiving its 1-based attempt number.
 * @param options - resolved policy, cancellation, and the test seams.
 * @returns the first successful result.
 * @throws the abort reason when the signal fires, and otherwise the error from the
 * final attempt after the policy is exhausted.
 */
export async function withRetry<T>(
  operation: (attempt: number) => Promise<T>,
  options: RetryOptions,
): Promise<T> {
  const { policy, signal } = options
  const sleep = options.sleep ?? defaultSleep
  let lastError: unknown
  for (let attempt = 1; attempt <= policy.maxAttempts; attempt += 1) {
    signal?.throwIfAborted()
    try {
      return await operation(attempt)
    } catch (error) {
      lastError = error
      if (attempt >= policy.maxAttempts || !isRetryable(error)) throw error
      const delayMs = nextDelayMs(attempt, error, options)
      try {
        options.onRetry?.(attempt, delayMs, error)
      } catch {
        // An auditing observer must not change whether the call succeeds: a
        // throwing counter would turn an otherwise successful retry into a
        // failure of the operation it was only observing.
      }
      await sleep(delayMs, signal)
    }
  }
  // `maxAttempts` is validated as at least 1, so the loop returns or throws above.
  throw lastError
}
