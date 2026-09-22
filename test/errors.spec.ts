/** Error taxonomy: stable codes, names, retryability, and message shaping. @module dsh-jev/test/errors */

import { describe, expect, it } from 'vitest'

import {
  JevConfigError,
  JevError,
  JevHttpError,
  JevNetworkError,
  JevProtocolError,
  JevQuotaError,
  JevTimeoutError,
  JevValidationError,
} from '../src/errors.ts'
import { isRetryable } from '../src/retry.ts'

describe('stable codes and names', () => {
  const CASES: ReadonlyArray<
    readonly [label: string, build: () => JevError, code: string, name: string, message: string]
  > = [
    ['configuration', () => new JevConfigError('m'), 'JEV_CONFIG', 'JevConfigError', 'm'],
    ['validation', () => new JevValidationError('m'), 'JEV_VALIDATION', 'JevValidationError', 'm'],
    ['network', () => new JevNetworkError('m'), 'JEV_NETWORK', 'JevNetworkError', 'm'],
    ['timeout', () => new JevTimeoutError('m'), 'JEV_TIMEOUT', 'JevTimeoutError', 'm'],
    ['HTTP', () => new JevHttpError(400, 'm'), 'JEV_HTTP', 'JevHttpError', 'Jev API error (400): m'],
    ['protocol', () => new JevProtocolError('m'), 'JEV_PROTOCOL', 'JevProtocolError', 'm'],
  ]

  for (const [label, build, code, name, message] of CASES) {
    it(`exposes the ${label} code and name`, () => {
      const error = build()

      expect(error).toBeInstanceOf(JevError)
      expect(error.code).toBe(code)
      expect(error.name).toBe(name)
      expect(error.message).toBe(message)
    })
  }
})

describe('retryability', () => {
  it('never retries a spent timeout budget', () => {
    expect(isRetryable(new JevTimeoutError('Jev request timed out after 10 ms.'))).toBe(false)
  })

  const RETRYABLE = [429, 500, 502, 503, 504, 529]
  const IMMEDIATE = [400, 401, 403, 404, 422]

  for (const status of RETRYABLE) {
    it(`marks ${status} retryable`, () => {
      expect(new JevHttpError(status, 'x').retryable).toBe(true)
      expect(isRetryable(new JevHttpError(status, 'x'))).toBe(true)
    })
  }

  for (const status of IMMEDIATE) {
    it(`marks ${status} immediate`, () => {
      expect(new JevHttpError(status, 'x').retryable).toBe(false)
      expect(isRetryable(new JevHttpError(status, 'x'))).toBe(false)
    })
  }
})

describe('JevHttpError message', () => {
  it('quotes the body after the status', () => {
    expect(new JevHttpError(400, '{"message":"Invalid request."}').message)
      .toBe('Jev API error (400): {"message":"Invalid request."}')
  })

  it.each(['', ' ', '\n\t'])('omits the detail segment for body %j', (body) => {
    expect(new JevHttpError(401, body).message).toBe('Jev API error (401)')
  })

  it('keeps fields independent of the message', () => {
    const error = new JevHttpError(429, 'slow down', 1_500)

    expect(error.status).toBe(429)
    expect(error.body).toBe('slow down')
    expect(error.retryAfterMs).toBe(1_500)
  })
})

describe('JevQuotaError', () => {
  it('carries a stable code and name', () => {
    const error = new JevQuotaError('quota exhausted')

    expect(error).toBeInstanceOf(JevError)
    expect(error.code).toBe('JEV_QUOTA')
    expect(error.name).toBe('JevQuotaError')
    expect(error.message).toBe('quota exhausted')
  })
})
