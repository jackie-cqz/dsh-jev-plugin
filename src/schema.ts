/** Schemastery schema the DSH loader validates plugin configuration against. @module dsh-jev/schema */

import z from '@deepseek-ai/schemastery'
import {
  DEFAULT_API_KEY_ENV,
  DEFAULT_BASE_URL,
  DEFAULT_CACHE,
  DEFAULT_CONFIDENCE,
  DEFAULT_CONTEXT,
  DEFAULT_GUARD,
  DEFAULT_INTENT,
  DEFAULT_MAX_STATE_CHARS,
  DEFAULT_MODEL,
  DEFAULT_POLICY,
  DEFAULT_RETRY,
  DEFAULT_ROUTING,
  DEFAULT_REVIEW,
  DEFAULT_TELEMETRY,
  DEFAULT_TIMEOUT_MS,
  type Config,
} from './config.ts'

/**
 * Validation schema for {@link Config}. Every field carries the same default
 * {@link resolveConfig} applies, so a profile may omit any of them.
 */
export const ConfigSchema: z<Config> = z.object({
  apiKey: z.string().role('secret').description('TypeSafe API key. Prefer the apiKeyEnv variable over inlining a key here.'),
  apiKeyEnv: z.string().default(DEFAULT_API_KEY_ENV).description('Environment variable read when apiKey is absent.'),
  baseURL: z.string().default(DEFAULT_BASE_URL).description('TypeSafe API base URL.'),
  model: z.string().default(DEFAULT_MODEL).description('Default Jev model id, overridable per tool call.'),
  timeoutMs: z.number().min(1).default(DEFAULT_TIMEOUT_MS).description('Per-call timeout in milliseconds.'),
  retry: z.object({
    maxAttempts: z.number().step(1).min(1).default(DEFAULT_RETRY.maxAttempts)
      .description('Total attempts per call, including the first.'),
    baseDelayMs: z.number().min(0).default(DEFAULT_RETRY.baseDelayMs)
      .description('First backoff delay in milliseconds.'),
    maxDelayMs: z.number().min(0).default(DEFAULT_RETRY.maxDelayMs)
      .description('Upper bound for a single backoff delay in milliseconds.'),
  }).description('Retry policy for retryable failures.'),
  policy: z.object({
    enabled: z.boolean().default(DEFAULT_POLICY.enabled)
      .description('Admit calls through a circuit breaker and a minimum spacing between calls.'),
    failureThreshold: z.number().step(1).min(1).default(DEFAULT_POLICY.failureThreshold)
      .description('Consecutive failed calls that open the circuit.'),
    openMs: z.number().min(0).default(DEFAULT_POLICY.openMs)
      .description('Milliseconds the circuit stays open before one probe call.'),
    minIntervalMs: z.number().min(0).default(DEFAULT_POLICY.minIntervalMs)
      .description('Minimum milliseconds between two calls; 0 disables the spacing.'),
  }).description('Call-admission policy; disabled by default.'),
  cache: z.object({
    enabled: z.boolean().default(DEFAULT_CACHE.enabled)
      .description('Serve identical (model, state, questions) requests from memory.'),
    maxEntries: z.number().step(1).min(1).default(DEFAULT_CACHE.maxEntries)
      .description('Retained entries before the least recently used one is evicted.'),
    ttlMs: z.number().min(1).default(DEFAULT_CACHE.ttlMs)
      .description('Entry lifetime in milliseconds.'),
  }).description('Response cache; disabled by default.'),
  maxStateChars: z.number().step(1).min(0).default(DEFAULT_MAX_STATE_CHARS)
    .description('Largest state in serialized characters; 0 removes the limit.'),
  confidence: z.object({
    approveAt: z.number().min(0).max(1).default(DEFAULT_CONFIDENCE.approveAt)
      .description('Confidence at or above which a decision may be applied automatically.'),
    escalateBelow: z.number().min(0).max(1).default(DEFAULT_CONFIDENCE.escalateBelow)
      .description('Confidence below which a decision should go to a human.'),
  }).description('Confidence bands for the recommendation helper.'),
  guard: z.object({
    enabled: z.boolean().default(DEFAULT_GUARD.enabled)
      .description('Score every pending tool call and allow, escalate, or deny it.'),
    tools: z.array(z.string()).default([...DEFAULT_GUARD.tools])
      .description('Tool names inspected; an empty list inspects every tool.'),
    question: z.string().default(DEFAULT_GUARD.question)
      .description('Question Jev answers about one pending call.'),
    levels: z.array(z.string()).default([...DEFAULT_GUARD.levels])
      .description('Ordered risk levels, lowest first; 2 to 10 entries.'),
    denyAt: z.number().step(1).min(0).default(DEFAULT_GUARD.denyAt)
      .description('Risk score at or above which a call is denied.'),
    askAt: z.number().step(1).min(0).default(DEFAULT_GUARD.askAt)
      .description('Risk score at or above which a call needs approval.'),
    escalateOnLowConfidence: z.boolean().default(DEFAULT_GUARD.escalateOnLowConfidence)
      .description('Require approval when the answer falls below confidence.escalateBelow.'),
    onError: z.union(['allow', 'deny'] as const).default(DEFAULT_GUARD.onError)
      .description('Gate outcome when Jev itself fails; allow is fail-open.'),
  }).description('Pre-execute risk gate; disabled by default.'),
  review: z.object({
    enabled: z.boolean().default(DEFAULT_REVIEW.enabled)
      .description('Judge each finished tool result and block the ones that need correction.'),
    tools: z.array(z.string()).default([...DEFAULT_REVIEW.tools])
      .description('Tool names reviewed; an empty list reviews every tool.'),
    question: z.string().default(DEFAULT_REVIEW.question)
      .description('Question Jev answers about one finished call.'),
    blockAt: z.number().min(0).max(1).default(DEFAULT_REVIEW.blockAt)
      .description('Probability of "needs correction" at or above which the result is blocked.'),
    onError: z.union(['accept', 'block'] as const).default(DEFAULT_REVIEW.onError)
      .description('Outcome when Jev fails; accept passes the result through.'),
  }).description('Post-execute result review; disabled by default.'),
  routing: z.object({
    enabled: z.boolean().default(DEFAULT_ROUTING.enabled)
      .description('Score each request and route it to the model for that demand band.'),
    question: z.string().default(DEFAULT_ROUTING.question)
      .description('Question Jev answers about the pending request.'),
    levels: z.array(z.string()).default([...DEFAULT_ROUTING.levels])
      .description('Ordered demand levels, lowest first; 2 to 10 entries.'),
    models: z.array(z.string()).default([...DEFAULT_ROUTING.models])
      .description('Model id per level; an empty string keeps the requested model.'),
    onError: z.union(['keep', 'capable'] as const).default(DEFAULT_ROUTING.onError)
      .description('Routing used when Jev fails; keep leaves the request alone.'),
  }).description('Model routing; disabled by default.'),
  context: z.object({
    enabled: z.boolean().default(DEFAULT_CONTEXT.enabled)
      .description('Prune older messages Jev judges no longer relevant.'),
    triggerMessages: z.number().step(1).min(2).default(DEFAULT_CONTEXT.triggerMessages)
      .description('Message count that starts pruning.'),
    keepRecent: z.number().step(1).min(0).default(DEFAULT_CONTEXT.keepRecent)
      .description('Most recent messages never considered for dropping.'),
    dropBelow: z.number().min(0).max(1).default(DEFAULT_CONTEXT.dropBelow)
      .description('Relevance probability below which an older message is dropped.'),
    question: z.string().default(DEFAULT_CONTEXT.question)
      .description('Question Jev answers about each candidate message.'),
  }).description('Context pruning; disabled by default.'),
  intent: z.object({
    enabled: z.boolean().default(DEFAULT_INTENT.enabled)
      .description('Classify the latest user turn and admit one directive line for it.'),
    question: z.string().default(DEFAULT_INTENT.question)
      .description('Question Jev answers about the latest user turn.'),
    classes: z.array(z.string()).default([...DEFAULT_INTENT.classes])
      .description('Ordered intent classes; 2 to 255 entries.'),
    directives: z.dict(z.string()).default({ ...DEFAULT_INTENT.directives })
      .description('Directive admitted per class; a class with no entry admits nothing.'),
  }).description('Intent routing; disabled by default.'),
  telemetry: z.object({
    log: z.boolean().default(DEFAULT_TELEMETRY.log)
      .description('Emit one redacted structured record per recorded call.'),
    sampleRate: z.number().min(0).max(1).default(DEFAULT_TELEMETRY.sampleRate)
      .description('Fraction of calls recorded.'),
    errorRateAlert: z.number().min(0).max(1).default(DEFAULT_TELEMETRY.errorRateAlert)
      .description('Error rate at or above which health reports degraded.'),
    alertMinCalls: z.number().step(1).min(1).default(DEFAULT_TELEMETRY.alertMinCalls)
      .description('Calls required before the error-rate alert may fire.'),
  }).description('Telemetry, sampling, and alert thresholds.'),
  enableDecide: z.boolean().default(true).description('Register the jev_decide tool.'),
  enableEvaluate: z.boolean().default(true).description('Register the jev_evaluate tool.'),
})
