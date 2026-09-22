import { describe, expect, it } from 'vitest'

import {
  DEFAULT_API_KEY_ENV,
  DEFAULT_BASE_URL,
  DEFAULT_MODEL,
  DEFAULT_RETRY,
  DEFAULT_TIMEOUT_MS,
  resolveConfig,
  type Config,
} from '../src/config.ts'
import { ConfigSchema } from '../src/schema.ts'

/** Validate unvalidated input the way the DSH loader hands configuration to the schema. */
function parseConfig(input: unknown): Config {
  return ConfigSchema(input as Config)
}

describe('ConfigSchema defaults', () => {
  it('fills every default for an empty configuration', () => {
    const parsed = parseConfig({})

    expect(parsed.apiKeyEnv).toBe(DEFAULT_API_KEY_ENV)
    expect(parsed.baseURL).toBe(DEFAULT_BASE_URL)
    expect(parsed.model).toBe(DEFAULT_MODEL)
    expect(parsed.timeoutMs).toBe(DEFAULT_TIMEOUT_MS)
    expect(parsed.retry).toEqual(DEFAULT_RETRY)
  })

  it('omits apiKey when it is not supplied', () => {
    expect(parseConfig({})).not.toHaveProperty('apiKey')
  })

  it('fills sibling retry fields for a partial retry override', () => {
    expect(parseConfig({ retry: { maxAttempts: 5 } }).retry).toEqual({
      maxAttempts: 5,
      baseDelayMs: DEFAULT_RETRY.baseDelayMs,
      maxDelayMs: DEFAULT_RETRY.maxDelayMs,
    })
  })

  it('agrees with the resolveConfig defaults', () => {
    expect(resolveConfig(parseConfig({}), {})).toEqual(resolveConfig({}, {}))
  })
})

describe('ConfigSchema acceptance', () => {
  it('passes a complete configuration through unchanged', () => {
    const full: Config = {
      apiKey: 'key',
      apiKeyEnv: 'MY_KEY',
      baseURL: 'https://x/v1',
      model: 'jev-1.13.0',
      timeoutMs: 250,
      retry: { maxAttempts: 2, baseDelayMs: 10, maxDelayMs: 20 },
      policy: { enabled: true, failureThreshold: 3, openMs: 1_000, minIntervalMs: 50 },
      cache: { enabled: true, maxEntries: 10, ttlMs: 5_000 },
      maxStateChars: 1_000,
      confidence: { approveAt: 0.9, escalateBelow: 0.4 },
      guard: {
        enabled: true,
        tools: ['bash'],
        question: 'How risky is this call?',
        levels: ['low', 'high'],
        denyAt: 1,
        askAt: 0,
        escalateOnLowConfidence: false,
        onError: 'deny',
      },
      enableDecide: false,
      enableEvaluate: true,
      review: { enabled: true, tools: ['bash'], question: 'Did it work?', blockAt: 0.7, onError: 'block' },
      routing: { enabled: true, question: 'How hard?', levels: ['low', 'high'], models: ['', 'big-model'], onError: 'capable' },
      context: { enabled: true, triggerMessages: 20, keepRecent: 5, dropBelow: 0.4, question: 'Still needed?' },
      intent: { enabled: true, question: 'What now?', classes: ['question', 'change'], directives: { change: 'Edit the files.' } },
      telemetry: { log: true, sampleRate: 0.5, errorRateAlert: 0.25, alertMinCalls: 3 },
    }

    expect(parseConfig(full)).toEqual(full)
  })

  it('accepts a secret-role apiKey', () => {
    expect(parseConfig({ apiKey: 'key' }).apiKey).toBe('key')
  })

  // Object schemas are loose: unknown keys reach the resolved configuration instead of failing.
  it('passes unrecognized keys through', () => {
    expect(parseConfig({ typo: true })).toMatchObject({ typo: true })
  })
})

describe('ConfigSchema rejection', () => {
  const REJECTED: ReadonlyArray<readonly [label: string, input: unknown, message: RegExp]> = [
    ['a string timeoutMs', { timeoutMs: 'soon' }, /timeoutMs/],
    ['a string maxAttempts', { retry: { maxAttempts: '3' } }, /retry\.maxAttempts/],
    ['a numeric model', { model: 7 }, /model/],
    ['a numeric baseURL', { baseURL: 7 }, /baseURL/],
    ['a timeoutMs below the minimum', { timeoutMs: 0 }, /timeoutMs/],
    ['a maxAttempts below the minimum', { retry: { maxAttempts: 0 } }, /retry\.maxAttempts/],
    ['a fractional maxAttempts', { retry: { maxAttempts: 1.5 } }, /retry\.maxAttempts/],
    ['a negative baseDelayMs', { retry: { baseDelayMs: -1 } }, /retry\.baseDelayMs/],
    ['a negative maxDelayMs', { retry: { maxDelayMs: -1 } }, /retry\.maxDelayMs/],
  ]

  for (const [label, input, message] of REJECTED) {
    it(`rejects ${label}`, () => {
      expect(() => parseConfig(input)).toThrow(message)
    })
  }

  it('raises a TypeError subclass', () => {
    expect(() => parseConfig({ model: 7 })).toThrow(TypeError)
  })
})

describe('ConfigSchema and resolveConfig integration', () => {
  it('feeds resolveConfig a schema-defaulted configuration', () => {
    const resolved = resolveConfig(parseConfig({ baseURL: 'https://x/v1/' }), {})

    expect(resolved.baseURL).toBe('https://x/v1')
    expect(resolved.model).toBe(DEFAULT_MODEL)
    expect(resolved.timeoutMs).toBe(DEFAULT_TIMEOUT_MS)
    expect(resolved.retry).toEqual(DEFAULT_RETRY)
  })
})
