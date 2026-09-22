import { describe, expect, it, vi } from 'vitest'

import type { ResolvedRetryConfig } from '../src/config.ts'
import {
  JevConfigError,
  JevHttpError,
  JevNetworkError,
  JevProtocolError,
  JevValidationError,
} from '../src/errors.ts'
import { defaultSleep, isRetryable, nextDelayMs, withRetry } from '../src/retry.ts'

/** Delay sink that records its arguments instead of waiting. */
const createSleep = () => vi.fn(async (_ms: number, _signal?: AbortSignal): Promise<void> => {})

const POLICY: ResolvedRetryConfig = { maxAttempts: 3, baseDelayMs: 10, maxDelayMs: 10_000 }

describe('isRetryable', () => {
  const CASES: ReadonlyArray<readonly [label: string, error: unknown, expected: boolean]> = [
    ['a network error', new JevNetworkError('socket closed'), true],
    ['HTTP 429', new JevHttpError(429, 'slow down'), true],
    ['HTTP 500', new JevHttpError(500, 'boom'), true],
    ['HTTP 502', new JevHttpError(502, 'bad gateway'), true],
    ['HTTP 503', new JevHttpError(503, 'unavailable'), true],
    ['HTTP 504', new JevHttpError(504, 'gateway timeout'), true],
    ['HTTP 529', new JevHttpError(529, 'overloaded'), true],
    ['HTTP 401', new JevHttpError(401, 'unauthorized'), false],
    ['HTTP 403', new JevHttpError(403, 'forbidden'), false],
    ['HTTP 422', new JevHttpError(422, 'unprocessable'), false],
    ['a configuration error', new JevConfigError('bad config'), false],
    ['a validation error', new JevValidationError('bad args'), false],
    ['a protocol error', new JevProtocolError('bad body'), false],
    ['a plain error', new Error('boom'), false],
    ['an abort reason', new DOMException('aborted', 'AbortError'), false],
  ]

  for (const [label, error, expected] of CASES) {
    it(`returns ${String(expected)} for ${label}`, () => {
      expect(isRetryable(error)).toBe(expected)
    })
  }
})

describe('nextDelayMs', () => {
  const networkError = new JevNetworkError('socket closed')

  it('doubles the base delay per failed attempt', () => {
    const policy: ResolvedRetryConfig = { maxAttempts: 5, baseDelayMs: 500, maxDelayMs: 5_000 }
    const delays = [1, 2, 3, 4, 5].map(attempt =>
      nextDelayMs(attempt, networkError, { policy, random: () => 1 }))

    expect(delays).toEqual([500, 1_000, 2_000, 4_000, 5_000])
  })

  it('returns zero when the jitter source yields zero', () => {
    expect(nextDelayMs(1, networkError, { policy: POLICY, random: () => 0 })).toBe(0)
  })

  it('scales the delay by the jitter source', () => {
    expect(nextDelayMs(2, networkError, { policy: POLICY, random: () => 0.5 })).toBe(10)
  })

  it('caps the exponential delay at maxDelayMs', () => {
    const policy: ResolvedRetryConfig = { maxAttempts: 3, baseDelayMs: 500, maxDelayMs: 600 }

    expect(nextDelayMs(3, networkError, { policy, random: () => 1 })).toBe(600)
  })

  it('prefers Retry-After over the exponential schedule', () => {
    const error = new JevHttpError(429, 'slow down', 1_200)

    expect(nextDelayMs(1, error, { policy: POLICY, random: () => 0 })).toBe(1_200)
  })

  it('caps Retry-After at maxDelayMs', () => {
    const policy: ResolvedRetryConfig = { maxAttempts: 3, baseDelayMs: 500, maxDelayMs: 1_000 }
    const error = new JevHttpError(429, 'slow down', 5_000)

    expect(nextDelayMs(1, error, { policy, random: () => 0 })).toBe(1_000)
  })

  it('returns zero for a Retry-After of zero', () => {
    const error = new JevHttpError(429, 'slow down', 0)

    expect(nextDelayMs(1, error, { policy: POLICY, random: () => 1 })).toBe(0)
  })

  it('clamps a negative Retry-After to zero', () => {
    const error = new JevHttpError(429, 'slow down', -5)

    expect(nextDelayMs(1, error, { policy: POLICY, random: () => 1 })).toBe(0)
  })

  it('ignores Retry-After on a non-HTTP error', () => {
    expect(nextDelayMs(1, networkError, { policy: POLICY, random: () => 1 })).toBe(10)
  })
})

describe('withRetry', () => {
  it('returns the first successful result after a retryable failure', async () => {
    const sleep = createSleep()
    const operation = vi.fn(async (attempt: number): Promise<string> => {
      if (attempt === 1) throw new JevHttpError(429, 'slow down')
      return 'ok'
    })

    await expect(withRetry(operation, { policy: POLICY, sleep })).resolves.toBe('ok')
    expect(operation).toHaveBeenCalledTimes(2)
    expect(operation).toHaveBeenNthCalledWith(1, 1)
    expect(operation).toHaveBeenNthCalledWith(2, 2)
    expect(sleep).toHaveBeenCalledTimes(1)
  })

  const NON_RETRYABLE: ReadonlyArray<readonly [label: string, error: unknown]> = [
    ['HTTP 401', new JevHttpError(401, 'unauthorized')],
    ['HTTP 422', new JevHttpError(422, 'unprocessable')],
    ['a validation error', new JevValidationError('bad args')],
    ['a plain error', new Error('boom')],
  ]

  for (const [label, error] of NON_RETRYABLE) {
    it(`stops after one attempt on ${label}`, async () => {
      const sleep = createSleep()
      const operation = vi.fn(async (): Promise<never> => { throw error })

      await expect(withRetry(operation, { policy: POLICY, sleep })).rejects.toBe(error)
      expect(operation).toHaveBeenCalledTimes(1)
      expect(sleep).not.toHaveBeenCalled()
    })
  }

  it('throws the final attempt error once the policy is exhausted', async () => {
    const sleep = createSleep()
    const policy: ResolvedRetryConfig = { maxAttempts: 3, baseDelayMs: 1, maxDelayMs: 1 }
    const thrown: JevNetworkError[] = []
    const operation = vi.fn(async (attempt: number): Promise<never> => {
      const error = new JevNetworkError(`socket closed (${attempt})`)
      thrown.push(error)
      throw error
    })

    let caught: unknown
    try {
      await withRetry(operation, { policy, sleep })
    } catch (error) {
      caught = error
    }

    expect(operation).toHaveBeenCalledTimes(3)
    expect(sleep).toHaveBeenCalledTimes(2)
    expect(caught).toBe(thrown[2])
    expect(caught).toBeInstanceOf(JevNetworkError)
    expect((caught as JevNetworkError).message).toBe('socket closed (3)')
  })

  it('attempts once when maxAttempts is one', async () => {
    const sleep = createSleep()
    const policy: ResolvedRetryConfig = { maxAttempts: 1, baseDelayMs: 1, maxDelayMs: 1 }
    const error = new JevNetworkError('down')
    const operation = vi.fn(async (): Promise<never> => { throw error })

    await expect(withRetry(operation, { policy, sleep })).rejects.toBe(error)
    expect(operation).toHaveBeenCalledTimes(1)
    expect(sleep).not.toHaveBeenCalled()
  })

  it('backs off exponentially between attempts', async () => {
    const sleep = createSleep()
    const policy: ResolvedRetryConfig = { maxAttempts: 4, baseDelayMs: 100, maxDelayMs: 10_000 }
    const operation = vi.fn(async (attempt: number): Promise<string> => {
      if (attempt < 4) throw new JevNetworkError('flaky')
      return 'ok'
    })

    await expect(withRetry(operation, { policy, sleep, random: () => 1 })).resolves.toBe('ok')
    expect(sleep.mock.calls.map(([ms]) => ms)).toEqual([100, 200, 400])
  })

  it('aborts before the first attempt when the signal is already aborted', async () => {
    const sleep = createSleep()
    const controller = new AbortController()
    const reason = new Error('cancelled before start')
    controller.abort(reason)
    const operation = vi.fn(async (): Promise<string> => 'unreachable')

    await expect(withRetry(operation, { policy: POLICY, signal: controller.signal, sleep })).rejects.toBe(reason)
    expect(operation).not.toHaveBeenCalled()
    expect(sleep).not.toHaveBeenCalled()
  })

  it('stops without a new attempt when the signal aborts during backoff', async () => {
    const controller = new AbortController()
    const reason = new Error('cancelled during backoff')
    const policy: ResolvedRetryConfig = { maxAttempts: 3, baseDelayMs: 50, maxDelayMs: 50 }
    const operation = vi.fn(async (): Promise<never> => { throw new JevNetworkError('socket closed') })
    const sleep = vi.fn(async (ms: number, signal?: AbortSignal): Promise<void> => {
      const pending = defaultSleep(ms, signal)
      controller.abort(reason)
      await pending
    })

    await expect(withRetry(operation, { policy, signal: controller.signal, sleep })).rejects.toBe(reason)
    expect(operation).toHaveBeenCalledTimes(1)
    expect(sleep).toHaveBeenCalledTimes(1)
  })
})

describe('defaultSleep', () => {
  it('resolves immediately for a non-positive delay', async () => {
    await expect(defaultSleep(0)).resolves.toBeUndefined()
    await expect(defaultSleep(-5)).resolves.toBeUndefined()
  })

  it('rejects with the abort reason when the signal is already aborted', async () => {
    const controller = new AbortController()
    const reason = new Error('already aborted')
    controller.abort(reason)

    await expect(defaultSleep(1_000, controller.signal)).rejects.toBe(reason)
  })

  it('rejects when the signal aborts during the wait', async () => {
    const controller = new AbortController()
    const reason = new Error('aborted mid-wait')
    const pending = defaultSleep(1_000, controller.signal)

    controller.abort(reason)

    await expect(pending).rejects.toBe(reason)
  })

  it('resolves once the delay elapses', async () => {
    const started = Date.now()

    await defaultSleep(5)

    expect(Date.now() - started).toBeGreaterThanOrEqual(4)
  })
})

describe('withRetry retry auditing', () => {
  const POLICY: ResolvedRetryConfig = { maxAttempts: 3, baseDelayMs: 100, maxDelayMs: 1_000 }

  it('reports each imminent retry with its attempt number, delay, and error', async () => {
    const first = new JevNetworkError('first')
    const second = new JevNetworkError('second')
    const operation = vi.fn(async (attempt: number): Promise<string> => {
      if (attempt === 1) throw first
      if (attempt === 2) throw second
      return 'ok'
    })
    const seen: Array<[number, number, unknown]> = []

    const result = await withRetry(operation, {
      policy: POLICY,
      sleep: createSleep(),
      random: () => 1,
      onRetry: (attempt, delayMs, error) => { seen.push([attempt, delayMs, error]) },
    })

    expect(result).toBe('ok')
    expect(seen).toEqual([[1, 100, first], [2, 200, second]])
  })

  it('never observes a call that succeeds on its first attempt', async () => {
    const onRetry = vi.fn()

    await withRetry(async () => 'ok', { policy: POLICY, sleep: createSleep(), onRetry })

    expect(onRetry).not.toHaveBeenCalled()
  })

  it('never observes a failure that is not retryable', async () => {
    const onRetry = vi.fn()

    await expect(withRetry(async (): Promise<never> => { throw new JevValidationError('bad answer') }, {
      policy: POLICY,
      sleep: createSleep(),
      onRetry,
    })).rejects.toBeInstanceOf(JevValidationError)

    expect(onRetry).not.toHaveBeenCalled()
  })

  it('keeps retrying when the observer throws', async () => {
    const operation = vi.fn(async (attempt: number): Promise<string> => {
      if (attempt === 1) throw new JevNetworkError('flaky')
      return 'ok'
    })

    await expect(withRetry(operation, {
      policy: POLICY,
      sleep: createSleep(),
      onRetry: () => { throw new Error('counter broke') },
    })).resolves.toBe('ok')

    expect(operation).toHaveBeenCalledTimes(2)
  })
})
