/** Confidence bands and the handling verdict they imply. @module dsh-jev/confidence */

import type { ResolvedConfidenceConfig } from './config.ts'
import { JevValidationError } from './errors.ts'

/**
 * How one decision should be handled.
 * `approve` may be applied automatically, `review` is usable but should be
 * checked, and `escalate` is too uncertain to act on.
 */
export type ConfidenceVerdict = 'approve' | 'review' | 'escalate'

/**
 * Test for a finite number inside the closed unit interval.
 * @param value - candidate read from an answer or supplied by a caller.
 * @returns `true` only for a usable probability-like value.
 */
function isUnitInterval(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1
}

/**
 * Name a rejected value for an actionable failure message.
 * @param value - rejected confidence.
 * @returns the numeric value for numbers, otherwise the received type.
 */
function describeValue(value: unknown): string {
  if (typeof value === 'number') return String(value)
  if (value === null) return 'null'
  if (Array.isArray(value)) return 'an array'
  return `a ${typeof value}`
}

/**
 * Read the confidence an answer carries, if it carries a usable one.
 *
 * The check is on the field alone, not on `answer.type`: a `noul` answer happens
 * to omit `confidence`, but any plain object whose `confidence` is a finite
 * number in the closed unit interval yields it. Callers use this to discover
 * whether a confidence exists at all, so an unusable value is reported as
 * absence rather than raised — this is a display and policy probe, not the
 * validated entry point.
 * @param answer - raw answer, typically one entry of a Jev response.
 * @returns the confidence in `[0, 1]`, or `undefined` when there is none.
 */
export function confidenceOf(answer: unknown): number | undefined {
  if (typeof answer !== 'object' || answer === null || Array.isArray(answer)) return undefined
  const confidence = (answer as { confidence?: unknown }).confidence
  return isUnitInterval(confidence) ? confidence : undefined
}

/**
 * Map a confidence onto the configured bands.
 *
 * The boundaries are asymmetric on purpose: `approveAt` is inclusive, while
 * `escalateBelow` is exclusive, so the band a value sits on is unambiguous.
 * When a deployment configures both to the same number the `review` band is
 * empty and that shared value resolves to `approve`.
 * @param confidence - confidence to classify, a finite number in `[0, 1]`.
 * @param bands - resolved thresholds; `resolveConfig` guarantees their ordering.
 * @returns the verdict for that confidence.
 * @throws JevValidationError when `confidence` is not a finite number in `[0, 1]`.
 * A value outside the interval means an upstream calculation is wrong, and
 * clamping it would build a threshold policy on corrupt input.
 */
export function verdictFor(
  confidence: number,
  bands: ResolvedConfidenceConfig,
): ConfidenceVerdict {
  if (!isUnitInterval(confidence)) {
    throw new JevValidationError(
      `confidence must be a finite number in [0, 1]; received ${describeValue(confidence)}.`,
    )
  }
  if (confidence >= bands.approveAt) return 'approve'
  if (confidence < bands.escalateBelow) return 'escalate'
  return 'review'
}
