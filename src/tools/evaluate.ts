/** `jev_evaluate`: Jev's native multi-question entry point. @module dsh-jev/tools/evaluate */

import { defineTool, type ToolDefinition } from '@deepseek-ai/dsh-tools'
import type { JevService } from '../service.ts'
import { evaluateProjection } from '../presentation.ts'
import { renderDecision } from '../render.ts'
import { toEvaluateEnvelope, validateQuestions, validateState } from '../validation.ts'

/** Model-facing guidance: when the native map beats `jev_decide`, argument shapes, and Jev's competence boundaries. */
const DESCRIPTION = [
  'Ask TypeSafe Jev (System One) several typed questions about one `state` in a single request.',
  'Use it instead of jev_decide when one decision is not enough: multiple dimensions, structured `instructions`,'
  + ' or per-label `criteria` rubrics; for a single question prefer jev_decide, which assembles it for you.',
  '`questions` maps an answer id to { type, instructions, criteria }: "noul" (yes/no probability),'
  + ' "choice" (criteria = label -> rubric string or null, max 255),'
  + ' "score" (criteria = ordered array of levels, max 10, lowest first).',
  'Example: {"priority": {type:"choice", instructions:"How urgent?", criteria:{"low":"routine","high":"outage"}},'
  + ' "needs_human": {type:"noul", instructions:"..."}}.',
  'Jev is weak at exact counting, arithmetic, date comparison, indirect or double-negated reasoning, and non-English input; do not use it as a calculator or a fact database.',
  '`state` is sent to the TypeSafe API and recorded in the DSH session log, so keep unnecessary secrets out of it.',
].join(' ')

/**
 * Define the `jev_evaluate` tool bound to the shared Jev service.
 * @param service - service owning the transport, admission policy, and cache.
 * @returns a registry-ready tool definition.
 */
export function createEvaluateTool(service: JevService): ToolDefinition {
  return defineTool({
    name: 'jev_evaluate',
    description: DESCRIPTION,
    parameters: {
      state: {
        type: 'json',
        required: true,
        description: 'Text, JSON object, or JSON array to judge. null, numbers, and booleans are rejected.',
      },
      questions: {
        type: 'json',
        required: true,
        description: 'Answer id -> question map with at least one entry; each question needs a type and instructions.',
      },
      model: {
        type: 'string',
        description: 'Jev model id overriding the configured default.',
      },
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value) => renderDecision(value),
      // Replayable card facts; see the projection contract in presentation.ts.
      presentationMeta: (_args, value) => evaluateProjection(value),
    },
    async execute(args, exec) {
      const state = validateState(args.state)
      const questions = validateQuestions(args.questions)
      const response = await service.callSystemOne({
        state,
        questions,
        ...args.model === undefined ? {} : { model: args.model },
        signal: exec.signal,
      })
      return toEvaluateEnvelope(response)
    },
  })
}
