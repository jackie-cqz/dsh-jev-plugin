/** Model routing: score a pending request's demand and pick that band's model. @module dsh-jev/routing */

import type { ResolvedRoutingConfig } from './config.ts'
import { JevValidationError } from './errors.ts'
import type { JevState } from './protocol.ts'
import type { JevService } from './service.ts'

/** How one pending model request should be dispatched. */
export type RoutingDecision = { kind: 'keep' } | { kind: 'route'; model: string }

/** Observable counters for the router. */
export interface JevRoutingStats {
  /** Requests that reached the scorer; a disabled router scores nothing. */
  scored: number
  /** Decisions that left the requested model alone, including `onError` keeps. */
  kept: number
  /** Decisions that named a different model. */
  routed: number
  /** Times a failed or unusable score sent the request down the `onError` branch. */
  errors: number
}

/** One request the router must place. */
export interface RoutingRequest {
  /** Model id the request would use without routing. */
  model: string
  /**
   * State the demand score is derived from. The caller prepares it and keeps it
   * within the plugin's `maxStateChars`, because the router does not re-measure it.
   */
  state: JevState
  /** Cancellation forwarded to the scorer. */
  signal?: AbortSignal
}

/** Construction options for {@link JevRouter}. */
export interface JevRoutingOptions {
  /** Decision service the demand score comes from. */
  service: JevService
  /** Resolved routing configuration. */
  config: ResolvedRoutingConfig
}

/**
 * Place a pending model request on the demand band Jev scores for it.
 *
 * The router never throws: a request that cannot be scored is dispatched by the
 * configured `onError` policy. `keep` leaves the request exactly as the caller
 * built it; `capable` sends it to the top band's model instead, because routing
 * that cannot judge a request should err toward spending more rather than toward
 * running demanding work on a weak model.
 */
export class JevRouter {
  private readonly service: JevService
  private readonly config: ResolvedRoutingConfig
  /** Mutable state shared by every context view, matching the service's own counters. */
  private readonly counters = { scored: 0, kept: 0, routed: 0, errors: 0 }

  /** @param options - decision service and resolved routing configuration. */
  constructor(options: JevRoutingOptions) {
    this.service = options.service
    this.config = options.config
  }

  /**
   * Decide which model one request should use.
   * @param request - the requested model, the state to score, and cancellation.
   * @returns `keep` to dispatch as requested, or `route` to dispatch elsewhere.
   */
  async decide(request: RoutingRequest): Promise<RoutingDecision> {
    if (!this.config.enabled) return { kind: 'keep' }
    this.counters.scored += 1
    try {
      const answer = await this.service.score(
        request.state,
        this.config.question,
        this.config.levels,
        request.signal,
      )
      if (!Number.isFinite(answer.score)) {
        throw new JevValidationError(
          `Jev routing score must be a finite number, received ${String(answer.score)}.`,
        )
      }
      return this.classify(answer.score, request.model)
    } catch {
      return this.fellBack()
    }
  }

  /**
   * Read the router counters.
   * @returns a snapshot; later decisions do not mutate it.
   */
  stats(): Readonly<JevRoutingStats> {
    return { ...this.counters }
  }

  /**
   * Map a usable score onto the configured band and its model.
   * @param score - finite demand score, possibly outside the configured range.
   * @param currentModel - model the request already asked for.
   * @returns the routing decision, counted as kept or routed.
   */
  private classify(score: number, currentModel: string): RoutingDecision {
    const model = this.config.models[this.bandIndex(score)] ?? ''
    if (model === '' || model === currentModel) {
      this.counters.kept += 1
      return { kind: 'keep' }
    }
    this.counters.routed += 1
    return { kind: 'route', model }
  }

  /**
   * Resolve a score to a band index, clamping to the configured range because the
   * service guarantees only a finite number, not an in-range one.
   * @param score - finite demand score.
   * @returns an index inside `[0, levels.length - 1]`.
   */
  private bandIndex(score: number): number {
    const last = this.config.levels.length - 1
    return Math.min(last, Math.max(0, Math.round(score)))
  }

  /**
   * Apply the configured outcome for a failed demand check.
   * @returns the `onError` decision, counted as kept or routed.
   */
  private fellBack(): RoutingDecision {
    this.counters.errors += 1
    const top = this.config.models[this.config.levels.length - 1] ?? ''
    if (this.config.onError !== 'capable' || top === '') {
      this.counters.kept += 1
      return { kind: 'keep' }
    }
    this.counters.routed += 1
    return { kind: 'route', model: top }
  }
}
