/** Context pruning: Jev scores older messages for continued relevance. @module dsh-jev/context */

import type { ResolvedContextConfig } from './config.ts'
import type { JevAnswer, JevQuestions, JevState } from './protocol.ts'
import type { JevService } from './service.ts'

/** One message a pruning pass may consider. */
export interface ContextMessage {
  /** Role label, used for judging and logging only; it never keys an answer. */
  role: string
  /** Message text. */
  text: string
}

/** What one pruning pass decided about a message list. */
export type ContextDecision =
  | { kind: 'keep' }
  | { kind: 'prune'; drop: readonly number[] }
  /**
   * Shadow mode: the pass ran and judged, but the caller MUST leave the message
   * list unchanged. The indices are what it would have dropped.
   */
  | { kind: 'shadow'; drop: readonly number[] }

/** Counters for the pruning hook. */
export interface JevContextStats {
  /** Batches that reached a judgement; a list below the trigger does not count. */
  passes: number
  /** Messages dropped across every pass; shadow passes drop nothing. */
  dropped: number
  /** Passes reported in shadow mode. */
  shadowed: number
  /** Passes whose judgement failed, and which therefore kept everything. */
  errors: number
  /** Indices the latest pass would drop, or did drop; empty before the first one. */
  lastDrop: readonly number[]
}

/** Construction options. */
export interface JevContextOptions {
  service: JevService
  config: ResolvedContextConfig
}

/** One candidate that cleared the threshold, with the probability that ranked it. */
interface Candidate {
  /** Index within the whole message list. */
  index: number
  /** Judged relevance; lower means more droppable. */
  probability: number
}

/**
 * Answer key for candidate index `index`.
 *
 * Keys are positional so a message's text never becomes an answer key: text is
 * arbitrary, may repeat, and may contain characters a map key should not carry.
 * @param index - candidate index within the prunable prefix.
 * @returns the answer key for that candidate.
 */
function candidateKey(index: number): string {
  return `m${String(index)}`
}

/**
 * Decide which older messages a conversation no longer needs.
 *
 * Only the prefix before the newest `keepRecent` messages is ever considered, so
 * the tail the agent is actively working on is out of scope by construction. The
 * candidates are scored in one request — one `noul` question each — because a
 * per-message round trip would cost more than the pruning saves.
 *
 * A probability orders candidates; it does not by itself decide how much to cut.
 * `dropBelow` is only the gate that makes a message eligible, the lowest
 * probabilities go first, and `maxDrops` bounds one pass. Reading the number as a
 * threshold alone would let a single unlucky pass gut the history.
 *
 * Two messages are floors no probability can move: the newest one, and the first
 * one. The first is what later messages refer back to, so `keepRecent: 0` still
 * leaves the conversation anchored.
 *
 * Failures keep everything, and there is deliberately no fail-closed variant:
 * dropping more history is not the conservative choice. A token-budget overrun
 * is visible and recoverable, while a silently truncated history leaves the
 * model answering from missing context it cannot know it is missing. For the
 * same reason a candidate whose answer is missing or malformed is kept — it was
 * never actually judged.
 */
export class JevContext {
  private readonly service: JevService
  private readonly config: ResolvedContextConfig
  private readonly counters = { passes: 0, dropped: 0, shadowed: 0, errors: 0, lastDrop: [] as number[] }

  /** @param options - the shared service and the resolved pruning configuration. */
  constructor(options: JevContextOptions) {
    this.service = options.service
    this.config = options.config
  }

  /**
   * Plan one pruning pass. Never throws.
   * @param messages - the conversation in order, oldest first.
   * @param signal - cancellation forwarded to the judgement call.
   * @returns `keep` for no change, `prune` with ascending, deduplicated, in-range
   * indices, or `shadow` with the same indices when shadow mode is on — in which
   * case the caller must not change the list.
   */
  async plan(messages: readonly ContextMessage[], signal?: AbortSignal): Promise<ContextDecision> {
    if (!this.config.enabled) return { kind: 'keep' }
    if (messages.length < this.config.triggerMessages) return { kind: 'keep' }

    this.counters.passes += 1
    try {
      const candidateCount = messages.length - this.config.keepRecent
      const candidates = messages.slice(0, candidateCount)
      const questions: JevQuestions = {}
      for (let index = 0; index < candidateCount; index += 1) {
        questions[candidateKey(index)] = { type: 'noul', instructions: this.config.question }
      }
      // Only the prunable prefix is sent; the reserved tail never leaves the process.
      const state: JevState = {
        messages: candidates.map(message => ({ role: message.role, text: message.text })),
      }
      const response = await this.service.callSystemOne({
        state,
        questions,
        ...signal === undefined ? {} : { signal },
      })
      return this.classify(response.answers, candidateCount, messages.length)
    } catch {
      // No error detail is needed here: the hook's only decision is keep, and the
      // counter records that a pass was abandoned.
      this.counters.errors += 1
      return { kind: 'keep' }
    }
  }

  /**
   * Read the hook counters.
   * @returns a snapshot; later passes do not mutate it.
   */
  stats(): Readonly<JevContextStats> {
    return { ...this.counters, lastDrop: [...this.counters.lastDrop] }
  }

  /**
   * Turn scored answers into a decision.
   * @param answers - answer map keyed by {@link candidateKey}.
   * @param candidateCount - size of the prunable prefix.
   * @param messageCount - size of the whole conversation.
   * @returns `keep` when nothing qualifies, otherwise the drop list, marked
   * `shadow` when the pass must not be applied.
   */
  private classify(
    answers: Record<string, JevAnswer>,
    candidateCount: number,
    messageCount: number,
  ): ContextDecision {
    const eligible: Candidate[] = []
    for (let index = 0; index < candidateCount; index += 1) {
      const answer = answers[candidateKey(index)]
      const probability = answer === undefined ? undefined : answer['noul']
      // An unreadable probability keeps the message: it was never judged.
      if (typeof probability !== 'number') continue
      if (!(probability < this.config.dropBelow)) continue
      // Floors: the first message anchors the conversation, and the newest one is
      // what the agent is working on. The latter matters when `keepRecent` is 0
      // and therefore leaves it inside the candidate range.
      if (index === 0 || index === messageCount - 1) continue
      eligible.push({ index, probability })
    }
    // Lowest probability first: the score ranks, the cap and the floors bound.
    eligible.sort((left, right) => left.probability - right.probability)
    const limited = this.config.maxDrops > 0 ? eligible.slice(0, this.config.maxDrops) : eligible
    // Ascending and deduplicated by construction: each index is visited once.
    const drop = limited.map(candidate => candidate.index).sort((left, right) => left - right)
    if (drop.length === 0) return { kind: 'keep' }

    this.counters.lastDrop = drop
    if (this.config.shadow) {
      // Reported, not applied, and not counted as dropped.
      this.counters.shadowed += 1
      return { kind: 'shadow', drop }
    }
    this.counters.dropped += drop.length
    return { kind: 'prune', drop }
  }
}
