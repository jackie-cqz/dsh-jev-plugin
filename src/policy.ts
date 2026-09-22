/** Call-admission policy: consecutive-failure circuit breaker and call spacing. @module dsh-jev/policy */

import type { ResolvedPolicyConfig } from './config.ts'
import { JevCircuitOpenError, JevQuotaError } from './errors.ts'

/** Observable counters and current breaker state. */
export interface JevPolicyStats {
  /** Calls refused by the breaker, each one a request that was never sent. */
  rejectedByCircuit: number
  /** Calls refused because a quota cooldown was in effect; also requests never sent. */
  rejectedByQuota: number
  /** Whether the quota cooldown still suppresses requests at snapshot time. */
  quotaCooling: boolean
  /** Calls that waited for the minimum-interval gap. */
  spacedCalls: number
  /** Transitions from `closed` to `open`. */
  circuitOpens: number
  /** Current breaker state. */
  circuit: 'closed' | 'open' | 'half-open'
}

/** Clock and wait seams, both injected so tests never touch a real timer. */
export interface JevPolicyOptions {
  /** Resolved policy; `enabled: false` turns every method into a no-op. */
  config: ResolvedPolicyConfig
  /** Clock in milliseconds; defaults to `Date.now`. */
  now?: () => number
  /** Wait implementation; defaults to a real timer. */
  sleep?: (ms: number) => Promise<void>
}

/** Resolve after `ms` of real time. */
function timerSleep(ms: number): Promise<void> {
  return new Promise<void>(resolve => {
    setTimeout(resolve, ms)
  })
}

/**
 * Decide whether a call may proceed, by refusing calls while the breaker is open
 * and by spacing calls no closer than `minIntervalMs`.
 *
 * Time is read only from `options.now()` and waiting only through
 * `options.sleep()`, so a caller supplying a clock must also supply a wait that
 * advances it; otherwise spacing can never observe the gap it just waited out.
 */
export class JevPolicy {
  readonly #config: ResolvedPolicyConfig
  readonly #now: () => number
  readonly #sleep: (ms: number) => Promise<void>

  /** Consecutive failures since the last success. */
  #failures = 0
  /** Breaker state; a half-open circuit admits exactly one probe call. */
  #circuit: 'closed' | 'open' | 'half-open' = 'closed'
  /** Time the circuit last opened, in `now()` milliseconds. */
  #openedAt = 0
  /** Time of the last admitted call, or `undefined` before the first one. */
  #lastAdmitAt: number | undefined = undefined
  /** Time the quota cooldown ends, in `now()` milliseconds; 0 before any quota failure. */
  #quotaUntil = 0
  #rejectedByQuota = 0
  #rejectedByCircuit = 0
  #spacedCalls = 0
  #circuitOpens = 0

  constructor(options: JevPolicyOptions) {
    this.#config = options.config
    this.#now = options.now ?? Date.now
    this.#sleep = options.sleep ?? timerSleep
  }

  /**
   * Admit one call, waiting out the minimum-interval gap when one applies.
   * The breaker check runs before any wait, so a refused call neither waits nor
   * moves the spacing clock.
   * @returns a promise that settles once the call may proceed.
   * @throws JevCircuitOpenError while the circuit is open, or while its single
   * half-open probe is already in flight.
   */
  async admit(): Promise<void> {
    if (!this.#config.enabled) return
    // Quota exhaustion is checked first: while the cooldown holds there is no
    // point consulting the breaker or waiting out a spacing gap.
    this.#checkQuota()
    this.#checkCircuit()
    await this.#space()
    this.#lastAdmitAt = this.#now()
  }

  /**
   * Record how one admitted call ended.
   * `success` means the service answered at all: a caller-side rejection such as
   * `400` or `401` still shows the service is reachable, so the caller decides
   * which outcome to report.
   * @param outcome - `'success'` resets the failure streak, `'failure'` extends it.
   */
  record(outcome: 'success' | 'failure' | 'quota'): void {
    if (!this.#config.enabled) return
    if (outcome === 'success') {
      this.#failures = 0
      if (this.#circuit === 'half-open') this.#circuit = 'closed'
      return
    }
    // A quota failure extends the failure streak exactly like a transient one,
    // and additionally stops calls until the cooldown elapses.
    if (outcome === 'quota') this.#quotaUntil = this.#now() + this.#config.quotaCooldownMs
    if (this.#circuit === 'half-open') {
      this.#open()
      return
    }
    this.#failures += 1
    if (this.#circuit === 'closed' && this.#failures >= this.#config.failureThreshold) this.#open()
  }

  /**
   * Read the current counters and breaker state.
   * @returns a snapshot; the returned object is not live.
   */
  stats(): Readonly<JevPolicyStats> {
    return {
      rejectedByCircuit: this.#rejectedByCircuit,
      rejectedByQuota: this.#rejectedByQuota,
      quotaCooling: this.#now() < this.#quotaUntil,
      spacedCalls: this.#spacedCalls,
      circuitOpens: this.#circuitOpens,
      circuit: this.#circuit,
    }
  }

  /**
   * Refuse every call until the quota cooldown elapses.
   *
   * The wait is deliberately absent: a quota does not recover by waiting out a
   * backoff, so the caller fails fast and lets the offline rule layer carry the
   * protection instead of holding the agent loop for a retry that cannot work.
   *
   * The cooldown exists only while the policy is enabled: with `enabled: false`
   * every method here is inert, so a quota failure is recorded but does not
   * suppress the next call.
   */
  #checkQuota(): void {
    const now = this.#now()
    if (now >= this.#quotaUntil) return
    this.#rejectedByQuota += 1
    throw new JevQuotaError(
      `Jev quota is exhausted; ${String(this.#quotaUntil - now)} ms remain before requests resume.`,
    )
  }

  /**
   * Refuse the call, promote an expired open window to a single probe, or let it
   * through. Runs synchronously so concurrent callers cannot both observe an
   * expired window and start two probes.
   */
  #checkCircuit(): void {
    if (this.#circuit === 'half-open') {
      this.#rejectedByCircuit += 1
      throw new JevCircuitOpenError(
        'Jev circuit is half-open; one probe call is already in flight.',
      )
    }
    if (this.#circuit !== 'open') return
    const remaining = this.#config.openMs - (this.#now() - this.#openedAt)
    if (remaining <= 0) {
      this.#circuit = 'half-open'
      return
    }
    this.#rejectedByCircuit += 1
    throw new JevCircuitOpenError(
      `Jev circuit is open after ${this.#failures} consecutive failures; ${remaining} ms remain before the next probe call.`,
    )
  }

  /** Wait out whatever remains of the minimum-interval gap. */
  async #space(): Promise<void> {
    const { minIntervalMs } = this.#config
    if (minIntervalMs <= 0) return
    const last = this.#lastAdmitAt
    if (last === undefined) return
    const remaining = minIntervalMs - (this.#now() - last)
    if (remaining <= 0) return
    await this.#sleep(remaining)
    this.#spacedCalls += 1
  }

  /** Trip the breaker and restart its open window. */
  #open(): void {
    this.#circuit = 'open'
    this.#openedAt = this.#now()
    this.#circuitOpens += 1
  }
}
