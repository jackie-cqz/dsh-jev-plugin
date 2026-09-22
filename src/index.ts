/** dsh-jev plugin entry: mounts the Jev service, its tools, and the Phase 4 hooks. @module dsh-jev */

import type { Context } from '@deepseek-ai/cordis'
import { resolveConfig, type Config as JevConfig, type ResolvedConfig } from './config.ts'
import { JevContext, type ContextMessage } from './context.ts'
import { JevGuard } from './guard.ts'
import { JevReview } from './review.ts'
import { JevRules } from './rules.ts'
import { JevRouter } from './routing.ts'
import { ConfigSchema } from './schema.ts'
import { JevService } from './service.ts'
import { renderStatus, type JevStatusInput } from './status.ts'
import { createDecideTool } from './tools/decide.ts'
import { sessionTelemetrySink, type SessionTelemetrySink } from './dsh-telemetry.ts'
import { JevTelemetry } from './telemetry.ts'
import { createEvaluateTool } from './tools/evaluate.ts'

/** Plugin name; the bundle patch inserts this row as `tool-jev`. */
export const name = 'tool-jev'

/** The tool registry this plugin contributes to; the service comes from this plugin. */
export const inject = ['tools']

/** Schemastery schema the DSH loader validates plugin configuration against. */
export const Config = ConfigSchema

/**
 * Mount the shared Jev service, register the enabled tools, and install every
 * enabled Phase 4 hook.
 *
 * The service is constructed directly rather than through `ctx.plugin`, which
 * defers registration: consumers need `ctx.jev` to be readable as soon as this
 * plugin finishes applying. The constructed value is deliberately discarded —
 * Cordis registers a per-context view, so only `ctx.jev` is the shared instance.
 * Every registration here is an effect and is disposed with this plugin.
 *
 * Every hook is off by default, delegates through `next()`, and never throws: a
 * listener that throws or short-circuits would break the agent loop.
 *
 * `intent` is deliberately not installed. Its decision layer is complete and
 * tested, but the only seam that admits messages (`agent/pre-step`) takes
 * `UserMessage[]` and a user message must carry a user source, so injecting a
 * plugin-authored directive there would record it as something the user said.
 * A plugin-sourced pre-step message is the missing piece, not more Jev work.
 * @param ctx - context providing `ctx.tools`.
 * @param config - deployment configuration validated against {@link Config}.
 */
export function apply(ctx: Context, config: JevConfig): void {
  const resolved = resolveConfig(config)
  const telemetry = createTelemetry(ctx, resolved)
  new JevService(ctx, config, { telemetry })
  const jev = ctx.jev

  if (resolved.enableDecide) ctx.tools.register(createDecideTool(jev))
  if (resolved.enableEvaluate) ctx.tools.register(createEvaluateTool(jev))

  // Rules first: a command the offline layer already refuses must not cost a
  // model round trip on its way to that same refusal.
  const rules = installRules(ctx, resolved)
  const guard = installGuard(ctx, resolved, jev)
  installReview(ctx, resolved, jev)
  installRouting(ctx, resolved, jev)
  installContextPruning(ctx, resolved, jev)
  installStatusCommand(ctx, { config, resolved, jev, telemetry, guard, rules })
}

/**
 * Build the observability sink for this context.
 *
 * `ctx.sessionTelemetry` is optional: a profile that mounts no telemetry backend
 * simply has no such service, and the plugin must load anyway. Records are then
 * still counted by {@link JevTelemetry} but written nowhere, which is why the
 * lookup is a guarded read rather than an `inject` entry.
 *
 * The property is read structurally instead of importing
 * `@deepseek-ai/dsh-session-telemetry`, so this package keeps no DSH dependency
 * beyond the two peers it already declares.
 * @param ctx - mounted context.
 * @param resolved - resolved plugin configuration.
 * @returns the telemetry recorder, inert until `telemetry.log` is enabled.
 */
function createTelemetry(ctx: Context, resolved: ResolvedConfig): JevTelemetry {
  // `ctx.get` is the non-throwing lookup: reading `ctx.sessionTelemetry` directly
  // is rejected unless the name is declared in `inject`, and declaring it would
  // make the plugin wait for a backend the profile may not mount at all.
  const target = ctx.get('sessionTelemetry') as SessionTelemetrySink | undefined
  return new JevTelemetry({
    config: resolved.telemetry,
    ...target === undefined ? {} : { sink: sessionTelemetrySink(target, Date.now) },
  })
}

/**
 * Install the pre-execute risk gate.
 * @param ctx - mounted context.
 * @param resolved - resolved plugin configuration.
 * @param jev - the shared service.
 */
function installGuard(ctx: Context, resolved: ResolvedConfig, jev: JevService): JevGuard | undefined {
  if (!resolved.guard.enabled) return undefined
  const guard = new JevGuard({ service: jev, config: resolved.guard, bands: resolved.confidence })
  ctx.on('tools/pre-execute', async (exec, next) => {
    const decision = await guard.decide({
      name: exec.name,
      arguments: exec.arguments,
      signal: exec.signal,
    })
    if (decision.kind === 'allow') return next()
    // The host has no revise state, so a revise becomes a denial whose reason
    // carries the rewrite guidance. That is the same outcome for the model — it
    // reads the reason and retries with a better call — while `ask` stays `ask`
    // so a mounted approval service can still decide.
    if (decision.kind === 'revise') return { kind: 'deny', reason: decision.reason }
    return decision
  })
  return guard
}

/**
 * Install the post-execute result review.
 * @param ctx - mounted context.
 * @param resolved - resolved plugin configuration.
 * @param jev - the shared service.
 */
function installReview(ctx: Context, resolved: ResolvedConfig, jev: JevService): void {
  if (!resolved.review.enabled) return
  const review = new JevReview({ service: jev, config: resolved.review })
  ctx.on('tools/post-execute', async (exec, result, next) => {
    const decision = await review.decide({
      name: exec.name,
      arguments: exec.arguments,
      result,
      signal: exec.signal,
    })
    if (decision.kind === 'accept') return next()
    return { kind: 'block', feedback: [{ type: 'text', text: decision.feedback }] }
  })
}

/**
 * Install model routing on the request waterfall.
 *
 * `next()` yields the configuration the rest of the chain settled on, and only
 * the model is replaced, so the provider and every other field stay the chain's.
 * The scored state names the requested model and the position, not the message
 * text: a request carries the whole conversation, and sending it would be both
 * large and far more sensitive than a routing decision needs.
 * @param ctx - mounted context.
 * @param resolved - resolved plugin configuration.
 * @param jev - the shared service.
 */
function installRouting(ctx: Context, resolved: ResolvedConfig, jev: JevService): void {
  if (!resolved.routing.enabled) return
  const router = new JevRouter({ service: jev, config: resolved.routing })
  ctx.on('agent/request', async ({ turn, step, signal }, next) => {
    const config = await next()
    const decision = await router.decide({
      model: config.model,
      state: { model: config.model, turn, step },
      signal,
    })
    return decision.kind === 'route' && decision.model !== config.model
      ? { ...config, model: decision.model }
      : config
  })
}

/**
 * Install context pruning on the step waterfall.
 *
 * The plan is computed against the message list this listener received, so it is
 * applied only when the chain admitted that same list; otherwise the plan's
 * indices would address different messages and the pruning is dropped.
 * @param ctx - mounted context.
 * @param resolved - resolved plugin configuration.
 * @param jev - the shared service.
 */
function installContextPruning(ctx: Context, resolved: ResolvedConfig, jev: JevService): void {
  if (!resolved.context.enabled) return
  const pruning = new JevContext({ service: jev, config: resolved.context })
  ctx.on('agent/pre-step', async ({ messages, signal }, next) => {
    const decision = await next()
    if (decision.kind !== 'enter' || decision.messages.length !== messages.length) return decision
    const plan = await pruning.plan(toContextMessages(decision.messages), signal)
    // `shadow` reports what a pass would drop; applying it is what shadow mode
    // exists to avoid, so the admitted list is returned untouched.
    if (plan.kind !== 'prune') return decision
    const drop = new Set(plan.drop)
    return { kind: 'enter', messages: decision.messages.filter((_, index) => !drop.has(index)) }
  })
}

/**
 * Project admitted messages onto the text the pruning hook judges.
 * @param messages - messages the step is about to send.
 * @returns one text-only entry per message.
 */
function toContextMessages(messages: readonly unknown[]): ContextMessage[] {
  return messages.map((message) => {
    const record = message as { role?: unknown; content?: unknown }
    const role = typeof record.role === 'string' ? record.role : ''
    const text = Array.isArray(record.content)
      ? record.content
        .map(block => (block as { type?: unknown; text?: unknown }).type === 'text'
          ? String((block as { text?: unknown }).text ?? '')
          : '')
        .filter(part => part !== '')
        .join(' ')
      : ''
    return { role, text }
  })

}

/**
 * Install the deterministic offline rule layer.
 *
 * A `ToolGuard` is synchronous and returns a refusal reason, so this layer costs
 * no request and no clock time; it keeps refusing known-destructive commands
 * when the model backend is unreachable or out of quota. No guard can force-allow
 * a call another guard denied, so this layer cannot be overridden from above.
 * @param ctx - mounted context.
 * @param resolved - resolved plugin configuration.
 * @returns the rule layer, or `undefined` when the layer is disabled.
 */
function installRules(ctx: Context, resolved: ResolvedConfig): JevRules | undefined {
  if (!resolved.rules.enabled) return undefined
  const rules = new JevRules({ config: resolved.rules })
  // On the waterfall rather than as a dispatch guard, because the semantic gate
  // is also a waterfall listener and dispatch guards run after every listener:
  // registering here is what lets a deterministic refusal short-circuit the
  // paid check. The refusal is binding either way — only `ask` reaches approval.
  ctx.on('tools/pre-execute', async (exec, next) => {
    const denial = rules.inspect({ name: exec.name, arguments: exec.arguments })
    return denial === undefined ? next() : { kind: 'deny', reason: denial }
  })
  return rules
}

/**
 * The slice of the command registry this plugin needs.
 *
 * Declared structurally, like the telemetry sink, so the package keeps no DSH
 * dependency beyond its two peers.
 */
interface CommandRegistry {
  register(definition: {
    name: string
    description: string
    handler: () => { kind: 'success'; text: string }
  }): () => void
}

/** Everything the status command reports, gathered from the live instances. */
interface StatusSources {
  config: JevConfig
  resolved: ResolvedConfig
  jev: JevService
  telemetry: JevTelemetry
  guard: JevGuard | undefined
  rules: JevRules | undefined
}

/**
 * Register `/jev-status`.
 *
 * The command exists to expose **why nothing happened**: every failure path in
 * this plugin is deliberately quiet, so the counters and the key's origin are
 * the only place a silent skip becomes visible. A profile without the command
 * registry simply gets no command.
 * @param ctx - mounted context.
 * @param sources - live instances and configuration to report from.
 */
function installStatusCommand(ctx: Context, sources: StatusSources): void {
  // `inject` rather than a one-shot lookup: a profile may mount the command
  // registry after this plugin, and a lookup that runs once at apply time would
  // then never register the command. `inject` re-runs its callback when the
  // service appears.
  ctx.inject(['commands'], (scoped) => {
    const commands = (scoped as unknown as { commands: CommandRegistry }).commands
    commands.register({
      name: 'jev-status',
      description: 'Report the Jev plugin\'s switches, thresholds, counters, and health.',
      handler: () => ({ kind: 'success', text: renderStatus(buildStatusInput(sources)) }),
    })
  })
}

/**
 * Project the live instances onto the report's plain-data input.
 * @param sources - live instances and configuration.
 * @returns the status report input.
 */
function buildStatusInput(sources: StatusSources): JevStatusInput {
  const { config, resolved, jev, telemetry, guard, rules } = sources
  const guardStats = guard?.stats()
  const ruleStats = rules?.stats()
  const telemetryStats = telemetry.stats()
  const service = jev.stats()
  const health = jev.health()
  // A blank configured key counts as absent, matching how the key is resolved.
  const configuredKey = config.apiKey !== undefined && config.apiKey !== ''
  return {
    model: resolved.model,
    baseURL: resolved.baseURL,
    apiKeySource: configuredKey ? 'config' : resolved.apiKey === undefined ? 'missing' : 'environment',
    tools: { decide: resolved.enableDecide, evaluate: resolved.enableEvaluate },
    guard: {
      enabled: resolved.guard.enabled,
      inspected: guardStats?.inspected ?? 0,
      allowed: guardStats?.allowed ?? 0,
      asked: guardStats?.asked ?? 0,
      denied: guardStats?.denied ?? 0,
      errors: guardStats?.errors ?? 0,
    },
    rules: {
      enabled: resolved.rules.enabled,
      inspected: ruleStats?.inspected ?? 0,
      denied: ruleStats?.denied ?? 0,
    },
    telemetry: {
      enabled: resolved.telemetry.log,
      offered: telemetryStats.offered,
      emitted: telemetryStats.emitted,
      sampled: telemetryStats.sampled,
      sinkErrors: telemetryStats.sinkErrors,
    },
    service: {
      calls: service.calls,
      failures: service.failures,
      retries: service.retries,
      inputTokens: service.tokens.input,
      outputTokens: service.tokens.output,
      models: service.models,
    },
    health: { status: health.status, reasons: health.reasons },
  }
}
