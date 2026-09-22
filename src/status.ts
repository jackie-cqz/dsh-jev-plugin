/**
 * Diagnostic report for `/jev-status`.
 *
 * The point of this module is not to show counters — `ctx.jev.stats()` already
 * exposes them — but to expose **why nothing happened**. A fail-open gate makes
 * every skip silent: the plugin loaded, no call was intercepted, and nowhere
 * else in the system says why. This renderer turns that silence into a list of
 * causes.
 * @module dsh-jev/status
 */

/** Everything the report needs; plain data, no service references. */
export interface JevStatusInput {
  /** Model id requests are sent with. */
  model: string
  /** Root address requests are submitted to. */
  baseURL: string
  /** Where the API key came from. */
  apiKeySource: 'config' | 'environment' | 'missing'
  /** Whether each model-visible tool is registered. */
  tools: { decide: boolean; evaluate: boolean }
  /** Semantic gate counters. */
  guard: {
    enabled: boolean
    inspected: number
    allowed: number
    asked: number
    denied: number
    errors: number
  }
  /** Offline rule layer counters. */
  rules: { enabled: boolean; inspected: number; denied: number }
  /** Telemetry counters. */
  telemetry: {
    enabled: boolean
    /** Records handed to `record()`. */
    offered: number
    emitted: number
    /** Records dropped by sampling. */
    sampled: number
    /** Records lost because the sink threw. */
    sinkErrors: number
  }
  /** Service counters. */
  service: {
    calls: number
    failures: number
    retries: number
    inputTokens: number
    outputTokens: number
    models: readonly string[]
  }
  /** Health verdict. */
  health: { status: string; reasons: readonly string[] }
}

/** Width every report row pads its label to; wider than the longest label. */
const LABEL_WIDTH = 26

/** Insert thousands separators without depending on the host locale. */
function grouped(value: number): string {
  const text = String(Math.trunc(value))
  const sign = text.startsWith('-') ? '-' : ''
  const digits = sign === '' ? text : text.slice(1)
  let out = ''
  for (let index = 0; index < digits.length; index += 1) {
    if (index > 0 && (digits.length - index) % 3 === 0) out += ','
    out += digits[index]
  }
  return sign + out
}

/** Render an on/off switch with the reason it is off, when that matters. */
function switchLine(label: string, enabled: boolean, offNote: string): string {
  return enabled ? `  ${label.padEnd(LABEL_WIDTH)}on` : `  ${label.padEnd(LABEL_WIDTH)}off   — ${offNote}`
}

/**
 * Explain the states that make a healthy-looking plugin do nothing.
 *
 * Every entry here exists because fail-open hides it: a disabled gate, an empty
 * scope, a sampled-away record, and a throwing sink all look identical from the
 * outside, which is "no output".
 * @param input - collected counters and configuration.
 * @returns one line per cause, in a stable order; empty when nothing is inert.
 */
function notes(input: JevStatusInput): string[] {
  const lines: string[] = []
  const { guard, rules, telemetry, service, apiKeySource } = input

  if (apiKeySource === 'missing') {
    lines.push('no API key: every semantic call fails before it reaches the endpoint')
  }
  if (!guard.enabled && !rules.enabled) {
    lines.push('no interception is active: tool calls run unchecked')
  }
  if (guard.enabled && guard.inspected === 0) {
    lines.push('the risk gate is on but inspected nothing: check its tool scope')
  }
  if (rules.enabled && rules.inspected === 0) {
    lines.push('the rule layer is on but inspected nothing: check its tool scope')
  }
  if (service.calls === 0 && (guard.inspected > 0 || rules.inspected > 0)) {
    lines.push('calls were inspected but none reached the transport: they were refused or skipped')
  }
  if (telemetry.enabled && telemetry.offered === 0) {
    lines.push('telemetry is on but recorded nothing: no call reached it yet')
  }
  if (telemetry.sampled > 0) {
    lines.push(`${grouped(telemetry.sampled)} record(s) were dropped by sampling and are not visible downstream`)
  }
  if (telemetry.sinkErrors > 0) {
    lines.push(`${grouped(telemetry.sinkErrors)} record(s) were lost because the sink threw`)
  }
  if (!input.tools.decide && !input.tools.evaluate) {
    lines.push('both tools are disabled: the model has no way to ask Jev anything')
  }
  if (service.failures > 0) {
    const rate = ((service.failures / service.calls) * 100).toFixed(1)
    lines.push(`${grouped(service.failures)} of ${grouped(service.calls)} call(s) failed (${rate}%)`)
  }
  return lines
}

/**
 * Render the diagnostic report.
 *
 * Pure and total: it reads no clock, touches no I/O, and returns a string for
 * every input the interface admits, so a slash command can always print
 * something. The output is byte-identical for identical input.
 * @param input - collected counters and configuration.
 * @returns the multi-line report.
 */
export function renderStatus(input: JevStatusInput): string {
  const { guard, rules, telemetry, service, health } = input
  const keySource = input.apiKeySource === 'missing'
    ? 'missing — set the apiKeyEnv variable or the apiKey field'
    : `from ${input.apiKeySource}`
  const models = service.models.length > 0 ? service.models.join(', ') : 'none recorded yet'
  const failureRate = service.calls > 0
    ? `${((service.failures / service.calls) * 100).toFixed(1)}%`
    : 'n/a'

  const lines: string[] = [
    'Jev status',
    '',
    'Switches',
    switchLine('jev_decide', input.tools.decide, 'the model cannot ask a single question'),
    switchLine('jev_evaluate', input.tools.evaluate, 'the model cannot send a question map'),
    switchLine('risk gate', guard.enabled, 'no pending call is scored'),
    switchLine('offline rules', rules.enabled, 'no call is checked without the API'),
    switchLine('telemetry', telemetry.enabled, 'counters still accrue; nothing is emitted'),
    '',
    'Configuration',
    `  ${'model'.padEnd(LABEL_WIDTH)}${input.model}`,
    `  ${'endpoint'.padEnd(LABEL_WIDTH)}${input.baseURL}`,
    `  ${'api key'.padEnd(LABEL_WIDTH)}${keySource}`,
    '',
    'Service',
    `  ${'calls'.padEnd(LABEL_WIDTH)}${grouped(service.calls)}`,
    `  ${'failures'.padEnd(LABEL_WIDTH)}${grouped(service.failures)}  (${failureRate} of calls)`,
    `  ${'retries'.padEnd(LABEL_WIDTH)}${grouped(service.retries)}`,
    `  ${'tokens'.padEnd(LABEL_WIDTH)}in ${grouped(service.inputTokens)} / out ${grouped(service.outputTokens)}`,
    `  ${'models seen'.padEnd(LABEL_WIDTH)}${models}`,
    '',
    'Risk gate',
    `  ${'inspected'.padEnd(LABEL_WIDTH)}${grouped(guard.inspected)}`,
    `  ${'allowed / asked / denied'.padEnd(LABEL_WIDTH)}${grouped(guard.allowed)} / ${grouped(guard.asked)} / ${grouped(guard.denied)}`,
    `  ${'errors'.padEnd(LABEL_WIDTH)}${grouped(guard.errors)}  (failed checks, decided by the onError policy)`,
    '',
    'Offline rules',
    `  ${'inspected'.padEnd(LABEL_WIDTH)}${grouped(rules.inspected)}`,
    `  ${'denied'.padEnd(LABEL_WIDTH)}${grouped(rules.denied)}`,
    '',
    'Telemetry',
    `  ${'offered'.padEnd(LABEL_WIDTH)}${grouped(telemetry.offered)}`,
    `  ${'emitted'.padEnd(LABEL_WIDTH)}${grouped(telemetry.emitted)}`,
    `  ${'sampled away'.padEnd(LABEL_WIDTH)}${grouped(telemetry.sampled)}`,
    `  ${'sink errors'.padEnd(LABEL_WIDTH)}${grouped(telemetry.sinkErrors)}`,
    '',
    'Health',
    `  ${'status'.padEnd(LABEL_WIDTH)}${health.status}`,
  ]

  for (const reason of health.reasons) lines.push(`  ${' '.repeat(LABEL_WIDTH)}${reason}`)

  const detected = notes(input)
  lines.push('', 'Notes')
  if (detected.length === 0) lines.push('  nothing inert: every enabled layer has seen work')
  else for (const note of detected) lines.push(`  - ${note}`)

  return lines.join('\n')
}
