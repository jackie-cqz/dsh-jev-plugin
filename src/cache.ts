/** Optional response cache for identical Jev requests. @module dsh-jev/cache */

import type { ResolvedCacheConfig } from './config.ts'
import type { JevResponse, SystemOneRequest } from './protocol.ts'

/** Cache counters and the current number of live entries. */
export interface JevCacheStats {
  /** Answers served from the cache. */
  hits: number
  /** Lookups that produced no live answer, including expired ones. */
  misses: number
  /** Entries currently held. */
  entries: number
}

/**
 * Recursively sort object keys so two spellings of the same value serialize
 * identically. Array order is preserved: it is part of a question's meaning.
 * @param value - value read from a Jev request.
 * @returns the same value with every object's keys in sorted order.
 */
function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(entry => canonicalize(entry))
  if (value === null || typeof value !== 'object') return value
  const source = value as Record<string, unknown>
  const sorted: Record<string, unknown> = {}
  for (const key of Object.keys(source).sort()) {
    const entry = source[key]
    // A JSON request never carries `undefined`, but a caller-constructed value
    // could; dropping it keeps the key stable instead of depending on JSON's
    // own omission rule.
    if (entry === undefined) continue
    sorted[key] = canonicalize(entry)
  }
  return sorted
}

/**
 * Derive the stable cache key for one request.
 * Equivalent requests produce the same key regardless of object key order,
 * while a different model, state, or question set produces a different one.
 * @param request - the request body that would be sent to the API.
 * @returns a canonical JSON string.
 */
export function cacheKey(request: SystemOneRequest): string {
  return JSON.stringify(canonicalize(request))
}

/** Cache construction options. */
export interface JevResponseCacheOptions {
  /** Resolved cache policy; `enabled: false` turns every operation into a no-op. */
  config: ResolvedCacheConfig
  /** Clock in milliseconds; defaults to `Date.now`. */
  now?: () => number
}

/** One stored answer and the instant it stops being usable. */
interface CacheEntry {
  response: JevResponse
  expiresAt: number
}

/**
 * Bounded, TTL-limited cache of Jev responses.
 *
 * Stored responses are returned by reference, not copied: callers must treat a
 * cached {@link JevResponse} as immutable, exactly like the value returned by
 * the transport.
 *
 * The cache is inert unless `config.enabled` is true, so the default
 * configuration leaves the plugin's behavior unchanged.
 */
export class JevResponseCache {
  readonly #config: ResolvedCacheConfig
  readonly #now: () => number
  /** Insertion order doubles as the LRU order: the first key is the coldest. */
  #entries = new Map<string, CacheEntry>()
  #hits = 0
  #misses = 0

  /** @param options - resolved policy and an optional clock. */
  constructor(options: JevResponseCacheOptions) {
    this.#config = options.config
    this.#now = options.now ?? Date.now
  }

  /**
   * Read a live answer.
   * @param key - key from {@link cacheKey}.
   * @returns the stored response, or `undefined` when the cache is disabled, the
   * key is unknown, or the entry has expired. An expired entry is dropped.
   */
  get(key: string): JevResponse | undefined {
    if (!this.#config.enabled) return undefined
    const entry = this.#entries.get(key)
    if (entry === undefined) {
      this.#misses += 1
      return undefined
    }
    if (this.#now() >= entry.expiresAt) {
      this.#entries.delete(key)
      this.#misses += 1
      return undefined
    }
    // Re-insert so a hit becomes the most recently used key.
    this.#entries.delete(key)
    this.#entries.set(key, entry)
    this.#hits += 1
    return entry.response
  }

  /**
   * Store an answer, evicting the least recently used entry when the cache is full.
   * @param key - key from {@link cacheKey}.
   * @param response - transport response; stored and returned by reference.
   */
  set(key: string, response: JevResponse): void {
    if (!this.#config.enabled) return
    this.#entries.delete(key)
    this.#entries.set(key, { response, expiresAt: this.#now() + this.#config.ttlMs })
    while (this.#entries.size > this.#config.maxEntries) {
      const coldest = this.#entries.keys().next()
      if (coldest.done === true) break
      this.#entries.delete(coldest.value)
    }
  }

  /**
   * Read the counters.
   * @returns a snapshot; later cache activity does not mutate it.
   */
  stats(): Readonly<JevCacheStats> {
    return { hits: this.#hits, misses: this.#misses, entries: this.#entries.size }
  }
}
