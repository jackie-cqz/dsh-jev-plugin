import { describe, expect, it } from 'vitest'

import {
  DEFAULT_API_KEY_ENV,
  DEFAULT_BASE_URL,
  DEFAULT_MODEL,
  DEFAULT_RETRY,
  DEFAULT_TIMEOUT_MS,
  resolveApiKey,
  resolveConfig,
  type Config,
} from '../src/config.ts'
import { JevConfigError } from '../src/errors.ts'

describe('documented defaults', () => {
  it('exports the defaults the SPEC fixes', () => {
    expect(DEFAULT_API_KEY_ENV).toBe('TYPESAFE_API_KEY')
    expect(DEFAULT_BASE_URL).toBe('https://api.typesafe.ai/v1')
    expect(DEFAULT_MODEL).toBe('jev-latest')
    expect(DEFAULT_TIMEOUT_MS).toBe(10_000)
    expect(DEFAULT_RETRY).toEqual({ maxAttempts: 3, baseDelayMs: 500, maxDelayMs: 5_000 })
  })
})

describe('resolveConfig defaults', () => {
  it('applies every default to an empty configuration', () => {
    const resolved = resolveConfig({}, {})

    expect(resolved.apiKey).toBeUndefined()
    expect(resolved.apiKeyEnv).toBe(DEFAULT_API_KEY_ENV)
    expect(resolved.baseURL).toBe(DEFAULT_BASE_URL)
    expect(resolved.model).toBe(DEFAULT_MODEL)
    expect(resolved.timeoutMs).toBe(DEFAULT_TIMEOUT_MS)
    expect(resolved.retry).toEqual(DEFAULT_RETRY)
  })

  it('keeps the remaining retry defaults for a partial override', () => {
    expect(resolveConfig({ retry: { maxAttempts: 5 } }, {}).retry).toEqual({
      maxAttempts: 5,
      baseDelayMs: DEFAULT_RETRY.baseDelayMs,
      maxDelayMs: DEFAULT_RETRY.maxDelayMs,
    })
  })

  it('keeps every retry default for an empty retry object', () => {
    expect(resolveConfig({ retry: {} }, {}).retry).toEqual(DEFAULT_RETRY)
  })

  it('accepts an explicit zero-delay retry policy', () => {
    expect(resolveConfig({ retry: { baseDelayMs: 0, maxDelayMs: 0 } }, {}).retry).toEqual({
      maxAttempts: DEFAULT_RETRY.maxAttempts,
      baseDelayMs: 0,
      maxDelayMs: 0,
    })
  })
})

describe('api key resolution', () => {
  it('prefers config.apiKey over the environment', () => {
    const resolved = resolveConfig({ apiKey: 'config-key', apiKeyEnv: 'MY_KEY' }, { MY_KEY: 'env-key' })

    expect(resolved.apiKey).toBe('config-key')
    expect(resolveApiKey(resolved)).toBe('config-key')
  })

  it('falls back to the environment variable named by apiKeyEnv', () => {
    expect(resolveConfig({ apiKeyEnv: 'MY_KEY' }, { MY_KEY: 'env-key' }).apiKey).toBe('env-key')
  })

  it('reads the default environment variable when apiKeyEnv is omitted', () => {
    expect(resolveConfig({}, { [DEFAULT_API_KEY_ENV]: 'env-key' }).apiKey).toBe('env-key')
  })

  it('treats an empty environment value as absent', () => {
    expect(resolveConfig({}, { [DEFAULT_API_KEY_ENV]: '' }).apiKey).toBeUndefined()
  })

  it('treats an empty configured apiKey as absent', () => {
    expect(resolveConfig({ apiKey: '' }, {}).apiKey).toBeUndefined()
  })

  it('falls back to the environment when the configured apiKey is an empty string', () => {
    const resolved = resolveConfig({ apiKey: '' }, { [DEFAULT_API_KEY_ENV]: 'env-key' })

    expect(resolved.apiKey).toBe('env-key')
  })

  it('names the environment variable when no key is available', () => {
    expect(() => resolveApiKey(resolveConfig({ apiKeyEnv: 'CUSTOM_KEY' }, {}))).toThrow(JevConfigError)
    expect(() => resolveApiKey(resolveConfig({ apiKeyEnv: 'CUSTOM_KEY' }, {}))).toThrow(/CUSTOM_KEY/)
  })

  it('names both configuration sources when no key is available', () => {
    expect(() => resolveApiKey(resolveConfig({}, {}))).toThrow(/apiKey/)
  })

  it('never echoes the environment value into the error message', () => {
    const resolved = resolveConfig({ apiKeyEnv: 'ABSENT_JEV_KEY' }, { TYPESAFE_API_KEY: 'super-secret-value' })

    let caught: unknown
    try {
      resolveApiKey(resolved)
    } catch (error) {
      caught = error
    }

    expect(caught).toBeInstanceOf(JevConfigError)
    const message = (caught as JevConfigError).message
    expect(message).toContain('ABSENT_JEV_KEY')
    expect(message).not.toContain('super-secret-value')
  })
})

describe('baseURL normalization', () => {
  it('strips every trailing slash', () => {
    expect(resolveConfig({ baseURL: 'https://x/v1///' }, {}).baseURL).toBe('https://x/v1')
    expect(resolveConfig({ baseURL: 'https://x/v1/' }, {}).baseURL).toBe('https://x/v1')
  })

  it('leaves a URL without a trailing slash untouched', () => {
    expect(resolveConfig({ baseURL: 'https://x/v1' }, {}).baseURL).toBe('https://x/v1')
  })
})

describe('resolveConfig validation', () => {
  const INVALID: ReadonlyArray<readonly [label: string, config: Config]> = [
    ['a timeoutMs of zero', { timeoutMs: 0 }],
    ['a negative timeoutMs', { timeoutMs: -1 }],
    ['a NaN timeoutMs', { timeoutMs: Number.NaN }],
    ['an infinite timeoutMs', { timeoutMs: Number.POSITIVE_INFINITY }],
    ['a maxAttempts of zero', { retry: { maxAttempts: 0 } }],
    ['a negative maxAttempts', { retry: { maxAttempts: -1 } }],
    ['an infinite maxAttempts', { retry: { maxAttempts: Number.POSITIVE_INFINITY } }],
    ['a negative baseDelayMs', { retry: { baseDelayMs: -1 } }],
    ['a NaN baseDelayMs', { retry: { baseDelayMs: Number.NaN } }],
    ['a negative maxDelayMs', { retry: { maxDelayMs: -1 } }],
    ['a NaN maxDelayMs', { retry: { maxDelayMs: Number.NaN } }],
    ['a blank model', { model: '  ' }],
    ['a blank baseURL', { baseURL: '' }],
    ['a whitespace baseURL', { baseURL: '   ' }],
    ['a blank apiKeyEnv', { apiKeyEnv: '' }],
  ]

  for (const [label, config] of INVALID) {
    it(`rejects ${label}`, () => {
      expect(() => resolveConfig(config, {})).toThrow(JevConfigError)
    })
  }

  it('names the offending field in the error message', () => {
    expect(() => resolveConfig({ timeoutMs: 0 }, {})).toThrow(/timeoutMs/)
    expect(() => resolveConfig({ retry: { baseDelayMs: -1 } }, {})).toThrow(/retry\.baseDelayMs/)
    expect(() => resolveConfig({ retry: { maxAttempts: 0 } }, {})).toThrow(/retry\.maxAttempts/)
    expect(() => resolveConfig({ model: '  ' }, {})).toThrow(/model/)
    expect(() => resolveConfig({ baseURL: '' }, {})).toThrow(/baseURL/)
    expect(() => resolveConfig({ apiKeyEnv: '' }, {})).toThrow(/apiKeyEnv/)
  })
})
