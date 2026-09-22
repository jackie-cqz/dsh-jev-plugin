/** Error types shared by the dsh-jev plugin. @module dsh-jev/errors */

/** Base class for all plugin-defined errors. */
export class JevError extends Error {
  /** Stable machine-readable code. */
  readonly code: string

  constructor(message: string, code: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'JevError'
    this.code = code
  }
}

/** Invalid plugin configuration. */
export class JevConfigError extends JevError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, 'JEV_CONFIG', options)
    this.name = 'JevConfigError'
  }
}

/** Invalid tool arguments, or a Jev response that violates the plugin's envelope contract. */
export class JevValidationError extends JevError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, 'JEV_VALIDATION', options)
    this.name = 'JevValidationError'
  }
}

/** Non-HTTP transport failure (DNS, socket, TLS, etc.). */
export class JevNetworkError extends JevError {
  /** Network failures are usually worth retrying. */
  readonly retryable = true

  constructor(message: string, options?: ErrorOptions) {
    super(message, 'JEV_NETWORK', options)
    this.name = 'JevNetworkError'
  }
}

/**
 * The whole call consumed its `timeoutMs` budget before a response arrived.
 * Deliberately not retryable: {@link isRetryable} recognizes only
 * {@link JevNetworkError} and retryable {@link JevHttpError} values, so this
 * error leaves the retry loop on its first pass. Were it retryable, the next
 * attempt would abort immediately at `signal.throwIfAborted()` and replace this
 * diagnostic message with the raw abort reason.
 */
export class JevTimeoutError extends JevError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, 'JEV_TIMEOUT', options)
    this.name = 'JevTimeoutError'
  }
}

/**
 * HTTP non-2xx response from the TypeSafe API.
 * The message quotes the response body, so the API's own explanation reaches the
 * caller; the transport truncates that body before constructing this error.
 * Retryable statuses are `429`, `500`, `502`, `503`, `504`, and `529`; every
 * other status fails immediately, including the `400` the API returns for
 * request-usage errors.
 */
export class JevHttpError extends JevError {
  /** HTTP status code. */
  readonly status: number
  /** Whether this status is retryable under the MVP policy. */
  readonly retryable: boolean
  /** Suggested delay from `Retry-After`, when present and parseable. */
  readonly retryAfterMs: number | undefined
  /** Truncated response body for diagnostics. */
  readonly body: string

  constructor(status: number, body: string, retryAfterMs?: number, options?: ErrorOptions) {
    const retryable = status === 429 || status === 500 || status === 502 || status === 503 || status === 504 || status === 529
    super(`Jev API error (${status})${body.trim() === '' ? '' : `: ${body}`}`, 'JEV_HTTP', options)
    this.name = 'JevHttpError'
    this.status = status
    this.retryable = retryable
    this.retryAfterMs = retryAfterMs
    this.body = body
  }
}

/** HTTP 2xx response whose body is not valid JSON. */
/**
 * The API reports the account cannot be charged for the request, which means the
 * quota is exhausted rather than the request being malformed or the network
 * failing.
 *
 * Not retryable: an immediate repeat cannot succeed until the account is topped
 * up, so `isRetryable` reports false for it and the admission policy opens a
 * cooldown instead of spending the retry budget and its backoff waits.
 */
export class JevQuotaError extends JevError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, 'JEV_QUOTA', options)
    this.name = 'JevQuotaError'
  }
}

export class JevProtocolError extends JevError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, 'JEV_PROTOCOL', options)
    this.name = 'JevProtocolError'
  }
}

/**
 * The admission policy refused the call before any HTTP request was made.
 * Thrown while the circuit is open, and while a single half-open probe call is
 * already in flight. Not retryable: an immediate repeat cannot succeed until the
 * open window elapses, so `isRetryable` reports false for it.
 */
export class JevCircuitOpenError extends JevError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, 'JEV_CIRCUIT_OPEN', options)
    this.name = 'JevCircuitOpenError'
  }
}
