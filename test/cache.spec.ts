/** Contract tests for the optional response cache. @module dsh-jev/test/cache */

import { describe, expect, it } from 'vitest'

import { JevResponseCache, cacheKey } from '../src/cache.ts'
import { DEFAULT_CACHE } from '../src/config.ts'
import type { JevQuestions, JevResponse, SystemOneRequest } from '../src/protocol.ts'

const QUESTIONS: JevQuestions = { decision: { type: 'noul', instructions: 'Is it urgent?' } }

const RESPONSE: JevResponse = {
  model: 'jev-1.13.0',
  answers: { decision: { type: 'noul', noul: 0.93 } },
  usage: { input_tokens: 312, output_tokens: 20 },
}

/**
 * Build a request, overriding only the fields a case cares about.
 * @param overrides - fields replacing the defaults.
 * @returns a complete request body.
 */
function request(overrides: Partial<SystemOneRequest> = {}): SystemOneRequest {
  return { model: 'jev-latest', state: 'text', questions: QUESTIONS, ...overrides }
}

/**
 * Controllable clock so no case ever waits.
 * @param start - initial reading in milliseconds.
 * @returns the clock and an advance helper.
 */
function fakeClock(start = 1_000): { now: () => number; advance: (ms: number) => void } {
  let current = start
  return {
    now: () => current,
    advance: (ms: number) => {
      current += ms
    },
  }
}

/** A cache with the given policy and a frozen clock. */
function enabledCache(
  overrides: Partial<{ maxEntries: number; ttlMs: number }> = {},
  clock = fakeClock(),
): { cache: JevResponseCache; clock: { now: () => number; advance: (ms: number) => void } } {
  const config = { ...DEFAULT_CACHE, ...overrides, enabled: true }
  return { cache: new JevResponseCache({ config, now: clock.now }), clock }
}

describe('JevResponseCache while disabled', () => {
  it('stores nothing and reports zero counters', () => {
    const cache = new JevResponseCache({ config: { ...DEFAULT_CACHE, enabled: false } })

    cache.set('k', RESPONSE)

    expect(cache.get('k')).toBeUndefined()
    expect(cache.stats()).toEqual({ hits: 0, misses: 0, entries: 0 })
  })

  it('keeps the default policy disabled', () => {
    expect(DEFAULT_CACHE.enabled).toBe(false)
  })
})

describe('JevResponseCache hits and misses', () => {
  it('returns the stored response by reference', () => {
    const { cache } = enabledCache()

    cache.set('k', RESPONSE)

    expect(cache.get('k')).toBe(RESPONSE)
  })

  it('counts one miss then one hit', () => {
    const { cache } = enabledCache()

    expect(cache.get('k')).toBeUndefined()
    cache.set('k', RESPONSE)
    expect(cache.get('k')).toBe(RESPONSE)

    expect(cache.stats()).toEqual({ hits: 1, misses: 1, entries: 1 })
  })

  it('counts an unknown key as a miss without storing anything', () => {
    const { cache } = enabledCache()

    expect(cache.get('absent')).toBeUndefined()

    expect(cache.stats()).toEqual({ hits: 0, misses: 1, entries: 0 })
  })
})

describe('cacheKey', () => {
  it('ignores object key order', () => {
    expect(cacheKey(request({ state: { a: 1, b: 2 } })))
      .toBe(cacheKey(request({ state: { b: 2, a: 1 } })))
  })

  it('ignores key order in nested objects', () => {
    expect(cacheKey(request({ state: { outer: { y: 1, x: 2 } } })))
      .toBe(cacheKey(request({ state: { outer: { x: 2, y: 1 } } })))
  })

  it('ignores key order inside questions', () => {
    const left = request({ questions: { a: { type: 'noul', instructions: 'q' }, b: { type: 'noul', instructions: 'q' } } })
    const right = request({ questions: { b: { type: 'noul', instructions: 'q' }, a: { type: 'noul', instructions: 'q' } } })

    expect(cacheKey(left)).toBe(cacheKey(right))
  })

  it('treats array order as significant', () => {
    expect(cacheKey(request({ state: [1, 2] })))
      .not.toBe(cacheKey(request({ state: [2, 1] })))
  })

  it('distinguishes the three state forms', () => {
    const asString = cacheKey(request({ state: 'x' }))
    const asArray = cacheKey(request({ state: ['x'] }))
    const asObject = cacheKey(request({ state: { x: 1 } }))

    expect(new Set([asString, asArray, asObject]).size).toBe(3)
  })

  it('distinguishes models and question sets', () => {
    expect(cacheKey(request({ model: 'a' }))).not.toBe(cacheKey(request({ model: 'b' })))
    expect(cacheKey(request())).not.toBe(cacheKey(request({ questions: { other: { type: 'noul', instructions: 'q' } } })))
  })

  it('is stable across repeated calls', () => {
    const value = request({ state: { b: [1, { d: 4, c: 3 }], a: 'x' } })

    expect(cacheKey(value)).toBe(cacheKey(value))
  })
})

describe('JevResponseCache TTL', () => {
  it('serves an entry up to but not including its expiry instant', () => {
    const { cache, clock } = enabledCache({ ttlMs: 100 })

    cache.set('k', RESPONSE)
    clock.advance(99)
    expect(cache.get('k')).toBe(RESPONSE)

    clock.advance(1)
    expect(cache.get('k')).toBeUndefined()
    expect(cache.stats().misses).toBe(1)
  })

  it('drops an expired entry', () => {
    const { cache, clock } = enabledCache({ ttlMs: 100 })

    cache.set('k', RESPONSE)
    clock.advance(100)
    cache.get('k')

    expect(cache.stats().entries).toBe(0)
  })
})

describe('JevResponseCache eviction', () => {
  it('evicts the least recently used entry when full', () => {
    const { cache } = enabledCache({ maxEntries: 2 })

    cache.set('a', RESPONSE)
    cache.set('b', RESPONSE)
    cache.set('c', RESPONSE)

    expect(cache.get('a')).toBeUndefined()
    expect(cache.get('b')).toBe(RESPONSE)
    expect(cache.get('c')).toBe(RESPONSE)
    expect(cache.stats().entries).toBe(2)
  })

  it('a hit makes its entry the most recently used', () => {
    const { cache } = enabledCache({ maxEntries: 2 })

    cache.set('a', RESPONSE)
    cache.set('b', RESPONSE)
    cache.get('a')
    cache.set('c', RESPONSE)

    expect(cache.get('b')).toBeUndefined()
    expect(cache.get('a')).toBe(RESPONSE)
  })

  it('re-setting a key makes it the most recently used', () => {
    const { cache } = enabledCache({ maxEntries: 2 })

    cache.set('a', RESPONSE)
    cache.set('b', RESPONSE)
    cache.set('a', RESPONSE)
    cache.set('c', RESPONSE)

    expect(cache.get('b')).toBeUndefined()
    expect(cache.get('a')).toBe(RESPONSE)
  })
})
