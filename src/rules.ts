/** Deterministic offline refusal rules for pending tool calls. @module dsh-jev/rules */

import type { ResolvedRulesConfig } from './config.ts'

/** The part of a pending call the rules read. */
export interface RuleCall {
  /** Tool name, matched against the configured scope. */
  name: string
  /** Arguments the model produced. */
  arguments: unknown
}

/** What the rule layer has observed since it was constructed. */
export interface JevRulesStats {
  /** In-scope calls the rules examined. */
  inspected: number
  /** Calls refused by a built-in or configured pattern. */
  denied: number
}

/** One rule: an identity, the pattern to match, and what to suggest instead. */
interface Rule {
  /** Stable id quoted in the refusal reason; never derived from the call. */
  id: string
  /** Case-insensitive pattern tested against the serialized arguments. */
  pattern: RegExp
  /** Rewrite guidance appended to the reason. */
  advice: string
}

/**
 * Built-in rules, each matching an operation that is hard or impossible to undo.
 *
 * Every pattern is deliberately narrow. One that also matched ordinary work would
 * refuse legitimate calls and train the model to route around the layer, which is
 * worse than not having it. This is a **safety net, not a security boundary**: it
 * does not model filesystem state, does not interpret shell quoting, and a caller
 * determined to evade it can.
 */
const BUILT_IN: readonly Rule[] = [
  {
    // A recursive force delete whose target is a root, not a path inside one.
    id: 'recursive-root-delete',
    pattern: /\brm\s+(?:-[a-z]*r[a-z]*f|-[a-z]*f[a-z]*r)\s+(?:~|\/\*|\/)(?=[\s"']|$)/i,
    advice: 'Name the specific paths to delete, and confirm they resolve where you expect.',
  },
  {
    id: 'disk-overwrite',
    pattern: /\bdd\b[^\n]{0,80}?\bof=\/dev\//i,
    advice: 'Write to a regular file, and verify the device path before touching it.',
  },
  {
    id: 'filesystem-format',
    pattern: /\bmkfs(?:\.\w+)?\b/i,
    advice: 'Formatting destroys the existing filesystem; confirm the device with the user first.',
  },
  {
    id: 'force-push',
    pattern: /\bgit\s+push\b[^\n]{0,80}?(?:--force(?!-)|(?:^|\s)-f(?:\s|$))/i,
    advice: 'Push to a new branch, or use --force-with-lease on a branch you own after fetching.',
  },
  {
    id: 'sql-destructive',
    pattern: /\bdrop\s+(?:table|database|schema|index|view)\b|\btruncate\s+table\b/i,
    advice: 'Back up first and run the statement against a copy, or ask the user to run it.',
  },
  {
    id: 'world-writable-root',
    pattern: /chmod\s+(?:-R\s+)?(?:777|a\+rwx)\s+\/(?=[\s"']|$)/i,
    advice: 'Grant the narrowest permission the task needs, on the specific path involved.',
  },
  {
    id: 'fork-bomb',
    pattern: /:\s*\(\s*\)\s*\{.*\|.*&.*\}\s*;\s*:/,
    advice: 'This is unrecoverable on the host; use a bounded process count instead.',
  },
  {
    // A power command in command position only: the word may appear in prose.
    id: 'host-power',
    pattern: /(?:"|[;&|]\s*|\bsudo\s+)(?:shutdown|reboot|halt|poweroff)\b/i,
    advice: 'Ask the user to power the host, and explain what needs restarting.',
  },
]

/**
 * Refuse calls that match a built-in or a deployment-supplied pattern.
 *
 * Runs synchronously and never touches the network. This is the layer that still
 * refuses known-destructive calls when the API key is missing, the quota is
 * exhausted, or the model backend is unreachable — cases where a semantic check
 * cannot run at all.
 */
export class JevRules {
  private readonly config: ResolvedRulesConfig
  /** Built-ins plus the deployment's patterns, all compiled once at construction. */
  private readonly rules: readonly Rule[]
  private inspected = 0
  private denied = 0

  /**
   * @param options - resolved rule configuration.
   */
  constructor(options: { config: ResolvedRulesConfig }) {
    this.config = options.config
    this.rules = [
      ...BUILT_IN,
      ...options.config.deny.map((pattern, index) => ({
        id: `configured pattern ${String(index + 1)}`,
        pattern: new RegExp(pattern, 'i'),
        advice: 'This call matches a pattern the deployment refuses; revise it or ask the user.',
      })),
    ]
  }

  /**
   * Judge one pending call.
   * @param call - tool name and the arguments the model produced.
   * @returns a refusal naming the matched rule, or `undefined` to allow.
   * @throws Never: a rule layer that throws would break the agent loop.
   */
  inspect(call: RuleCall): string | undefined {
    if (!this.config.enabled) return undefined
    if (this.config.tools.length > 0 && !this.config.tools.includes(call.name)) return undefined

    this.inspected += 1
    const text = serialize(call.arguments)
    // A value that cannot be serialized is not something these rules can judge.
    const matched = text === undefined ? undefined : this.rules.find(rule => rule.pattern.test(text))
    if (matched === undefined) return undefined

    this.denied += 1
    // The reason names the rule and never the matched text: arguments can carry
    // credentials, and a refusal is model-visible and durable.
    return `Refused by the offline rule layer: rule "${matched.id}" matches this call, which is `
      + `hard to undo. ${matched.advice}`
  }

  /**
   * Read the counters.
   * @returns a snapshot; later calls do not mutate it.
   */
  stats(): Readonly<JevRulesStats> {
    return { inspected: this.inspected, denied: this.denied }
  }
}

/**
 * Serialize arguments so a rule can match a value nested anywhere inside them.
 * @param value - arguments the model produced.
 * @returns the JSON text, or `undefined` when there is nothing to match against.
 */
function serialize(value: unknown): string | undefined {
  try {
    const text = JSON.stringify(value)
    return typeof text === 'string' ? text : undefined
  } catch {
    // A cyclic value is excluded by the static type but reachable at runtime; the
    // rules cannot judge it, so it passes rather than failing the call.
    return undefined
  }
}
