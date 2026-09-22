/** Contract tests for the TypeSafe System One transport. @module dsh-jev/test/client */

import { describe, expect, it, vi } from 'vitest'
import { JevClient } from '../src/client.ts'
import type { Config, ResolvedConfig, RetryConfig } from '../src/config.ts'
import { resolveConfig } from '../src/config.ts'
import { JevConfigError, JevHttpError, JevNetworkError, JevProtocolError, JevQuotaError, JevTimeoutError } from '../src/errors.ts'
import type { JevQuestions } from '../src/protocol.ts'

const API_KEY = 'sk-jev-test-key-9f3c1d'
const ENV_SECRET = 'sk-env-secret-4a7b2e'
const BASE_URL = 'https://api.example.test/v1'

const QUESTIONS: JevQuestions = {
  decision: { type: 'noul', instructions: 'Is this urgent?' },
}

const RESPONSE_BODY = {
  model: 'jev-1.13.0',
  answers: { decision: { type: 'noul', noul: 0.93 } },
  usage: { input_tokens: 312, output_tokens: 20 },
}

/**
 * Build a policy whose backoff is zero, so retrying tests never wait.
 * Backoff timing itself is covered by `test/retry.spec.ts`.
 * @param maxAttempts - total attempts per call, including the first.
 * @returns retry overrides with immediate delays.
 */
function instantRetry(maxAttempts: number): RetryConfig {
  return { maxAttempts, baseDelayMs: 0, maxDelayMs: 0 }
}

/**
 * Resolve configuration for a client under test, isolated from `process.env`.
 * @param overrides - raw plugin configuration merged over the test defaults.
 * @returns resolved configuration carrying the test API key.
 */
function makeConfig(overrides: Config = {}): ResolvedConfig {
  return resolveConfig({ apiKey: API_KEY, baseURL: BASE_URL, ...overrides }, {})
}

/**
 * Wrap a payload as a JSON response.
 * @param payload - value serialized into the body.
 * @param status - HTTP status code.
 * @returns response carrying serialized `payload`.
 */
function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

/**
 * Build a bodyless-classified text response.
 * @param body - response body text.
 * @param status - HTTP status code.
 * @param headers - extra response headers, such as `Retry-After`.
 * @returns response carrying `body`.
 */
function textResponse(body: string, status: number, headers: Record<string, string> = {}): Response {
  return new Response(body, { status, headers })
}

/**
 * Await a call and capture how it settled.
 * @param promise - call under test.
 * @returns the rejection reason, or `undefined` when the call resolved.
 */
async function rejection(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => undefined,
    (error: unknown) => error,
  )
}

/**
 * Build a fetch stand-in that never settles until its request signal aborts,
 * matching a server that accepts the connection and then stalls.
 * @param onCall - hook invoked once the abort listener is attached.
 * @returns fetch implementation rejecting with the request signal's reason.
 */
function stallUntilAborted(onCall?: () => void): typeof globalThis.fetch {
  return (_input, init) => new Promise<Response>((_resolve, reject) => {
    const requestSignal = init?.signal
    if (requestSignal === undefined || requestSignal === null) {
      reject(new Error('expected the client to pass a request signal'))
      return
    }
    requestSignal.addEventListener('abort', () => {
      reject(requestSignal.reason)
    }, { once: true })
    onCall?.()
  })
}

describe('callSystemOne request', () => {
  it('POSTs to /systemone with bearer auth and the configured model', async () => {
    const fetchMock = vi.fn<typeof globalThis.fetch>(async () => jsonResponse(RESPONSE_BODY))
    const client = new JevClient(makeConfig(), { fetch: fetchMock })

    const result = await client.callSystemOne({ state: 'payouts failing', questions: QUESTIONS })

    expect(result).toEqual(RESPONSE_BODY)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0]!
    expect(url).toBe(`${BASE_URL}/systemone`)
    expect(init?.method).toBe('POST')
    const headers = new Headers(init?.headers)
    expect(headers.get('authorization')).toBe(`Bearer ${API_KEY}`)
    expect(headers.get('content-type')).toBe('application/json')
    expect(JSON.parse(String(init?.body))).toEqual({
      model: 'jev-latest',
      state: 'payouts failing',
      questions: QUESTIONS,
    })
  })

  it('lets the call override the configured model', async () => {
    const fetchMock = vi.fn<typeof globalThis.fetch>(async () => jsonResponse(RESPONSE_BODY))
    const client = new JevClient(makeConfig(), { fetch: fetchMock })

    await client.callSystemOne({ state: 'x', questions: QUESTIONS, model: 'jev-1.13.0' })

    const [, init] = fetchMock.mock.calls[0]!
    expect(JSON.parse(String(init?.body))).toMatchObject({ model: 'jev-1.13.0' })
  })

  it('sends object and array states unchanged', async () => {
    const fetchMock = vi.fn<typeof globalThis.fetch>(async () => jsonResponse(RESPONSE_BODY))
    const client = new JevClient(makeConfig(), { fetch: fetchMock })

    await client.callSystemOne({ state: { ticket: 'payouts failing' }, questions: QUESTIONS })
    await client.callSystemOne({ state: [1, 'two', { three: true }], questions: QUESTIONS })

    const [first, second] = fetchMock.mock.calls
    expect(JSON.parse(String(first?.[1]?.body))).toMatchObject({ state: { ticket: 'payouts failing' } })
    expect(JSON.parse(String(second?.[1]?.body))).toMatchObject({ state: [1, 'two', { three: true }] })
  })
})

describe('credential handling', () => {
  it('reports a missing key by environment variable name without leaking its value', async () => {
    const fetchMock = vi.fn<typeof globalThis.fetch>()
    const config = resolveConfig(
      { baseURL: BASE_URL, apiKeyEnv: 'ABSENT_JEV_KEY' },
      { TYPESAFE_API_KEY: ENV_SECRET },
    )
    const client = new JevClient(config, { fetch: fetchMock })

    const error = await rejection(client.callSystemOne({ state: 'x', questions: QUESTIONS }))

    expect(error).toBeInstanceOf(JevConfigError)
    expect((error as JevConfigError).message).toContain('ABSENT_JEV_KEY')
    expect((error as JevConfigError).message).not.toContain(ENV_SECRET)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('keeps the key out of every error message', async () => {
    const httpError = await rejection(new JevClient(makeConfig({ retry: instantRetry(1) }), {
      fetch: vi.fn<typeof globalThis.fetch>(async () => textResponse('unauthorized', 401)),
    }).callSystemOne({ state: 'x', questions: QUESTIONS }))

    const networkError = await rejection(new JevClient(makeConfig({ retry: instantRetry(1) }), {
      fetch: vi.fn<typeof globalThis.fetch>(async () => {
        throw new Error('offline')
      }),
    }).callSystemOne({ state: 'x', questions: QUESTIONS }))

    const protocolError = await rejection(new JevClient(makeConfig({ retry: instantRetry(1) }), {
      fetch: vi.fn<typeof globalThis.fetch>(async () => textResponse('not json', 200)),
    }).callSystemOne({ state: 'x', questions: QUESTIONS }))

    for (const error of [httpError, networkError, protocolError]) {
      expect(error).toBeInstanceOf(Error)
      expect((error as Error).message).not.toContain(API_KEY)
      expect(String(error)).not.toContain(API_KEY)
    }
  })

  it('does not echo the request state into an error message', async () => {
    const fetchMock = vi.fn<typeof globalThis.fetch>(async () => textResponse('invalid request', 400))
    const client = new JevClient(makeConfig({ retry: instantRetry(1) }), { fetch: fetchMock })

    const error = await rejection(client.callSystemOne({
      state: 'SECRET-CUSTOMER-PAYLOAD',
      questions: QUESTIONS,
    }))

    expect((error as Error).message).toContain('invalid request')
    expect((error as Error).message).not.toContain('SECRET-CUSTOMER-PAYLOAD')
    expect(String(error)).not.toContain('SECRET-CUSTOMER-PAYLOAD')
  })
})

describe('HTTP failures', () => {
  it.each([401, 403, 422])('does not retry status %i', async (status) => {
    const fetchMock = vi.fn<typeof globalThis.fetch>(async () => jsonResponse({ error: 'rejected' }, status))
    const client = new JevClient(makeConfig({ retry: instantRetry(3) }), { fetch: fetchMock })

    const error = await rejection(client.callSystemOne({ state: 'x', questions: QUESTIONS }))

    expect(error).toBeInstanceOf(JevHttpError)
    expect((error as JevHttpError).status).toBe(status)
    expect((error as JevHttpError).retryable).toBe(false)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('quotes the API error body so a 400 reaches the caller with its explanation', async () => {
    const body = '{"detail":{"error_type":"api_usage_error","message":"Invalid request."}}'
    const fetchMock = vi.fn<typeof globalThis.fetch>(async () => textResponse(body, 400))
    const client = new JevClient(makeConfig({ retry: instantRetry(3) }), { fetch: fetchMock })

    const error = await rejection(client.callSystemOne({ state: 'x', questions: QUESTIONS }))

    expect(error).toBeInstanceOf(JevHttpError)
    expect((error as JevHttpError).message).toBe(`Jev API error (400): ${body}`)
    expect((error as JevHttpError).retryable).toBe(false)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it.each([401, 422])('quotes the API error body for status %i', async (status) => {
    const fetchMock = vi.fn<typeof globalThis.fetch>(async () => textResponse('rejected by policy', status))
    const client = new JevClient(makeConfig({ retry: instantRetry(1) }), { fetch: fetchMock })

    const error = await rejection(client.callSystemOne({ state: 'x', questions: QUESTIONS }))

    expect((error as JevHttpError).message).toBe(`Jev API error (${status}): rejected by policy`)
  })

  it.each(['', '   ', '\n'])('omits the detail segment for a blank body %j', async (body) => {
    const fetchMock = vi.fn<typeof globalThis.fetch>(async () => textResponse(body, 503))
    const client = new JevClient(makeConfig({ retry: instantRetry(1) }), { fetch: fetchMock })

    const error = await rejection(client.callSystemOne({ state: 'x', questions: QUESTIONS }))

    expect((error as JevHttpError).message).toBe('Jev API error (503)')
  })

  it('quotes the truncated body, not the raw body, in the message', async () => {
    const fetchMock = vi.fn<typeof globalThis.fetch>(async () => textResponse('e'.repeat(4096), 422))
    const client = new JevClient(makeConfig({ retry: instantRetry(1) }), { fetch: fetchMock })

    const error = await rejection(client.callSystemOne({ state: 'x', questions: QUESTIONS })) as JevHttpError

    expect(error.message).toBe(`Jev API error (422): ${'e'.repeat(512)}…`)
  })

  it('retries 429 and reports a delta-seconds Retry-After in milliseconds', async () => {
    const fetchMock = vi.fn<typeof globalThis.fetch>(async () => textResponse('rate limited', 429, {
      'retry-after': '1',
    }))
    const client = new JevClient(makeConfig({ retry: instantRetry(2) }), { fetch: fetchMock })

    const error = await rejection(client.callSystemOne({ state: 'x', questions: QUESTIONS }))

    expect(error).toBeInstanceOf(JevHttpError)
    expect((error as JevHttpError).retryAfterMs).toBe(1000)
    expect((error as JevHttpError).retryable).toBe(true)
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('parses an HTTP-date Retry-After', async () => {
    vi.useFakeTimers()
    try {
      vi.setSystemTime(new Date('2026-01-01T00:00:00Z'))
      const retryAt = new Date('2026-01-01T00:00:04Z').toUTCString()
      const fetchMock = vi.fn<typeof globalThis.fetch>(async () => textResponse('slow down', 429, {
        'retry-after': retryAt,
      }))
      const client = new JevClient(makeConfig({ retry: instantRetry(1) }), { fetch: fetchMock })

      const error = await rejection(client.callSystemOne({ state: 'x', questions: QUESTIONS }))

      expect((error as JevHttpError).retryAfterMs).toBe(4000)
      expect(fetchMock).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('ignores an unparseable Retry-After', async () => {
    const fetchMock = vi.fn<typeof globalThis.fetch>(async () => textResponse('slow down', 429, {
      'retry-after': 'soon',
    }))
    const client = new JevClient(makeConfig({ retry: instantRetry(1) }), { fetch: fetchMock })

    const error = await rejection(client.callSystemOne({ state: 'x', questions: QUESTIONS }))

    expect((error as JevHttpError).retryAfterMs).toBeUndefined()
  })

  it.each([500, 502, 503, 504, 529])('retries status %i until it succeeds', async (status) => {
    let attempts = 0
    const fetchMock = vi.fn<typeof globalThis.fetch>(async () => {
      attempts += 1
      return attempts === 1 ? textResponse('upstream unavailable', status) : jsonResponse(RESPONSE_BODY)
    })
    const client = new JevClient(makeConfig({ retry: instantRetry(3) }), { fetch: fetchMock })

    await expect(client.callSystemOne({ state: 'x', questions: QUESTIONS })).resolves.toEqual(RESPONSE_BODY)
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('throws the final error once the retry budget is spent', async () => {
    const fetchMock = vi.fn<typeof globalThis.fetch>(async () => textResponse('still failing', 503))
    const client = new JevClient(makeConfig({ retry: instantRetry(3) }), { fetch: fetchMock })

    const error = await rejection(client.callSystemOne({ state: 'x', questions: QUESTIONS }))

    expect(error).toBeInstanceOf(JevHttpError)
    expect((error as JevHttpError).status).toBe(503)
    expect((error as JevHttpError).body).toBe('still failing')
    expect(fetchMock).toHaveBeenCalledTimes(3)
  })

  it('truncates an oversized error body to 512 characters plus an ellipsis', async () => {
    const fetchMock = vi.fn<typeof globalThis.fetch>(async () => textResponse('e'.repeat(4096), 422))
    const client = new JevClient(makeConfig({ retry: instantRetry(3) }), { fetch: fetchMock })

    const error = await rejection(client.callSystemOne({ state: 'x', questions: QUESTIONS }))

    const body = (error as JevHttpError).body
    expect(body).toHaveLength(513)
    expect(body.slice(0, 512)).toBe('e'.repeat(512))
    expect(body.endsWith('…')).toBe(true)
  })

  it('keeps an error body under the budget intact', async () => {
    const fetchMock = vi.fn<typeof globalThis.fetch>(async () => textResponse('bad request', 422))
    const client = new JevClient(makeConfig({ retry: instantRetry(3) }), { fetch: fetchMock })

    const error = await rejection(client.callSystemOne({ state: 'x', questions: QUESTIONS }))

    expect((error as JevHttpError).body).toBe('bad request')
  })
})

describe('transport and body failures', () => {
  it('rejects a 2xx body that is not JSON', async () => {
    const fetchMock = vi.fn<typeof globalThis.fetch>(async () => textResponse('<html>gateway</html>', 200))
    const client = new JevClient(makeConfig({ retry: instantRetry(3) }), { fetch: fetchMock })

    const error = await rejection(client.callSystemOne({ state: 'x', questions: QUESTIONS }))

    expect(error).toBeInstanceOf(JevProtocolError)
    expect((error as JevProtocolError).message).toContain('<html>gateway</html>')
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('wraps a transport failure as JevNetworkError, preserves its cause, and retries it', async () => {
    const boom = new Error('socket hang up')
    const fetchMock = vi.fn<typeof globalThis.fetch>(async () => {
      throw boom
    })
    const client = new JevClient(makeConfig({ retry: instantRetry(2) }), { fetch: fetchMock })

    const error = await rejection(client.callSystemOne({ state: 'x', questions: QUESTIONS }))

    expect(error).toBeInstanceOf(JevNetworkError)
    expect((error as JevNetworkError).cause).toBe(boom)
    expect((error as JevNetworkError).retryable).toBe(true)
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })
})

describe('cancellation and timeout', () => {
  it('rejects before sending when the caller signal is already aborted', async () => {
    const controller = new AbortController()
    const reason = new Error('caller cancelled')
    controller.abort(reason)
    const fetchMock = vi.fn<typeof globalThis.fetch>()
    const client = new JevClient(makeConfig(), { fetch: fetchMock })

    const error = await rejection(client.callSystemOne({
      state: 'x',
      questions: QUESTIONS,
      signal: controller.signal,
    }))

    expect(error).toBe(reason)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('surfaces the caller reason and stops retrying when aborted mid-flight', async () => {
    // Both budgets are covered: `maxAttempts: 1` pins the client's own classification
    // of an aborted request, `maxAttempts: 3` pins that no further attempt is sent.
    for (const maxAttempts of [1, 3]) {
      const controller = new AbortController()
      const reason = new Error('caller cancelled')
      const fetchMock = vi.fn<typeof globalThis.fetch>(stallUntilAborted(() => {
        controller.abort(reason)
      }))
      const client = new JevClient(makeConfig({ retry: instantRetry(maxAttempts) }), { fetch: fetchMock })

      const error = await rejection(client.callSystemOne({
        state: 'x',
        questions: QUESTIONS,
        signal: controller.signal,
      }))

      expect(error).toBe(reason)
      expect(error).not.toBeInstanceOf(JevNetworkError)
      expect(fetchMock).toHaveBeenCalledTimes(1)
    }
  })

  it('reports its own timeout error naming the budget once timeoutMs elapses', async () => {
    // Both budgets are covered: `maxAttempts: 1` pins the client's own classification
    // of the timeout, `maxAttempts: 3` pins that a timeout never re-enters the retry loop.
    for (const maxAttempts of [1, 3]) {
      const fetchMock = vi.fn<typeof globalThis.fetch>(stallUntilAborted())
      const client = new JevClient(makeConfig({ timeoutMs: 20, retry: instantRetry(maxAttempts) }), {
        fetch: fetchMock,
      })

      const error = await rejection(client.callSystemOne({ state: 'x', questions: QUESTIONS }))

      expect(error).toBeInstanceOf(JevTimeoutError)
      expect((error as JevTimeoutError).code).toBe('JEV_TIMEOUT')
      expect((error as JevTimeoutError).message).toBe('Jev request timed out after 20 ms.')
      expect(error).not.toBeInstanceOf(JevNetworkError)
      expect(error).not.toBeInstanceOf(JevHttpError)
      expect(fetchMock).toHaveBeenCalledTimes(1)
    }
  })
})

describe('quota exhaustion', () => {
  it('raises a quota error rather than an HTTP error for 402', async () => {
    const fetchMock = vi.fn<typeof globalThis.fetch>(async () => jsonResponse({ error: 'payment required' }, 402))
    const client = new JevClient(makeConfig({ retry: instantRetry(3) }), { fetch: fetchMock })

    const error = await rejection(client.callSystemOne({ state: 'x', questions: QUESTIONS }))

    expect(error).toBeInstanceOf(JevQuotaError)
    expect((error as JevQuotaError).code).toBe('JEV_QUOTA')
    expect((error as JevQuotaError).message).toContain('402')
    // Retrying cannot restore an exhausted quota, so the budget is not spent on it.
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('keeps 401 and 403 as HTTP errors', async () => {
    for (const status of [401, 403]) {
      const fetchMock = vi.fn<typeof globalThis.fetch>(async () => jsonResponse({ error: 'rejected' }, status))
      const client = new JevClient(makeConfig({ retry: instantRetry(3) }), { fetch: fetchMock })

      const error = await rejection(client.callSystemOne({ state: 'x', questions: QUESTIONS }))

      expect(error).toBeInstanceOf(JevHttpError)
      expect(error).not.toBeInstanceOf(JevQuotaError)
    }
  })
})
