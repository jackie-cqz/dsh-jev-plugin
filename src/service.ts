/** Reusable Jev decision service, registered as `ctx.jev`. @module dsh-jev/service */

import { Service, type Context } from '@deepseek-ai/cordis'
import { cacheKey, JevResponseCache, type JevCacheStats } from './cache.ts'
import { JevClient, type CallSystemOneOptions } from './client.ts'
import { resolveConfig, type Config, type ResolvedConfig } from './config.ts'
import {
  JevHttpError,
  JevNetworkError,
  JevProtocolError,
  JevQuotaError,
  JevTimeoutError,
  JevValidationError,
} from './errors.ts'
import { assessHealth, type JevHealth } from './health.ts'
import { JevPolicy, type JevPolicyStats } from './policy.ts'
import type {
  ChoiceAnswer,
  JevAnswer,
  JevCriteria,
  JevQuestion,
  JevResponse,
  JevState,
  NoulAnswer,
  ScoreAnswer,
  SystemOneRequest,
} from './protocol.ts'
import type { JevCallRecord, JevTelemetry } from './telemetry.ts'
import { toChoiceAnswer, toJevResponse, toNoulAnswer, toScoreAnswer } from './validation.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    jev: JevService
  }
}

/** Answer id the single-question convenience methods ask Jev under. */
const DECISION_KEY = 'decision'

/** What the service has observed since it was constructed. */
export interface JevServiceStats {
  /**
   * Requests that reached the transport; cache hits and refused calls are excluded.
   * Success and error rates derive from this and {@link JevServiceStats.failures},
   * so neither is stored as a rate of its own.
   */
  calls: number
  /** Calls that failed for a service-side reason (see {@link isServiceFailure}). */
  failures: number
  /**
   * Retries performed by transports this service constructed, counted as they
   * were about to back off. A client passed through `deps.client` owns its own
   * retry loop and cannot be observed, so its retries are absent from this count.
   */
  retries: number
  /**
   * Cumulative tokens reported by successful calls. A cache hit performs no API
   * call and so adds nothing, and a failed call has no usage to add.
   */
  tokens: { input: number; output: number }
  /**
   * Wall-clock duration of the most recent successful transport call, in
   * milliseconds, or 0 before the first one. A failed call only extends
   * {@link JevServiceStats.failures}, and a cache hit performs no call, so
   * neither updates this.
   */
  lastLatencyMs: number
  /** Summed wall-clock duration of successful transport calls, in milliseconds. */
  totalLatencyMs: number
  /** Model ids seen on successful responses, de-duplicated in first-seen order. */
  models: string[]
  /** Call-admission counters and current breaker state. */
  policy: Readonly<JevPolicyStats>
  /** Response-cache counters. */
  cache: Readonly<JevCacheStats>
}

/** Replacement seams for the service; every field has a production default. */
export interface JevServiceDeps {
  /**
   * Transport; defaults to a {@link JevClient} built from the same configuration,
   * which is the only case whose retries reach {@link JevServiceStats.retries}.
   */
  client?: JevClient
  /** Clock in milliseconds, shared by the policy and the cache; defaults to `Date.now`. */
  now?: () => number
  /** Wait implementation for the policy's minimum-interval gap; defaults to a real timer. */
  sleep?: (ms: number) => Promise<void>
  /**
   * Observability sink for one redacted record per call. Absent means calls are
   * not recorded at all; the {@link JevTelemetry} instance owns sampling and the
   * sink, so this service only hands it records.
   */
  telemetry?: JevTelemetry
}

/**
 * Measure a state's serialized size in characters.
 *
 * A string is measured as itself; every other state is measured as its JSON
 * serialization. This is a character count — neither a byte count nor a token
 * count — so it bounds what is sent, not what the model charges for.
 * @param state - state about to be sent.
 * @returns the serialized character count.
 * @throws JevValidationError when the state cannot be serialized as JSON, which
 * the static type excludes but a runtime caller such as a hook can still produce.
 */
function stateChars(state: JevState): number {
  if (typeof state === 'string') return state.length
  try {
    return (JSON.stringify(state) ?? '').length
  } catch (error) {
    throw new JevValidationError(
      'state must be JSON-serializable; the value could not be serialized.',
      { cause: error },
    )
  }
}

/**
 * Whether a thrown value means the Jev service itself is unhealthy, and so
 * counts toward the circuit breaker.
 *
 * A caller-side rejection — `400`, `401`, `403`, `422`, or a configuration error —
 * proves the service answered, so it does not extend the failure streak. Counting
 * those would let a model trip the breaker with malformed arguments.
 * @param error - value thrown by one service call.
 * @returns `true` for transport, timeout, protocol, and envelope failures.
 */
/**
 * Read an error's machine-readable code without quoting its message.
 *
 * A `JevHttpError` message carries a truncated server response body, and a
 * telemetry record is durable and exportable, so only the stable code travels.
 * @param error - value thrown by one call.
 * @returns the plugin's stable error code, else the error's name, else its type.
 */
function errorCodeOf(error: unknown): string {
  if (typeof error !== 'object' || error === null) return typeof error
  const record = error as { code?: unknown; name?: unknown }
  if (typeof record.code === 'string' && record.code !== '') return record.code
  return typeof record.name === 'string' && record.name !== '' ? record.name : 'unknown error'
}

function isServiceFailure(error: unknown): boolean {
  if (error instanceof JevNetworkError || error instanceof JevTimeoutError) return true
  if (error instanceof JevQuotaError) return true
  if (error instanceof JevProtocolError || error instanceof JevValidationError) return true
  if (error instanceof JevHttpError) return error.retryable
  return false
}

/**
 * Jev decisions as a Cordis service, so hooks, routes, and tools reach one
 * shared transport, one retry budget, one admission policy, and one cache
 * instead of each constructing their own client.
 *
 * Time and waiting are injectable because the admission policy needs both; a
 * caller supplying `now` must supply a `sleep` that advances it.
 */
export class JevService extends Service {
  private readonly config: ResolvedConfig
  private readonly client: JevClient
  private readonly policy: JevPolicy
  private readonly cache: JevResponseCache
  /** Clock the latency counters read; defaults to `Date.now`. */
  private readonly now: () => number
  /**
   * Counters live in one mutable object so every `ctx.jev` view reaches the same
   * state by construction, rather than relying on how a per-context view
   * forwards assignment to a primitive field. The cache is shared the same way.
   */
  /** Observability sink; absent leaves every call unrecorded. */
  private readonly telemetry: JevTelemetry | undefined

  private readonly counters = {
    calls: 0,
    failures: 0,
    retries: 0,
    tokens: { input: 0, output: 0 },
    lastLatencyMs: 0,
    totalLatencyMs: 0,
    models: [] as string[],
  }

  /**
   * @param ctx - context the service registers itself in.
   * @param config - raw plugin configuration; resolved here so a caller may pass
   * the same object it would give the plugin entry.
   * @param deps - transport, clock, and wait seams.
   */
  constructor(ctx: Context, config: Config = {}, deps: JevServiceDeps = {}) {
    super(ctx, 'jev')
    this.config = resolveConfig(config)
    this.now = deps.now ?? Date.now
    this.client = deps.client ?? new JevClient(this.config, {
      // Counted as each retry is about to back off, so the total reflects waits
      // that actually happened rather than attempts that were about to.
      onRetry: () => { this.counters.retries += 1 },
    })
    this.policy = new JevPolicy({
      config: this.config.policy,
      ...deps.now === undefined ? {} : { now: deps.now },
      ...deps.sleep === undefined ? {} : { sleep: deps.sleep },
    })
    this.cache = new JevResponseCache({
      config: this.config.cache,
      ...deps.now === undefined ? {} : { now: deps.now },
    })
    this.telemetry = deps.telemetry
  }

  /**
   * Run one System One request through the admission policy, the response cache,
   * and the transport, and validate the response envelope.
   * @param options - state, questions, optional model override, and cancellation.
   * @returns the validated response.
   * @throws JevValidationError when `state` exceeds `maxStateChars`, when it is not
   * JSON-serializable, or when the response violates the envelope contract. An
   * oversized state is rejected before the cache and the admission policy, so it
   * sends nothing, records nothing, and counts toward nothing.
   * @throws JevCircuitOpenError when the breaker refuses the call; no request is sent.
   * @throws the transport's own errors unchanged, including `JevConfigError` for a missing key.
   */
  async callSystemOne(options: CallSystemOneOptions): Promise<JevResponse> {
    const chars = stateChars(options.state)
    if (this.config.maxStateChars > 0 && chars > this.config.maxStateChars) {
      throw new JevValidationError(
        `state is ${chars} characters, which exceeds the configured maxStateChars of `
        + `${this.config.maxStateChars}; shorten the state or raise maxStateChars.`,
      )
    }
    const request: SystemOneRequest = {
      model: options.model ?? this.config.model,
      state: options.state,
      questions: options.questions,
    }
    const key = cacheKey(request)
    const cached = this.cache.get(key)
    if (cached !== undefined) {
      // A hit is still a decision the caller received, so it is recorded with no
      // latency, no tokens, and no transport work to report.
      this.emit({
        outcome: 'success',
        model: cached.model,
        latencyMs: 0,
        inputTokens: 0,
        outputTokens: 0,
        retries: 0,
        cache: 'hit',
        errorCode: undefined,
        serviceFailure: false,
      })
      return cached
    }

    // Admission precedes the request, and a refusal is not a call: it never
    // reaches the counters and never records an outcome.
    await this.policy.admit()
    this.counters.calls += 1
    const startedAt = this.now()
    const retriesBefore = this.counters.retries
    try {
      // The resolved model is forwarded rather than the caller's option bag, so
      // the request always matches the model the cache key was derived from.
      // Spreading `options` keeps `signal` and any later field intact.
      const response = toJevResponse(
        await this.client.callSystemOne({ ...options, model: request.model }),
      )
      // Latency is recorded only for a call that produced a usable envelope, so
      // the average is not dragged down by fast failures.
      const elapsed = this.now() - startedAt
      this.counters.lastLatencyMs = elapsed
      this.counters.totalLatencyMs += elapsed
      if (!this.counters.models.includes(response.model)) this.counters.models.push(response.model)
      this.cache.set(key, response)
      this.counters.tokens.input += response.usage.input_tokens
      this.counters.tokens.output += response.usage.output_tokens
      this.policy.record('success')
      this.emit({
        outcome: 'success',
        model: response.model,
        latencyMs: elapsed,
        inputTokens: response.usage.input_tokens,
        outputTokens: response.usage.output_tokens,
        retries: this.counters.retries - retriesBefore,
        cache: 'miss',
        errorCode: undefined,
        serviceFailure: false,
      })
      return response
    } catch (error) {
      const serviceFailure = isServiceFailure(error)
      if (serviceFailure) this.counters.failures += 1
      // Quota exhaustion opens a cooldown as well as extending the streak, so it
      // is reported separately from a transient failure.
      this.policy.record(
        serviceFailure ? error instanceof JevQuotaError ? 'quota' : 'failure' : 'success',
      )
      this.emit({
        outcome: 'failure',
        model: undefined,
        latencyMs: 0,
        inputTokens: 0,
        outputTokens: 0,
        retries: this.counters.retries - retriesBefore,
        cache: 'miss',
        errorCode: errorCodeOf(error),
        serviceFailure,
      })
      throw error
    }
  }

  /**
   * Read the deployment's view of service health.
   *
   * The assessment is derived from this service's own counters and breaker, so a
   * caller reads it rather than recomputing the thresholds.
   * @returns the health status and, when degraded, why.
   */
  health(): JevHealth {
    return assessHealth(
      {
        calls: this.counters.calls,
        failures: this.counters.failures,
        circuit: this.policy.stats().circuit,
      },
      {
        errorRateAlert: this.config.telemetry.errorRateAlert,
        alertMinCalls: this.config.telemetry.alertMinCalls,
      },
    )
  }

  /**
   * Hand one record to the observability sink, when one is configured.
   * @param record - redacted record for one completed call.
   */
  private emit(record: JevCallRecord): void {
    this.telemetry?.record(record)
  }

  /**
   * Ask one yes/no question.
   * @param state - text, object, or array Jev judges.
   * @param instructions - the question to ask.
   * @param criteria - optional rubric keyed by the yes/no reading.
   * @param signal - cancellation forwarded to the transport.
   * @returns the typed answer carrying the 0–1 probability.
   * @throws JevValidationError when the answer is not a well-formed `noul`.
   */
  async noul(
    state: JevState,
    instructions: string,
    criteria?: JevCriteria,
    signal?: AbortSignal,
  ): Promise<NoulAnswer> {
    const answers = await this.ask(state, {
      type: 'noul',
      instructions,
      ...criteria === undefined ? {} : { criteria },
    }, signal)
    return toNoulAnswer(answers[DECISION_KEY])
  }

  /**
   * Ask Jev to pick one label.
   * @param state - text, object, or array Jev judges.
   * @param instructions - the question to ask.
   * @param criteria - candidate labels mapped to an optional rubric.
   * @param signal - cancellation forwarded to the transport.
   * @returns the typed answer carrying the chosen label and its distribution.
   * @throws JevValidationError when the answer is not a well-formed `choice`.
   */
  async choice(
    state: JevState,
    instructions: string,
    criteria: JevCriteria,
    signal?: AbortSignal,
  ): Promise<ChoiceAnswer> {
    const answers = await this.ask(state, { type: 'choice', instructions, criteria }, signal)
    return toChoiceAnswer(answers[DECISION_KEY])
  }

  /**
   * Ask Jev to place a state on ordered levels.
   * @param state - text, object, or array Jev judges.
   * @param instructions - the question to ask.
   * @param criteria - ordered levels, lowest first.
   * @param signal - cancellation forwarded to the transport.
   * @returns the typed answer carrying the score, legend, and distribution.
   * @throws JevValidationError when the answer is not a well-formed `score`.
   */
  async score(
    state: JevState,
    instructions: string,
    criteria: string[],
    signal?: AbortSignal,
  ): Promise<ScoreAnswer> {
    const answers = await this.ask(state, { type: 'score', instructions, criteria }, signal)
    return toScoreAnswer(answers[DECISION_KEY])
  }

  /**
   * Read the service counters.
   * @returns a snapshot; later activity does not mutate it, including the
   * returned `models` array and `tokens` object.
   */
  stats(): Readonly<JevServiceStats> {
    return {
      calls: this.counters.calls,
      failures: this.counters.failures,
      retries: this.counters.retries,
      tokens: { input: this.counters.tokens.input, output: this.counters.tokens.output },
      lastLatencyMs: this.counters.lastLatencyMs,
      totalLatencyMs: this.counters.totalLatencyMs,
      models: [...this.counters.models],
      policy: this.policy.stats(),
      cache: this.cache.stats(),
    }
  }

  /**
   * Ask one question under the shared answer id.
   * @param state - text, object, or array Jev judges.
   * @param question - the single question to send.
   * @param signal - cancellation forwarded to the transport.
   * @returns the raw answer map, keyed by `decision`.
   */
  private async ask(
    state: JevState,
    question: JevQuestion,
    signal?: AbortSignal,
  ): Promise<Record<string, JevAnswer>> {
    const response = await this.callSystemOne({
      state,
      questions: { [DECISION_KEY]: question },
      ...signal === undefined ? {} : { signal },
    })
    return response.answers
  }
}
