/** TypeSafe System One HTTP transport. @module dsh-jev/client */

import type { ResolvedConfig } from './config.ts'
import { resolveApiKey } from './config.ts'
import { JevHttpError, JevNetworkError, JevProtocolError, JevTimeoutError } from './errors.ts'
import type { JevQuestions, JevState, SystemOneRequest } from './protocol.ts'
import { withRetry } from './retry.ts'

/** Response-body budget, in characters, for text quoted in an error. */
const MAX_ERROR_BODY_CHARS = 512

/**
 * Quote a response body inside an error message without letting a large or
 * streaming body dominate the message.
 * @param body - decoded response body.
 * @returns the body unchanged when short enough, otherwise truncated to
 * {@link MAX_ERROR_BODY_CHARS} characters plus a trailing ellipsis.
 */
function truncateBody(body: string): string {
  return body.length <= MAX_ERROR_BODY_CHARS ? body : `${body.slice(0, MAX_ERROR_BODY_CHARS)}…`
}

/**
 * Read a `Retry-After` header as a delay.
 * @param header - raw header value, or `null` when the header is absent.
 * @returns milliseconds to wait, `0` for an HTTP-date already in the past, or
 * `undefined` when the value is absent or matches neither delta-seconds nor
 * HTTP-date syntax.
 */
function parseRetryAfterMs(header: string | null): number | undefined {
  if (header === null) return undefined
  const value = header.trim()
  if (/^\d+$/.test(value)) return Number(value) * 1_000
  const timestamp = Date.parse(value)
  if (Number.isNaN(timestamp)) return undefined
  return Math.max(0, timestamp - Date.now())
}

/**
 * Classify a request that ended because its signal aborted.
 * The caller's own cancellation wins over the request budget: a tool call that
 * passed `exec.signal` receives its own reason unchanged, so the registry keeps
 * reporting a caller cancellation rather than a Jev failure.
 * @param signal - combined caller and timeout signal.
 * @param callerSignal - cancellation owned by the tool call, when one was passed.
 * @param timeoutMs - configured per-call budget, quoted in the timeout message.
 * @returns the value to throw.
 */
function abortReason(signal: AbortSignal, callerSignal: AbortSignal | undefined, timeoutMs: number): unknown {
  if (callerSignal?.aborted === true) return callerSignal.reason
  if (signal.reason?.name === 'TimeoutError') {
    return new JevTimeoutError(`Jev request timed out after ${timeoutMs} ms.`)
  }
  return signal.reason
}

/** Replacement seams for the transport. */
export interface JevClientDeps {
  /** Fetch implementation; defaults to the platform `fetch`. */
  fetch?: typeof globalThis.fetch
  /**
   * Observes one imminent retry, forwarded to {@link withRetry}.
   * @param attempt - 1-based number of the attempt that just failed.
   * @param delayMs - backoff about to be waited out.
   * @param error - value thrown by that attempt.
   */
  onRetry?: (attempt: number, delayMs: number, error: unknown) => void
}

/** One System One evaluation request. */
export interface CallSystemOneOptions {
  /** Text, object, or array Jev evaluates. */
  state: JevState
  /** Question map keyed by the answer id used in the response. */
  questions: JevQuestions
  /** Model id overriding the configured default. */
  model?: string
  /** Cancellation from the tool call. */
  signal?: AbortSignal
}

/** Jev transport bound to one resolved configuration. */
export class JevClient {
  readonly #config: ResolvedConfig
  readonly #fetch: typeof globalThis.fetch
  readonly #onRetry: ((attempt: number, delayMs: number, error: unknown) => void) | undefined

  /**
   * @param config - resolved plugin configuration.
   * @param deps - transport seams; omitted fields fall back to platform behavior.
   */
  constructor(config: ResolvedConfig, deps: JevClientDeps = {}) {
    this.#config = config
    this.#fetch = deps.fetch ?? globalThis.fetch
    this.#onRetry = deps.onRetry
  }

  /**
   * Evaluate `questions` against `state`.
   * Reads the API key on every call, caps the call at `config.timeoutMs`, and
   * repeats transient transport and HTTP failures under `config.retry`.
   * @param options - state, questions, optional model override, and cancellation.
   * @returns the parsed JSON response body, without validating its fields.
   * @throws JevConfigError when neither configuration source provides an API key.
   * @throws JevHttpError when the response status is outside 2xx.
   * @throws JevProtocolError when a 2xx response body is not JSON.
   * @throws JevNetworkError when the transport fails before a response arrives.
   * @throws JevTimeoutError when the call exhausts `config.timeoutMs`.
   * @throws the caller's own abort reason unchanged when `options.signal` fires.
   */
  async callSystemOne(options: CallSystemOneOptions): Promise<unknown> {
    const apiKey = resolveApiKey(this.#config)
    options.signal?.throwIfAborted()
    const request: SystemOneRequest = {
      model: options.model ?? this.#config.model,
      state: options.state,
      questions: options.questions,
    }
    const signal = AbortSignal.any([
      AbortSignal.timeout(this.#config.timeoutMs),
      ...(options.signal === undefined ? [] : [options.signal]),
    ])
    return withRetry(
      () => this.#attempt(apiKey, JSON.stringify(request), signal, options.signal),
      {
        policy: this.#config.retry,
        signal,
        ...this.#onRetry === undefined ? {} : { onRetry: this.#onRetry },
      },
    )
  }

  /**
   * Send one request attempt and classify its outcome.
   * @param apiKey - credential for the `Authorization` header.
   * @param body - serialized {@link SystemOneRequest}.
   * @param signal - combined caller and timeout cancellation.
   * @param callerSignal - cancellation owned by the tool call, when one was passed.
   * @returns the parsed JSON response body.
   */
  async #attempt(
    apiKey: string,
    body: string,
    signal: AbortSignal,
    callerSignal: AbortSignal | undefined,
  ): Promise<unknown> {
    let response: Response
    let rawBody: string
    try {
      response = await this.#fetch(`${this.#config.baseURL}/systemone`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body,
        signal,
      })
      rawBody = await response.text()
    } catch (error) {
      // Cancellation surfaces as the caller's own reason or as a named timeout, never as a transport failure.
      if (signal.aborted) throw abortReason(signal, callerSignal, this.#config.timeoutMs)
      throw new JevNetworkError('Jev request failed: no response from the TypeSafe API.', { cause: error })
    }
    if (!response.ok) {
      throw new JevHttpError(
        response.status,
        truncateBody(rawBody),
        parseRetryAfterMs(response.headers.get('retry-after')),
      )
    }
    try {
      return JSON.parse(rawBody) as unknown
    } catch (error) {
      throw new JevProtocolError(`Jev API returned a non-JSON body: ${truncateBody(rawBody)}`, { cause: error })
    }
  }
}
