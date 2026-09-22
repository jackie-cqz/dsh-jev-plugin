/**
 * Pre-execute risk gate backed by the Jev decision service.
 *
 * The gate runs before a tool call and asks Jev to place that call on an ordered
 * risk scale. It is **off by default** and inspects every tool once enabled.
 *
 * Privacy: the gate sends the tool name and the model's arguments to the
 * TypeSafe API as the decision `state`, and that call is recorded in the DSH
 * session log. Enabling the gate accepts both.
 * @module dsh-jev/guard
 */

import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import { verdictFor } from './confidence.ts'
import type { ResolvedConfidenceConfig, ResolvedGuardConfig } from './config.ts'
import type { ScoreAnswer } from './protocol.ts'
import type { JevService } from './service.ts'

/**
 * What the gate decided about one pending call.
 *
 * `revise` exists because `ask` is not the only way to be unsure. A call the
 * gate judges risky but improvable should go back to the model with concrete
 * rewrite guidance: that costs nothing and has no side effect when nobody is
 * available to approve, whereas `ask` becomes a refusal when the host has no
 * approval service mounted. The host has no distinct revise state, so the
 * listener that consumes this maps it onto a denial carrying the guidance.
 */
export type GuardDecision =
  | { kind: 'allow' }
  | { kind: 'revise'; reason: string }
  | { kind: 'ask'; reason: string }
  | { kind: 'deny'; reason: string }

/** Gate counters since construction. */
export interface JevGuardStats {
  /** Calls the gate evaluated; calls kept out by `enabled` or `tools` are excluded. */
  inspected: number
  /** Calls allowed, including allowances that fell back from `onError`. */
  allowed: number
  /** Calls sent back for rewriting. */
  revised: number
  /** Calls that need approval. */
  asked: number
  /** Calls refused, including refusals that fell back from `onError`. */
  denied: number
  /** Times a Jev failure sent the call down the `onError` branch. */
  errors: number
}

/** One pending tool call as the gate sees it. */
export interface GuardCall {
  /** Tool name, sent to Jev as part of the decision state. */
  name: string
  /** Model-supplied arguments, sent to Jev as part of the decision state. */
  arguments: unknown
  /** Cancellation from the tool call; `undefined` means the caller did not cancel. */
  signal?: AbortSignal
}

/** Construction options for {@link JevGuard}. */
export interface JevGuardOptions {
  /** Decision service the gate asks. */
  service: JevService
  /** Resolved gate configuration; `enabled: false` makes every call allowed. */
  config: ResolvedGuardConfig
  /** Confidence bands, used only by the low-confidence escalation. */
  bands: ResolvedConfidenceConfig
}

/**
 * Decide whether one pending tool call may run, should be rewritten, needs
 * approval, or is refused.
 *
 * Bands are read from the top down: `denyAt` wins over `reviseAt`, which wins
 * over `askAt`. Because `reviseAt` defaults to `denyAt`, the revise band is
 * empty until a deployment widens it.
 *
 * A gate that throws would break the agent loop, so every failure — including a
 * malformed answer or a confidence outside the unit interval — is converted into
 * the configured `onError` outcome.
 * Reasons name the tool, the level label, the score, the confidence, and the
 * failing error's machine-readable code, but never the arguments or a server
 * response body: a reason is model-visible and durable, so it stays free of
 * content that could carry credentials.
 */
export class JevGuard {
  private readonly service: JevService
  private readonly config: ResolvedGuardConfig
  private readonly bands: ResolvedConfidenceConfig
  private readonly counters = { inspected: 0, allowed: 0, revised: 0, asked: 0, denied: 0, errors: 0 }

  /** @param options - decision service, resolved gate configuration, and confidence bands. */
  constructor(options: JevGuardOptions) {
    this.service = options.service
    this.config = options.config
    this.bands = options.bands
  }

  /**
   * Evaluate one pending call.
   * @param call - tool name, model arguments, and cancellation.
   * @returns the decision; `allow` when the gate is off, out of scope, or clears the call.
   */
  async decide(call: GuardCall): Promise<GuardDecision> {
    if (!this.config.enabled) return { kind: 'allow' }
    if (this.config.tools.length > 0 && !this.config.tools.includes(call.name)) {
      return { kind: 'allow' }
    }

    this.counters.inspected += 1
    try {
      // Tool arguments are JSON by the time a call reaches the gate.
      const state = { tool: call.name, arguments: call.arguments as JsonValue }
      const answer = await this.service.score(state, this.config.question, this.config.levels, call.signal)
      return this.classify(answer)
    } catch (error) {
      return this.fellBack(error)
    }
  }

  /**
   * Read the gate counters.
   * @returns a snapshot; later decisions do not mutate it.
   */
  stats(): Readonly<JevGuardStats> {
    return { ...this.counters }
  }

  /**
   * Map one answer onto a decision and count it.
   *
   * The verdict for a low confidence comes from {@link verdictFor}, so the
   * threshold semantics live in one place. That call rejects a confidence
   * outside the unit interval, and the throw leaves this method with no counter
   * incremented, so the `onError` fallback stays the only thing that counts the
   * outcome.
   * @param answer - the validated score answer.
   * @returns the decision for this answer.
   * @throws JevValidationError when the answer carries an unusable confidence.
   */
  private classify(answer: ScoreAnswer): GuardDecision {
    if (answer.score >= this.config.denyAt) {
      this.counters.denied += 1
      return {
        kind: 'deny',
        reason: `Blocked by the Jev risk gate: this call scored ${this.describeScore(answer.score)}`
          + ' on the configured risk scale. Split it into smaller, reversible steps,'
          + ' or ask the user to approve it explicitly.',
      }
    }
    if (answer.score >= this.config.reviseAt) {
      this.counters.revised += 1
      return {
        kind: 'revise',
        reason: `The Jev risk gate scored this call ${this.describeScore(answer.score)}:`
          + ' it looks risky, but there is probably a safer formulation.'
          + ' Rewrite it before running it — narrow it to the specific path, table, or record'
          + ' you actually need, try a dry run first, or back up what it would change.',
      }
    }
    if (answer.score >= this.config.askAt) {
      this.counters.asked += 1
      return {
        kind: 'ask',
        reason: `The Jev risk gate scored this call ${this.describeScore(answer.score)}.`
          + ' Confirm before running it.',
      }
    }
    if (this.config.escalateOnLowConfidence && this.escalates(answer.confidence)) {
      this.counters.asked += 1
      return {
        kind: 'ask',
        reason: 'The Jev risk gate could not judge this call confidently'
          + ` (confidence ${answer.confidence.toFixed(2)} below the`
          + ` ${this.bands.escalateBelow.toFixed(2)} threshold). Confirm before running it.`,
      }
    }
    this.counters.allowed += 1
    return { kind: 'allow' }
  }

  /**
   * Whether an answer is too uncertain to act on.
   * @param confidence - confidence reported by the answer.
   * @returns `true` when the configured bands call for escalation.
   */
  private escalates(confidence: number): boolean {
    return verdictFor(confidence, this.bands) === 'escalate'
  }

  /**
   * Apply the configured outcome for a failed risk check.
   * @param error - value thrown by the service or by classification.
   * @returns the `onError` outcome, counted as an allowance or a refusal.
   */
  private fellBack(error: unknown): GuardDecision {
    this.counters.errors += 1
    if (this.config.onError !== 'deny') {
      this.counters.allowed += 1
      return { kind: 'allow' }
    }
    this.counters.denied += 1
    return {
      kind: 'deny',
      reason: `Blocked by the Jev risk gate: the risk check failed (${failureLabel(error)}).`
        + ' Retry, or ask the user to approve this call.',
    }
  }

  /**
   * Render a score against the configured scale, labelled when it lands on a level.
   * @param score - raw score from the answer, which may fall outside the scale.
   * @returns the score over the top index, with the level label when one applies.
   */
  private describeScore(score: number): string {
    const max = this.config.levels.length - 1
    const label = this.config.levels[Math.round(score)]
    return label === undefined
      ? `${String(score)}/${String(max)}`
      : `${String(score)}/${String(max)} (${label})`
  }
}

/**
 * Name a failed check without quoting its message.
 *
 * A `JevHttpError` message carries a truncated server response body, and a gate
 * reason is model-visible and durable, so the message is replaced by the
 * plugin's stable error code — plus the HTTP status, which is a number and so
 * carries no server-authored text.
 * @param error - value thrown by the service or by classification.
 * @returns the stable code, else the error's name, else the received type.
 */
function failureLabel(error: unknown): string {
  if (typeof error !== 'object' || error === null) return typeof error
  const record = error as { code?: unknown; name?: unknown; status?: unknown }
  const code = typeof record.code === 'string' && record.code !== ''
    ? record.code
    : typeof record.name === 'string' && record.name !== '' ? record.name : 'unknown error'
  return typeof record.status === 'number' ? `${code} ${String(record.status)}` : code
}
