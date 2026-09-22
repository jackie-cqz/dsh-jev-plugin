/** Plugin configuration, defaults, and resolution. @module dsh-jev/config */

import { JevConfigError } from './errors.ts'

/** Retry policy overrides supplied by the deployment. */
export interface RetryConfig {
  /** Total attempts per call, including the first; at least 1. */
  maxAttempts?: number
  /** First backoff delay in milliseconds. */
  baseDelayMs?: number
  /** Upper bound for a single backoff delay in milliseconds. */
  maxDelayMs?: number
}

/** Retry policy with every field resolved. */
export interface ResolvedRetryConfig extends Required<RetryConfig> {}

/**
 * Call-admission policy: a circuit breaker for repeated failures and a minimum
 * spacing between calls. Disabled by default so the tools keep the MVP's
 * behavior until a deployment opts in.
 */
export interface PolicyConfig {
  /** Enables the breaker and the spacing limit; defaults to `false`. */
  enabled?: boolean
  /** Consecutive failed calls that open the circuit; defaults to 5. */
  failureThreshold?: number
  /** Milliseconds the circuit stays open before one probe call; defaults to 30000. */
  openMs?: number
  /** Minimum milliseconds between two calls; 0 means no spacing; defaults to 200. */
  minIntervalMs?: number
}

/** Call-admission policy with every field resolved. */
export interface ResolvedPolicyConfig extends Required<PolicyConfig> {}

/**
 * Response cache for identical `(model, state, questions)` requests. Disabled by
 * default: a cached decision is a stale decision, so a deployment must ask for it.
 */
export interface CacheConfig {
  /** Enables the cache; defaults to `false`. */
  enabled?: boolean
  /** Retained entries before the least recently used one is evicted; defaults to 100. */
  maxEntries?: number
  /** Entry lifetime in milliseconds; defaults to 60000. */
  ttlMs?: number
}

/** Response cache with every field resolved. */
export interface ResolvedCacheConfig extends Required<CacheConfig> {}

/**
 * Confidence bands the recommendation helper maps a decision onto. Thresholds
 * are deployment policy, not a property of the API, so they live here.
 */
export interface ConfidenceConfig {
  /** Confidence at or above which a decision may be applied automatically; defaults to 0.8. */
  approveAt?: number
  /** Confidence below which a decision should go to a human; defaults to 0.5. */
  escalateBelow?: number
}

/** Confidence bands with every field resolved. */
export interface ResolvedConfidenceConfig extends Required<ConfidenceConfig> {}

/**
 * Pre-execute risk gate: Jev scores a pending tool call and the gate maps that
 * score onto allow, approval, or denial. Disabled by default, so a deployment
 * opts into interception.
 */
export interface GuardConfig {
  /** Enables the gate; defaults to `false`, so no call is intercepted. */
  enabled?: boolean
  /** Tool names inspected; an empty list inspects every tool. */
  tools?: string[]
  /** Question Jev answers about one pending call. */
  question?: string
  /** Ordered risk levels, lowest first; 2–10 entries. */
  levels?: string[]
  /** Risk score at or above which a call is denied; defaults to the top level. */
  denyAt?: number
  /** Risk score at or above which a call needs approval; defaults to one below `denyAt`. */
  askAt?: number
  /**
   * Whether an answer below `confidence.escalateBelow` needs approval instead of
   * being allowed; defaults to `true`.
   */
  escalateOnLowConfidence?: boolean
  /**
   * Risk score at or above which the call is refused with rewrite guidance
   * instead of being escalated to a human. Must lie between `askAt` and
   * `denyAt`; defaults to `denyAt`, which leaves the band empty until a
   * deployment widens it.
   */
  reviseAt?: number
  /**
   * What the gate does when Jev itself fails (transport, timeout, breaker):
   * `allow` keeps the agent working, `deny` refuses anything the gate could not
   * clear. Defaults to `allow`.
   */
  onError?: 'allow' | 'deny'
}

/** Risk gate with every field resolved. */
export interface ResolvedGuardConfig extends Required<GuardConfig> {}

/**
 * Deterministic offline rules evaluated before any semantic check.
 *
 * They run synchronously, need no API key, and cannot be overridden by an
 * approval: this is the layer that still refuses known-destructive commands when
 * the model backend is unreachable or out of quota.
 */
export interface RulesConfig {
  /** Enables the rule layer; defaults to `false`. */
  enabled?: boolean
  /** Tool names the rules inspect; an empty list inspects every tool. */
  tools?: string[]
  /** Extra deny patterns appended to the built-in set, as case-insensitive regular expressions. */
  deny?: string[]
}

/** Rule layer with every field resolved. */
export interface ResolvedRulesConfig extends Required<RulesConfig> {}

/**
 * Post-execute result review: Jev judges whether a finished tool result needs
 * correction, and the hook blocks it with feedback when it does. Disabled by
 * default — blocking rewrites a result the tool already produced.
 */
export interface ReviewConfig {
  /** Enables the review; defaults to `false`. */
  enabled?: boolean
  /** Tool names reviewed; an empty list reviews every tool. */
  tools?: string[]
  /** Question Jev answers about one finished call. */
  question?: string
  /** Probability of "needs correction" at or above which the result is blocked; defaults to 0.8. */
  blockAt?: number
  /** What the hook does when Jev fails; `accept` passes the result through. Defaults to `accept`. */
  onError?: 'accept' | 'block'
}

/** Result review with every field resolved. */
export interface ResolvedReviewConfig extends Required<ReviewConfig> {}

/**
 * Model routing: Jev scores how demanding the next request is and the hook maps
 * that band onto a model id. Disabled by default.
 */
export interface RoutingConfig {
  /** Enables routing; defaults to `false`. */
  enabled?: boolean
  /** Question Jev answers about the pending request. */
  question?: string
  /** Ordered demand levels, lowest first; 2–10 entries. */
  levels?: string[]
  /**
   * Model id per level, aligned index-for-index with `levels`. An empty string
   * keeps the model the request already asked for.
   */
  models?: string[]
  /** What the hook does when Jev fails; `keep` leaves the request alone. Defaults to `keep`. */
  onError?: 'keep' | 'capable'
}

/** Model routing with every field resolved. */
export interface ResolvedRoutingConfig extends Required<RoutingConfig> {}

/**
 * Context pruning: above a message threshold, Jev scores older messages for
 * continued relevance and the hook admits a reduced list. Disabled by default.
 */
export interface ContextConfig {
  /** Enables pruning; defaults to `false`. */
  enabled?: boolean
  /** Message count that starts pruning; defaults to 40. */
  triggerMessages?: number
  /** Most recent messages never considered for dropping; defaults to 10. */
  keepRecent?: number
  /** Relevance probability below which an older message is dropped; defaults to 0.3. */
  dropBelow?: number
  /** Question Jev answers about each candidate message. */
  question?: string
  /**
   * Most messages one pass may drop; `0` leaves it uncapped. A cap keeps one
   * unlucky judgement from gutting the history in a single step.
   */
  maxDrops?: number
  /**
   * Reports what a pass would drop without changing the admitted list; defaults
   * to `false`. Any hook that removes content should be run in this mode first.
   */
  shadow?: boolean
}

/** Context pruning with every field resolved. */
export interface ResolvedContextConfig extends Required<ContextConfig> {}

/**
 * Intent routing: Jev classifies the latest user turn and the hook admits one
 * directive line that shapes how the agent approaches it. Disabled by default.
 */
export interface IntentConfig {
  /** Enables intent routing; defaults to `false`. */
  enabled?: boolean
  /** Question Jev answers about the latest user turn. */
  question?: string
  /** Ordered intent classes; 2–255 entries. */
  classes?: string[]
  /** Directive admitted per class; a class with no entry admits nothing. */
  directives?: Record<string, string>
}

/** Intent routing with every field resolved. */
export interface ResolvedIntentConfig extends Required<IntentConfig> {}

/**
 * Observability: one redacted structured record per call, how many calls are
 * recorded, and the error rate that means the service is degraded.
 */
export interface TelemetryConfig {
  /** Emits a redacted record per recorded call; defaults to `false`. */
  log?: boolean
  /** Fraction of calls recorded, 0–1; defaults to 1 when logging. */
  sampleRate?: number
  /** Error rate (failures / calls) at or above which health reports degraded; defaults to 0.5. */
  errorRateAlert?: number
  /** Calls required before the error-rate alert may fire; defaults to 10. */
  alertMinCalls?: number
}

/** Telemetry with every field resolved. */
export interface ResolvedTelemetryConfig extends Required<TelemetryConfig> {}

/** Raw plugin configuration supplied by DSH. */
export interface Config {
  /** Jev API key; takes precedence over {@link Config.apiKeyEnv}. */
  apiKey?: string
  /** Environment variable read when `apiKey` is absent. */
  apiKeyEnv?: string
  /** TypeSafe API base URL; the client appends `/systemone`. */
  baseURL?: string
  /** Default Jev model id, overridable per tool call. */
  model?: string
  /** Per-call timeout in milliseconds. */
  timeoutMs?: number
  /**
   * Milliseconds the plugin stops sending requests after the API reports quota
   * exhaustion; `0` disables the cooldown. Defaults to 900000.
   *
   * This sits here rather than under `policy` because an exhausted quota does not
   * recover by retrying, and because a deployment that enables only the offline
   * rule layer still needs the cooldown: the rule layer exists precisely for the
   * no-key and out-of-quota cases, and without this it would send a request per
   * refused call just to collect another `402`.
   */
  quotaCooldownMs?: number
  /** Retry policy overrides. */
  retry?: RetryConfig
  /** Call-admission policy; disabled unless enabled here. */
  policy?: PolicyConfig
  /** Response cache; disabled unless enabled here. */
  cache?: CacheConfig
  /**
   * Largest `state` the plugin sends, measured as serialized characters; `0`
   * removes the limit. Defaults to 64000, which matches Jev's documented
   * context size while staying generous enough for ordinary tickets.
   */
  maxStateChars?: number
  /** Confidence bands for the recommendation helper. */
  confidence?: ConfidenceConfig
  /** Pre-execute risk gate; disabled unless enabled here. */
  guard?: GuardConfig
  /** Deterministic offline rules; disabled unless enabled here. */
  rules?: RulesConfig
  /** Post-execute result review; disabled unless enabled here. */
  review?: ReviewConfig
  /** Model routing; disabled unless enabled here. */
  routing?: RoutingConfig
  /** Context pruning; disabled unless enabled here. */
  context?: ContextConfig
  /** Intent routing; disabled unless enabled here. */
  intent?: IntentConfig
  /** Telemetry, sampling, and alert thresholds. */
  telemetry?: TelemetryConfig
  /** Registers the `jev_decide` tool; defaults to `true`. */
  enableDecide?: boolean
  /** Registers the `jev_evaluate` tool; defaults to `true`. */
  enableEvaluate?: boolean
}

/** Environment variable read when `apiKey` is absent. */
export const DEFAULT_API_KEY_ENV = 'TYPESAFE_API_KEY'

/** Default TypeSafe API base URL, without a trailing slash. */
export const DEFAULT_BASE_URL = 'https://api.typesafe.ai/v1'

/** Default Jev model id. */
export const DEFAULT_MODEL = 'jev-latest'

/** Default per-call timeout in milliseconds. */
export const DEFAULT_TIMEOUT_MS = 10_000

/** Default retry policy. */
export const DEFAULT_RETRY: ResolvedRetryConfig = {
  maxAttempts: 3,
  baseDelayMs: 500,
  maxDelayMs: 5_000,
}

/** Default quota cooldown, in milliseconds. */
export const DEFAULT_QUOTA_COOLDOWN_MS = 900_000

/** Default call-admission policy; `enabled: false` keeps MVP behavior. */
export const DEFAULT_POLICY: ResolvedPolicyConfig = {
  enabled: false,
  failureThreshold: 5,
  openMs: 30_000,
  minIntervalMs: 200,
}

/** Default response cache; `enabled: false` keeps MVP behavior. */
export const DEFAULT_CACHE: ResolvedCacheConfig = {
  enabled: false,
  maxEntries: 100,
  ttlMs: 60_000,
}

/** Default `state` size cap, in serialized characters. */
export const DEFAULT_MAX_STATE_CHARS = 64_000

/** Default confidence bands. */
export const DEFAULT_CONFIDENCE: ResolvedConfidenceConfig = {
  approveAt: 0.8,
  escalateBelow: 0.5,
}

/** Default risk levels, lowest first. */
export const DEFAULT_GUARD_LEVELS: readonly string[] = ['low', 'medium', 'high', 'critical']

/** Default pre-execute risk gate. `enabled: false` means no call is intercepted. */
export const DEFAULT_GUARD: ResolvedGuardConfig = {  enabled: false,
  tools: [],
  question:
    'How risky is this tool call? Consider whether it can destroy or overwrite data, '
    + 'leak secrets or personal data, affect production systems, spend money, or is '
    + 'otherwise difficult to reverse.',
  levels: [...DEFAULT_GUARD_LEVELS],
  // Calibrated against 100 real shell commands drawn from this machine's
  // session logs (median 0.54, p90 1.61, max 1.78 on this four-level scale).
  // The earlier `levels.length - 1` default assumed the scale's top is reached
  // routinely; it is reached only by language that describes catastrophic
  // action outright, so the gate never fired on a real command.
  denyAt: 2,
  askAt: 1,
  // Equal to denyAt: the band is empty until a deployment widens it.
  reviseAt: 2,
  escalateOnLowConfidence: true,
  onError: 'allow',
}

/** Default post-execute result review; `enabled: false` keeps MVP behavior. */
export const DEFAULT_REVIEW: ResolvedReviewConfig = {
  enabled: false,
  tools: [],
  question:
    'Did this tool call fail, or produce a result that has to be corrected before the '
    + 'task can continue? Answer yes for errors, unusable output, and results that '
    + 'contradict what the caller asked for.',
  blockAt: 0.8,
  onError: 'accept',
}

/** Default model routing; `enabled: false` keeps MVP behavior. */
export const DEFAULT_ROUTING: ResolvedRoutingConfig = {
  enabled: false,
  question:
    'How demanding is this request? Consider how much reasoning it needs, how many '
    + 'steps it implies, and how much context it must hold at once.',
  levels: ['simple', 'moderate', 'complex'],
  // Empty ids mean "keep whatever the request already asked for", so enabling
  // routing without naming models changes nothing.
  models: ['', '', ''],
  onError: 'keep',
}

/** Default context pruning; `enabled: false` keeps MVP behavior. */
export const DEFAULT_CONTEXT: ResolvedContextConfig = {
  enabled: false,
  triggerMessages: 40,
  keepRecent: 10,
  dropBelow: 0.3,
  maxDrops: 0,
  shadow: false,
  question: 'Is this earlier message still needed to continue the current task?',
}

/** Default intent routing; `enabled: false` keeps MVP behavior. */
export const DEFAULT_INTENT: ResolvedIntentConfig = {
  enabled: false,
  question: 'What is the user asking for in this turn?',
  classes: ['question', 'change', 'debug', 'review'],
  // A class with no directive admits nothing, so intent routing is inert until
  // a deployment writes the wording it wants.
  directives: {},
}

/** Default deterministic rules; `enabled: false` keeps MVP behavior. */
export const DEFAULT_RULES: ResolvedRulesConfig = {
  enabled: false,
  tools: [],
  deny: [],
}

/** Default telemetry: no records emitted, but alert thresholds are always available. */
export const DEFAULT_TELEMETRY: ResolvedTelemetryConfig = {
  log: false,
  sampleRate: 1,
  errorRateAlert: 0.5,
  alertMinCalls: 10,
}

/**
 * Configuration with every default applied. The API key stays optional here so
 * the plugin loads and reports misconfiguration at the first tool call instead
 * of at profile load; {@link resolveApiKey} turns its absence into an error. */
export interface ResolvedConfig {
  /** Effective API key, or `undefined` when neither source provides one. */
  apiKey: string | undefined
  /** Environment variable consulted for the API key. */
  apiKeyEnv: string
  /** TypeSafe API base URL, without a trailing slash. */
  baseURL: string
  /** Default Jev model id. */
  model: string
  /** Per-call timeout in milliseconds. */
  timeoutMs: number
  /** Quota cooldown in milliseconds; `0` disables it. */
  quotaCooldownMs: number
  /** Retry policy with every field resolved. */
  retry: ResolvedRetryConfig
  /** Call-admission policy with every field resolved. */
  policy: ResolvedPolicyConfig
  /** Response cache with every field resolved. */
  cache: ResolvedCacheConfig
  /** `state` size cap in serialized characters; `0` means unlimited. */
  maxStateChars: number
  /** Confidence bands with every field resolved. */
  confidence: ResolvedConfidenceConfig
  /** Pre-execute risk gate with every field resolved. */
  guard: ResolvedGuardConfig
  /** Deterministic offline rules with every field resolved. */
  rules: ResolvedRulesConfig
  /** Post-execute result review with every field resolved. */
  review: ResolvedReviewConfig
  /** Model routing with every field resolved. */
  routing: ResolvedRoutingConfig
  /** Context pruning with every field resolved. */
  context: ResolvedContextConfig
  /** Intent routing with every field resolved. */
  intent: ResolvedIntentConfig
  /** Telemetry with every field resolved. */
  telemetry: ResolvedTelemetryConfig
  /** Whether the `jev_decide` tool is registered. */
  enableDecide: boolean
  /** Whether the `jev_evaluate` tool is registered. */
  enableEvaluate: boolean
}

/** Reject a non-positive or non-finite numeric configuration field. */
function requirePositiveNumber(value: number, field: string): number {
  if (!Number.isFinite(value) || value <= 0) {
    throw new JevConfigError(
      `Jev configuration "${field}" must be a positive finite number, received ${String(value)}.`,
    )
  }
  return value
}

/** Reject a negative or non-finite numeric configuration field. */
function requireNonNegativeNumber(value: number, field: string): number {
  if (!Number.isFinite(value) || value < 0) {
    throw new JevConfigError(
      `Jev configuration "${field}" must be a non-negative finite number, received ${String(value)}.`,
    )
  }
  return value
}

/** Reject a blank string configuration field. */
function requireNonBlankString(value: string, field: string): string {
  if (value.trim() === '') {
    throw new JevConfigError(`Jev configuration "${field}" must not be blank.`)
  }
  return value
}

/** Strip trailing slashes so `baseURL` + `/systemone` never doubles a separator. */
function normalizeBaseURL(value: string): string {
  return requireNonBlankString(value, 'baseURL').replace(/\/+$/, '')
}

/** Reject a confidence threshold outside the closed unit interval. */
function requireUnitInterval(value: number, field: string): number {
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new JevConfigError(
      `Jev configuration "${field}" must be within [0, 1], received ${String(value)}.`,
    )
  }
  return value
}

/**
 * Resolve the confidence bands, rejecting an ordering that leaves no band between them.
 * @param overrides - raw confidence configuration, if any.
 * @returns both thresholds, each within `[0, 1]` and ordered lowest first.
 * @throws JevConfigError when a threshold is out of range or the bands cross.
 */
function resolveConfidence(overrides: ConfidenceConfig | undefined): ResolvedConfidenceConfig {
  const approveAt = requireUnitInterval(
    overrides?.approveAt ?? DEFAULT_CONFIDENCE.approveAt,
    'confidence.approveAt',
  )
  const escalateBelow = requireUnitInterval(
    overrides?.escalateBelow ?? DEFAULT_CONFIDENCE.escalateBelow,
    'confidence.escalateBelow',
  )
  if (escalateBelow > approveAt) {
    throw new JevConfigError(
      `Jev configuration "confidence.escalateBelow" (${String(escalateBelow)}) must not exceed `
      + `"confidence.approveAt" (${String(approveAt)}).`,
    )
  }
  return { approveAt, escalateBelow }
}

/** Reject a risk-score threshold that is not an integer inside the level range. */
function requireLevelIndex(value: number, field: string, max: number): number {
  if (!Number.isInteger(value) || value < 0 || value > max) {
    throw new JevConfigError(
      `Jev configuration "${field}" must be an integer within [0, ${String(max)}], received ${String(value)}.`,
    )
  }
  return value
}

/**
 * Resolve the risk gate. The score thresholds default relative to the resolved
 * level list, so a deployment that replaces `levels` still gets a usable gate
 * without restating them.
 * @param overrides - raw guard configuration, if any.
 * @returns the gate configuration with every field resolved.
 * @throws JevConfigError when the levels, thresholds, scope, or error policy are unusable.
 */
function resolveGuard(overrides: GuardConfig | undefined): ResolvedGuardConfig {
  const levels = overrides?.levels ?? DEFAULT_GUARD.levels
  if (levels.length < 2 || levels.length > 10) {
    throw new JevConfigError(
      `Jev configuration "guard.levels" must list between 2 and 10 levels, received ${String(levels.length)}.`,
    )
  }
  for (let index = 0; index < levels.length; index += 1) {
    const level = levels[index]
    if (typeof level !== 'string' || level.trim() === '') {
      throw new JevConfigError(`Jev configuration "guard.levels[${String(index)}]" must be a non-empty string.`)
    }
  }
  const lastIndex = levels.length - 1
  // Defaults come from DEFAULT_GUARD and clamp to this list, so a deployment
  // with fewer levels resolves instead of failing on a threshold it never named.
  // An explicit value is validated, never clamped.
  const denyAt = overrides?.denyAt === undefined
    ? Math.min(DEFAULT_GUARD.denyAt, lastIndex)
    : requireLevelIndex(overrides.denyAt, 'guard.denyAt', lastIndex)
  const askAt = overrides?.askAt === undefined
    ? Math.min(DEFAULT_GUARD.askAt, denyAt)
    : requireLevelIndex(overrides.askAt, 'guard.askAt', lastIndex)
  const reviseAt = requireLevelIndex(overrides?.reviseAt ?? denyAt, 'guard.reviseAt', lastIndex)
  if (reviseAt < askAt) {
    throw new JevConfigError(
      `Jev configuration "guard.reviseAt" (${String(reviseAt)}) must not be below `
      + `"guard.askAt" (${String(askAt)}).`,
    )
  }
  if (askAt > denyAt) {
    throw new JevConfigError(
      `Jev configuration "guard.askAt" (${String(askAt)}) must not exceed `
      + `"guard.denyAt" (${String(denyAt)}).`,
    )
  }
  const onError = overrides?.onError ?? DEFAULT_GUARD.onError
  if (onError !== 'allow' && onError !== 'deny') {
    throw new JevConfigError(
      `Jev configuration "guard.onError" must be "allow" or "deny", received ${String(onError)}.`,
    )
  }
  const tools = overrides?.tools ?? DEFAULT_GUARD.tools
  for (let index = 0; index < tools.length; index += 1) {
    const tool = tools[index]
    if (typeof tool !== 'string' || tool.trim() === '') {
      throw new JevConfigError(`Jev configuration "guard.tools[${String(index)}]" must be a non-empty string.`)
    }
  }
  return {
    enabled: overrides?.enabled ?? DEFAULT_GUARD.enabled,
    tools: [...tools],
    question: requireNonBlankString(overrides?.question ?? DEFAULT_GUARD.question, 'guard.question'),
    levels: [...levels],
    denyAt,
    askAt,
    reviseAt,
    escalateOnLowConfidence: overrides?.escalateOnLowConfidence ?? DEFAULT_GUARD.escalateOnLowConfidence,
    onError,
  }
}

/** Reject an empty or blank element in a string list configuration field. */
function requireStringList(values: readonly string[], field: string): string[] {
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index]
    if (typeof value !== 'string' || value.trim() === '') {
      throw new JevConfigError(`Jev configuration "${field}[${String(index)}]" must be a non-empty string.`)
    }
  }
  return [...values]
}

/** Reject a blank tool name, and copy the list so later mutation cannot leak in. */
function resolveToolNames(overrides: string[] | undefined, field: string, fallback: string[]): string[] {
  const tools = overrides ?? fallback
  return tools.length === 0 ? [] : requireStringList(tools, field)
}

/**
 * Resolve the post-execute result review.
 * @param overrides - raw review configuration, if any.
 * @returns the review configuration with every field resolved.
 * @throws JevConfigError when the threshold or error policy is unusable.
 */
function resolveReview(overrides: ReviewConfig | undefined): ResolvedReviewConfig {
  const blockAt = requireUnitInterval(overrides?.blockAt ?? DEFAULT_REVIEW.blockAt, 'review.blockAt')
  const onError = overrides?.onError ?? DEFAULT_REVIEW.onError
  if (onError !== 'accept' && onError !== 'block') {
    throw new JevConfigError(
      `Jev configuration "review.onError" must be "accept" or "block", received ${String(onError)}.`,
    )
  }
  return {
    enabled: overrides?.enabled ?? DEFAULT_REVIEW.enabled,
    tools: resolveToolNames(overrides?.tools, 'review.tools', DEFAULT_REVIEW.tools),
    question: requireNonBlankString(overrides?.question ?? DEFAULT_REVIEW.question, 'review.question'),
    blockAt,
    onError,
  }
}

/**
 * Resolve model routing. Model ids are positional against the level list, so a
 * mismatch is rejected rather than silently truncating one of them.
 * @param overrides - raw routing configuration, if any.
 * @returns the routing configuration with every field resolved.
 * @throws JevConfigError when the levels, models, or error policy are unusable.
 */
function resolveRouting(overrides: RoutingConfig | undefined): ResolvedRoutingConfig {
  const levels = requireStringList(overrides?.levels ?? DEFAULT_ROUTING.levels, 'routing.levels')
  if (levels.length < 2 || levels.length > 10) {
    throw new JevConfigError(
      `Jev configuration "routing.levels" must list between 2 and 10 levels, received ${String(levels.length)}.`,
    )
  }
  const models = [...(overrides?.models ?? DEFAULT_ROUTING.models)]
  if (models.length !== levels.length) {
    throw new JevConfigError(
      `Jev configuration "routing.models" must hold one entry per level (${String(levels.length)}), `
      + `received ${String(models.length)}. Use an empty string to keep the requested model.`,
    )
  }
  for (let index = 0; index < models.length; index += 1) {
    if (typeof models[index] !== 'string') {
      throw new JevConfigError(`Jev configuration "routing.models[${String(index)}]" must be a string.`)
    }
  }
  const onError = overrides?.onError ?? DEFAULT_ROUTING.onError
  if (onError !== 'keep' && onError !== 'capable') {
    throw new JevConfigError(
      `Jev configuration "routing.onError" must be "keep" or "capable", received ${String(onError)}.`,
    )
  }
  return {
    enabled: overrides?.enabled ?? DEFAULT_ROUTING.enabled,
    question: requireNonBlankString(overrides?.question ?? DEFAULT_ROUTING.question, 'routing.question'),
    levels,
    models,
    onError,
  }
}

/**
 * Resolve context pruning. A `keepRecent` that reaches `triggerMessages` leaves
 * nothing prunable, so it is rejected instead of silently doing nothing.
 * @param overrides - raw context configuration, if any.
 * @returns the context configuration with every field resolved.
 * @throws JevConfigError when the thresholds cannot both hold.
 */
function resolveContext(overrides: ContextConfig | undefined): ResolvedContextConfig {
  const triggerMessages = overrides?.triggerMessages ?? DEFAULT_CONTEXT.triggerMessages
  if (!Number.isInteger(triggerMessages) || triggerMessages < 2) {
    throw new JevConfigError(
      `Jev configuration "context.triggerMessages" must be an integer of at least 2, received ${String(triggerMessages)}.`,
    )
  }
  const keepRecent = overrides?.keepRecent ?? DEFAULT_CONTEXT.keepRecent
  if (!Number.isInteger(keepRecent) || keepRecent < 0) {
    throw new JevConfigError(
      `Jev configuration "context.keepRecent" must be a non-negative integer, received ${String(keepRecent)}.`,
    )
  }
  if (keepRecent >= triggerMessages) {
    throw new JevConfigError(
      `Jev configuration "context.keepRecent" (${String(keepRecent)}) must be below `
      + `"context.triggerMessages" (${String(triggerMessages)}), otherwise nothing is ever prunable.`,
    )
  }
  const maxDrops = overrides?.maxDrops ?? DEFAULT_CONTEXT.maxDrops
  if (!Number.isInteger(maxDrops) || maxDrops < 0) {
    throw new JevConfigError(
      `Jev configuration "context.maxDrops" must be a non-negative integer, received ${String(maxDrops)}.`,
    )
  }
  return {
    enabled: overrides?.enabled ?? DEFAULT_CONTEXT.enabled,
    triggerMessages,
    keepRecent,
    dropBelow: requireUnitInterval(overrides?.dropBelow ?? DEFAULT_CONTEXT.dropBelow, 'context.dropBelow'),
    question: requireNonBlankString(overrides?.question ?? DEFAULT_CONTEXT.question, 'context.question'),
    maxDrops,
    shadow: overrides?.shadow ?? DEFAULT_CONTEXT.shadow,
  }
}

/**
 * Resolve the deterministic rule layer, compiling every pattern here so a
 * malformed regular expression fails at load rather than mid-gate.
 * @param overrides - raw rules configuration, if any.
 * @returns the rule configuration with every field resolved.
 * @throws JevConfigError when a pattern is not a valid regular expression.
 */
function resolveRules(overrides: RulesConfig | undefined): ResolvedRulesConfig {
  const deny = requireStringList(overrides?.deny ?? DEFAULT_RULES.deny, 'rules.deny')
  for (const pattern of deny) {
    try {
      new RegExp(pattern, 'i')
    } catch (error) {
      throw new JevConfigError(
        `Jev configuration "rules.deny" holds an invalid regular expression: ${pattern}`,
        { cause: error },
      )
    }
  }
  return {
    enabled: overrides?.enabled ?? DEFAULT_RULES.enabled,
    tools: resolveToolNames(overrides?.tools, 'rules.tools', DEFAULT_RULES.tools),
    deny,
  }
}

/**
 * Resolve intent routing, rejecting a directive that names no configured class:
 * a typo there would otherwise leave the hook silently inert.
 * @param overrides - raw intent configuration, if any.
 * @returns the intent configuration with every field resolved.
 * @throws JevConfigError when the classes or directives are unusable.
 */
function resolveIntent(overrides: IntentConfig | undefined): ResolvedIntentConfig {
  const classes = requireStringList(overrides?.classes ?? DEFAULT_INTENT.classes, 'intent.classes')
  if (classes.length < 2 || classes.length > 255) {
    throw new JevConfigError(
      `Jev configuration "intent.classes" must list between 2 and 255 classes, received ${String(classes.length)}.`,
    )
  }
  const directives = overrides?.directives ?? DEFAULT_INTENT.directives
  for (const [key, directive] of Object.entries(directives)) {
    if (!classes.includes(key)) {
      throw new JevConfigError(
        `Jev configuration "intent.directives.${key}" names no class in "intent.classes".`,
      )
    }
    if (typeof directive !== 'string' || directive.trim() === '') {
      throw new JevConfigError(`Jev configuration "intent.directives.${key}" must be a non-empty string.`)
    }
  }
  return {
    enabled: overrides?.enabled ?? DEFAULT_INTENT.enabled,
    question: requireNonBlankString(overrides?.question ?? DEFAULT_INTENT.question, 'intent.question'),
    classes,
    directives: { ...directives },
  }
}

/**
 * Resolve the telemetry settings.
 * @param overrides - raw telemetry configuration, if any.
 * @returns telemetry with every field resolved.
 * @throws JevConfigError when the sample rate or thresholds are unusable.
 */
function resolveTelemetry(overrides: TelemetryConfig | undefined): ResolvedTelemetryConfig {
  const alertMinCalls = overrides?.alertMinCalls ?? DEFAULT_TELEMETRY.alertMinCalls
  if (!Number.isInteger(alertMinCalls) || alertMinCalls < 1) {
    throw new JevConfigError(
      `Jev configuration "telemetry.alertMinCalls" must be a positive integer, received ${String(alertMinCalls)}.`,
    )
  }
  return {
    log: overrides?.log ?? DEFAULT_TELEMETRY.log,
    sampleRate: requireUnitInterval(overrides?.sampleRate ?? DEFAULT_TELEMETRY.sampleRate, 'telemetry.sampleRate'),
    errorRateAlert: requireUnitInterval(
      overrides?.errorRateAlert ?? DEFAULT_TELEMETRY.errorRateAlert,
      'telemetry.errorRateAlert',
    ),
    alertMinCalls,
  }
}

/**
 * Apply documented defaults to raw plugin configuration.
 * @param config - raw configuration from `cordis.yml`, if any.
 * @param env - environment consulted for the API key; defaults to `process.env`.
 * @returns configuration with every non-secret field resolved and validated.
 * @throws JevConfigError when a provided field is unusable.
 */
export function resolveConfig(config: Config = {}, env: NodeJS.ProcessEnv = process.env): ResolvedConfig {
  const apiKeyEnv = requireNonBlankString(config.apiKeyEnv ?? DEFAULT_API_KEY_ENV, 'apiKeyEnv')
  // A blank configured key counts as absent, so it cannot shadow a usable
  // environment variable.
  const configuredApiKey = config.apiKey === '' ? undefined : config.apiKey
  const rawApiKey = configuredApiKey ?? env[apiKeyEnv]
  return {
    apiKey: rawApiKey === undefined || rawApiKey === '' ? undefined : rawApiKey,
    apiKeyEnv,
    baseURL: normalizeBaseURL(config.baseURL ?? DEFAULT_BASE_URL),
    model: requireNonBlankString(config.model ?? DEFAULT_MODEL, 'model'),
    timeoutMs: requirePositiveNumber(config.timeoutMs ?? DEFAULT_TIMEOUT_MS, 'timeoutMs'),
    quotaCooldownMs: requireNonNegativeNumber(
      config.quotaCooldownMs ?? DEFAULT_QUOTA_COOLDOWN_MS,
      'quotaCooldownMs',
    ),
    retry: {
      maxAttempts: requirePositiveNumber(
        config.retry?.maxAttempts ?? DEFAULT_RETRY.maxAttempts,
        'retry.maxAttempts',
      ),
      baseDelayMs: requireNonNegativeNumber(
        config.retry?.baseDelayMs ?? DEFAULT_RETRY.baseDelayMs,
        'retry.baseDelayMs',
      ),
      maxDelayMs: requireNonNegativeNumber(
        config.retry?.maxDelayMs ?? DEFAULT_RETRY.maxDelayMs,
        'retry.maxDelayMs',
      ),
    },
    policy: {
      enabled: config.policy?.enabled ?? DEFAULT_POLICY.enabled,
      failureThreshold: requirePositiveNumber(
        config.policy?.failureThreshold ?? DEFAULT_POLICY.failureThreshold,
        'policy.failureThreshold',
      ),
      openMs: requireNonNegativeNumber(config.policy?.openMs ?? DEFAULT_POLICY.openMs, 'policy.openMs'),
      minIntervalMs: requireNonNegativeNumber(
        config.policy?.minIntervalMs ?? DEFAULT_POLICY.minIntervalMs,
        'policy.minIntervalMs',
      ),
    },
    cache: {
      enabled: config.cache?.enabled ?? DEFAULT_CACHE.enabled,
      maxEntries: requirePositiveNumber(config.cache?.maxEntries ?? DEFAULT_CACHE.maxEntries, 'cache.maxEntries'),
      ttlMs: requirePositiveNumber(config.cache?.ttlMs ?? DEFAULT_CACHE.ttlMs, 'cache.ttlMs'),
    },
    maxStateChars: requireNonNegativeNumber(
      config.maxStateChars ?? DEFAULT_MAX_STATE_CHARS,
      'maxStateChars',
    ),
    confidence: resolveConfidence(config.confidence),
    guard: resolveGuard(config.guard),
    rules: resolveRules(config.rules),
    review: resolveReview(config.review),
    routing: resolveRouting(config.routing),
    context: resolveContext(config.context),
    intent: resolveIntent(config.intent),
    telemetry: resolveTelemetry(config.telemetry),
    enableDecide: config.enableDecide ?? true,
    enableEvaluate: config.enableEvaluate ?? true,
  }
}

/**
 * Return the configured Jev API key.
 * @param config - resolved configuration.
 * @returns the non-empty API key.
 * @throws JevConfigError naming both configuration sources when no key is available.
 */
export function resolveApiKey(config: ResolvedConfig): string {
  if (config.apiKey === undefined) {
    throw new JevConfigError(
      `Jev API key is missing. Set the "${config.apiKeyEnv}" environment variable, `
      + 'or set the plugin\'s "apiKey" configuration field.',
    )
  }
  return config.apiKey
}
