/** `jev_decide`: one typed Jev decision assembled from a plain question. @module dsh-jev/tools/decide */

import { defineTool, type ToolDefinition } from '@deepseek-ai/dsh-tools'
import type { JevService } from '../service.ts'
import { JevValidationError } from '../errors.ts'
import type { JevQuestions } from '../protocol.ts'
import { decideProjection } from '../presentation.ts'
import { renderDecision } from '../render.ts'
import {
  toDecideEnvelope,
  validateChoiceOptions,
  validateScoreOptions,
  validateState,
} from '../validation.ts'

/** Decision primitives `jev_decide` can assemble. */
export type DecideKind = 'noul' | 'choice' | 'score'

/** Answer id every `jev_decide` call asks Jev under. */
const DECIDE_KEY = 'decision'

/** One decision as the model expressed it. */
export interface DecideInput {
  /** Literal question to ask Jev about the state. */
  question: string
  /** Decision primitive the question maps onto. */
  kind: DecideKind
  /** `choice` labels or `score` ordered levels; rejected for `noul`. */
  options?: string[] | undefined
}

/** Model-facing guidance: primitive selection, argument shapes, and Jev's competence boundaries. */
const DESCRIPTION = [
  'Ask TypeSafe Jev (System One) for one typed decision about `state`.',
  'Kinds: "noul" = yes/no probability; "choice" = pick one of 2-255 `options`;'
  + ' "score" = place `state` on 2-10 ordered `options` (lowest first).',
  'Examples: {kind:"noul", question:"Is this urgent?", state:"..."};'
  + ' {kind:"choice", options:["billing","technical"], ...};'
  + ' {kind:"score", options:["low","medium","high"], ...}.',
  'Use it for classification, routing, risk gating, and urgency - small judgements where a typed answer beats free text.',
  'For several questions or per-label criteria rubrics in one call, use jev_evaluate.',
  'Jev is weak at exact counting, arithmetic, date comparison, indirect or double-negated reasoning, and non-English input; do not use it as a calculator or a fact database.',
  '`state` is sent to the TypeSafe API and recorded in the DSH session log, so keep unnecessary secrets out of it.',
].join(' ')

/**
 * Assemble the Jev `questions` map for one `jev_decide` call.
 * @param input - question text, decision primitive, and its option list.
 * @returns a one-question map keyed by `decision`.
 * @throws JevValidationError when `options` is missing for `choice` or `score`, blank, out of
 * range, or supplied for `noul`.
 */
export function buildDecideQuestions(input: DecideInput): JevQuestions {
  const { question, kind } = input
  if (kind === 'noul') {
    if (input.options !== undefined) {
      throw new JevValidationError(
        'options is not used with kind "noul"; drop it, or switch to kind "choice" or "score".',
      )
    }
    return { [DECIDE_KEY]: { type: 'noul', instructions: question } }
  }
  if (kind === 'choice') {
    const labels = validateChoiceOptions(input.options)
    return {
      [DECIDE_KEY]: {
        type: 'choice',
        instructions: question,
        criteria: Object.fromEntries(labels.map(label => [label, null])),
      },
    }
  }
  return { [DECIDE_KEY]: { type: 'score', instructions: question, criteria: validateScoreOptions(input.options) } }
}

/**
 * Define the `jev_decide` tool bound to the shared Jev service.
 * @param service - service owning the transport, admission policy, and cache.
 * @returns a registry-ready tool definition.
 */
export function createDecideTool(service: JevService): ToolDefinition {
  return defineTool({
    name: 'jev_decide',
    description: DESCRIPTION,
    parameters: {
      state: {
        type: 'json',
        required: true,
        description: 'Text, JSON object, or JSON array to judge. null, numbers, and booleans are rejected.',
      },
      question: {
        type: 'string',
        required: true,
        description: 'The question to ask about state, phrased for the chosen kind.',
      },
      kind: {
        type: 'string',
        required: true,
        enum: ['noul', 'choice', 'score'],
        description: 'Decision primitive: noul (yes/no probability), choice (pick one label), score (ordered levels).',
      },
      options: {
        type: 'array',
        items: { type: 'string' },
        description: 'Required for choice (2-255 labels, duplicates dropped) and score (2-10 levels, lowest first); omit for noul.',
      },
      model: {
        type: 'string',
        description: 'Jev model id overriding the configured default.',
      },
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value) => renderDecision(value),
      // Replayable card facts; the projection never returns undefined because
      // the registry treats that as invalid output and fails the call.
      presentationMeta: (_args, value) => decideProjection(value),
    },
    async execute(args, exec) {
      const state = validateState(args.state)
      const questions = buildDecideQuestions({
        question: args.question,
        kind: args.kind,
        ...args.options === undefined ? {} : { options: args.options },
      })
      const response = await service.callSystemOne({
        state,
        questions,
        ...args.model === undefined ? {} : { model: args.model },
        signal: exec.signal,
      })
      return toDecideEnvelope(response)
    },
  })
}
