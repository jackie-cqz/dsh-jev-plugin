/**
 * Intent routing: classify the latest user turn and admit one directive.
 *
 * The directive this router returns is injected into the model's context and
 * written to the durable session log, so it is only ever the deployment-authored
 * text stored in `config.directives`. Neither the user's turn nor anything the
 * model returns is interpolated into it: a classification result chooses *which*
 * configured line applies, never what that line says.
 *
 * Disabled by default, and `directives` defaults to empty, so intent routing is
 * inert until a deployment writes both the switch and the wording.
 *
 * @module dsh-jev/intent
 */

import type { ResolvedIntentConfig } from './config.ts'
import type { JevCriteria } from './protocol.ts'
import type { JevService } from './service.ts'

/** What the router decided for the current step. */
export type IntentDecision =
  | { kind: 'skip' }
  | { kind: 'direct'; intent: string; directive: string }

/** Router counters. */
export interface JevIntentStats {
  /** Turns that reached classification. */
  classified: number
  /** Turns that received a directive. */
  directed: number
  /** Turns skipped because the class carries no directive, or the input was blank. */
  skipped: number
  /** Classifications that failed and left the turn unmodified. */
  errors: number
}

/** One user turn awaiting classification. */
export interface IntentTurn {
  /** Text of this turn, as the user wrote it. */
  text: string
  /** Cancellation forwarded to the classification call. */
  signal?: AbortSignal
}

/** Router construction options. */
export interface JevIntentOptions {
  /** Decision service used for classification. */
  service: JevService
  /** Resolved intent configuration. */
  config: ResolvedIntentConfig
}

/**
 * Classify one user turn and choose whether to admit a configured directive.
 *
 * A classification failure leaves the turn exactly as it was: routing shapes how
 * the agent approaches a request, so it must never be the reason a turn fails.
 */
export class JevIntentRouter {
  private readonly service: JevService
  private readonly config: ResolvedIntentConfig
  private readonly counters: JevIntentStats = { classified: 0, directed: 0, skipped: 0, errors: 0 }

  /** @param options - decision service and resolved intent configuration. */
  constructor(options: JevIntentOptions) {
    this.service = options.service
    this.config = options.config
  }

  /**
   * Decide what this turn should be told, if anything.
   * @param turn - the latest user turn and its cancellation.
   * @returns the directive to admit, or `skip` to leave the turn unmodified.
   * This method never throws.
   */
  async decide(turn: IntentTurn): Promise<IntentDecision> {
    if (!this.config.enabled) return { kind: 'skip' }
    // Whitespace alone carries nothing to classify, so it never reaches the service.
    if (turn.text.trim() === '') return { kind: 'skip' }

    this.counters.classified += 1
    try {
      const criteria: JevCriteria = {}
      for (const name of this.config.classes) criteria[name] = null
      const answer = await this.service.choice(
        { turn: turn.text },
        this.config.question,
        criteria,
        turn.signal,
      )
      // `resolveConfig` guarantees every stored directive is a non-empty string,
      // so an absent entry is the only way a class admits nothing.
      const directive = this.config.directives[answer.choice]
      if (directive === undefined) {
        this.counters.skipped += 1
        return { kind: 'skip' }
      }
      this.counters.directed += 1
      return { kind: 'direct', intent: answer.choice, directive }
    } catch {
      // Counted once, as an error: the turn is not additionally counted as skipped.
      this.counters.errors += 1
      return { kind: 'skip' }
    }
  }

  /**
   * Read the router counters.
   * @returns a snapshot; later decisions do not mutate it.
   */
  stats(): Readonly<JevIntentStats> {
    return { ...this.counters }
  }
}
