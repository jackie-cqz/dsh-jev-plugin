/** Post-execute result review: Jev judges whether a finished tool result needs correction. @module dsh-jev/review */

import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import type { ResolvedReviewConfig } from './config.ts'
import type { JevService } from './service.ts'

/** What the review decided about one finished call. */
export type ReviewDecision = { kind: 'accept' } | { kind: 'block'; feedback: string }

/** Counters for the review hook. */
export interface JevReviewStats {
  /** Calls that reached Jev (excludes disabled and out-of-scope calls). */
  reviewed: number
  /** Results passed through, including passes that fell back from `onError`. */
  accepted: number
  /** Results blocked, including blocks that fell back from `onError`. */
  blocked: number
  /** Times a Jev failure sent the call down the `onError` branch. */
  errors: number
}

/** What the review reads from one finished call. */
export interface ReviewCall {
  /** Tool name. */
  name: string
  /** Arguments the model supplied. */
  arguments: unknown
  /** Value the tool produced. */
  result: unknown
  /** Cancellation forwarded to the service; absent means no cancellation. */
  signal?: AbortSignal
}

/** Review construction options. */
export interface JevReviewOptions {
  /** Decision service the review asks. */
  service: JevService
  /** Resolved review policy; `enabled: false` accepts everything without asking. */
  config: ResolvedReviewConfig
}

/**
 * Decide whether a finished tool result may stand or must be corrected.
 *
 * A hook that throws would break the agent loop, so every failure — including a
 * malformed answer — is converted into the configured `onError` outcome.
 * Feedback names the tool, the probability, and the failing error's
 * machine-readable code, but never the arguments or the result: a tool result
 * can carry file contents or credentials, and feedback is model-visible and
 * durable.
 *
 * Privacy: the review sends the tool name, its arguments, **and its result** to
 * the TypeSafe API as `state`, and that state reaches the DSH session log. A
 * result can hold file contents, so this hook is more exposed than the risk
 * gate; it is disabled by default.
 */
export class JevReview {
  private readonly service: JevService
  private readonly config: ResolvedReviewConfig
  /**
   * Counters live in one mutable object so every context view reaches the same
   * state by construction.
   */
  private readonly counters = { reviewed: 0, accepted: 0, blocked: 0, errors: 0 }

  /** @param options - decision service and resolved review policy. */
  constructor(options: JevReviewOptions) {
    this.service = options.service
    this.config = options.config
  }

  /**
   * Judge one finished call.
   * @param call - tool name, arguments, result, and optional cancellation.
   * @returns `accept` to keep the result, or `block` with corrective feedback.
   */
  async decide(call: ReviewCall): Promise<ReviewDecision> {
    if (!this.config.enabled) return { kind: 'accept' }
    if (this.config.tools.length > 0 && !this.config.tools.includes(call.name)) {
      return { kind: 'accept' }
    }

    this.counters.reviewed += 1
    try {
      // Arguments and result are JSON by the time a call reaches the review.
      const state = {
        tool: call.name,
        arguments: call.arguments as JsonValue,
        result: call.result as JsonValue,
      }
      const answer = await this.service.noul(state, this.config.question, undefined, call.signal)
      if (answer.noul >= this.config.blockAt) {
        this.counters.blocked += 1
        return {
          kind: 'block',
          feedback: `The Jev review judged this result as needing correction (probability ${answer.noul.toFixed(2)}).`
            + ' Read the error, adjust the call, and try again rather than continuing as if it succeeded.',
        }
      }
      this.counters.accepted += 1
      return { kind: 'accept' }
    } catch (error) {
      return this.fellBack(error)
    }
  }

  /**
   * Read the hook counters.
   * @returns a snapshot; later decisions do not mutate it.
   */
  stats(): Readonly<JevReviewStats> {
    return { ...this.counters }
  }

  /**
   * Apply the configured outcome for a failed review.
   * @param error - value thrown by the service.
   * @returns the `onError` outcome, counted as an acceptance or a block.
   */
  private fellBack(error: unknown): ReviewDecision {
    this.counters.errors += 1
    if (this.config.onError !== 'block') {
      this.counters.accepted += 1
      return { kind: 'accept' }
    }
    this.counters.blocked += 1
    return {
      kind: 'block',
      feedback: `The Jev review could not judge this result (${failureLabel(error)}).`
        + ' Re-run the call, or proceed only after checking the output yourself.',
    }
  }
}

/**
 * Name a failed check without quoting its message.
 *
 * A `JevHttpError` message carries a truncated server response body, and review
 * feedback is model-visible and durable, so the message is replaced by the
 * plugin's stable error code — plus the HTTP status, which is a number and so
 * carries no server-authored text.
 *
 * This mirrors the helper in `guard.ts`; the two hooks are separate files by
 * design, and the shared extraction is a follow-up rather than a reason to
 * couple them.
 * @param error - value thrown by the service.
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
