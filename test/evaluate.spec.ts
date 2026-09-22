/** Contract tests for the `jev_evaluate` tool. @module dsh-jev/test/evaluate */

import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import { describe, expect, it, vi } from 'vitest'

import type { CallSystemOneOptions } from '../src/client.ts'
import type { JevService } from '../src/service.ts'
import { JevValidationError } from '../src/errors.ts'
import type { EvaluateEnvelope, JevQuestions, JevResponse } from '../src/protocol.ts'
import { createEvaluateTool } from '../src/tools/evaluate.ts'

const QUESTIONS: JevQuestions = {
  department: {
    type: 'choice',
    instructions: 'Which team should handle this?',
    criteria: { billing: 'Payment issues', technical: 'Bugs', sales: null },
  },
  is_urgent: { type: 'noul', instructions: 'Does this convey urgency?' },
  frustration: { type: 'score', instructions: 'How frustrated?', criteria: ['Calm', 'Frustrated', 'Angry'] },
}

const RESPONSE: JevResponse = {
  model: 'jev-1.13.0',
  answers: {
    department: { type: 'choice', choice: 'technical', probabilities: { technical: 0.85 }, confidence: 0.78 },
    is_urgent: { type: 'noul', noul: 1 },
  },
  usage: { input_tokens: 392, output_tokens: 65 },
}

/** Execution context holding only the field the tool reads. */
const EXEC = { signal: new AbortController().signal } as unknown as ToolRunContext

/**
 * Build a service double that records the options it receives.
 * @param response - value the transport resolves with.
 * @returns the service double and the captured call options.
 */
function fakeService(response: unknown): { service: JevService; calls: CallSystemOneOptions[] } {
  const calls: CallSystemOneOptions[] = []
  const callSystemOne = vi.fn(async (options: CallSystemOneOptions) => {
    calls.push(options)
    return response
  })
  return { service: { callSystemOne } as unknown as JevService, calls }
}

describe('createEvaluateTool', () => {
  it('exposes the model-facing metadata', () => {
    const { service } = fakeService(RESPONSE)
    const tool = createEvaluateTool(service)

    expect(tool.name).toBe('jev_evaluate')
    // `type: 'json'` compiles to the unconstrained JSON Schema: any JSON value.
    expect(tool.output.schema).toEqual({})
    expect(tool.description).toMatch(/Jev/)
    expect(tool.description).toMatch(/jev_decide/)
    expect(tool.description).toMatch(/counting|arithmetic|date/)
    expect(tool.description).toMatch(/session log/)
    // The description rides every model request, so it must stay compact.
    expect(tool.description.length).toBeLessThan(1200)
  })

  it('names every primitive and shows the question-map shape', () => {
    const { service } = fakeService(RESPONSE)
    const tool = createEvaluateTool(service)

    for (const kind of ['noul', 'choice', 'score']) expect(tool.description).toContain(kind)
    // The criteria form differs per primitive and the example must show both.
    expect(tool.description).toMatch(/criteria = label -> rubric/)
    expect(tool.description).toMatch(/criteria = ordered array/)
    expect(tool.description).toMatch(/Example:[^.]*instructions/)
    expect(tool.description).toContain('instructions')
  })

  it('projects the card facts a Web decision card rebuilds from', () => {
    const { service } = fakeService(RESPONSE)
    const tool = createEvaluateTool(service)
    const value = {
      model: 'jev-1.13.0',
      answers: { department: { type: 'choice', choice: 'billing', probabilities: { billing: 0.9 } } },
      usage: { input_tokens: 1, output_tokens: 2 },
    }

    expect(tool.output.presentationMeta?.({}, value)).toEqual({
      tool: 'jev_evaluate',
      answers: [{ kind: 'choice', id: 'department', chosen: 'billing', probabilities: { billing: 0.9 } }],
    })
  })

  it('renders one summary line per answer above the canonical JSON', () => {
    const { service } = fakeService(RESPONSE)
    const tool = createEvaluateTool(service)
    const value = {
      model: 'jev-1.13.0',
      answers: {
        department: { type: 'choice', choice: 'billing', probabilities: { billing: 0.9 }, confidence: 0.8 },
        is_urgent: { type: 'noul', noul: 1 },
      },
      usage: { input_tokens: 1, output_tokens: 2 },
    }

    const blocks = tool.output.render({}, value) as Array<{ type: string; text: string }>

    expect(blocks).toHaveLength(1)
    const text = blocks[0]?.text ?? ''
    expect(text).toContain('department: choice: billing')
    expect(text).toContain('is_urgent: noul: yes')
    expect(text.endsWith(JSON.stringify(value, null, 2))).toBe(true)
  })

  it('degrades to canonical JSON when the envelope carries no answers', () => {
    const { service } = fakeService(RESPONSE)
    const tool = createEvaluateTool(service)
    const value = { model: 'jev-1.13.0', answers: {}, usage: { input_tokens: 1, output_tokens: 2 } }

    expect(tool.output.render({}, value)).toEqual([{ type: 'text', text: JSON.stringify(value, null, 2) }])
  })

  it('passes the native question map through unchanged', async () => {
    const { service, calls } = fakeService(RESPONSE)
    const tool = createEvaluateTool(service)

    await tool.execute({ state: 'Payouts failing', questions: QUESTIONS }, EXEC)

    expect(calls[0]?.questions).toEqual(QUESTIONS)
  })

  it('returns the evaluate envelope with answers untouched', async () => {
    const { service } = fakeService(RESPONSE)
    const tool = createEvaluateTool(service)

    const value = await tool.execute({ state: 'x', questions: QUESTIONS }, EXEC) as EvaluateEnvelope

    expect(value).toEqual({ model: 'jev-1.13.0', answers: RESPONSE.answers, usage: { input_tokens: 392, output_tokens: 65 } })
  })

  it('accepts string, array, and object states', async () => {
    const { service, calls } = fakeService(RESPONSE)
    const tool = createEvaluateTool(service)

    await tool.execute({ state: 'text', questions: QUESTIONS }, EXEC)
    await tool.execute({ state: [1, 'two'], questions: QUESTIONS }, EXEC)
    await tool.execute({ state: { ticket: 42 }, questions: QUESTIONS }, EXEC)

    expect(calls.map(call => call.state)).toEqual(['text', [1, 'two'], { ticket: 42 }])
  })

  for (const state of [null, 7, true]) {
    it(`rejects a ${state === null ? 'null' : typeof state} state`, async () => {
      const { service } = fakeService(RESPONSE)
      const tool = createEvaluateTool(service)

      await expect(tool.execute({ state, questions: QUESTIONS }, EXEC)).rejects.toBeInstanceOf(JevValidationError)
    })
  }

  for (const questions of [{}, [1, 2], null, 'nope']) {
    it(`rejects ${JSON.stringify(questions)} as a question map`, async () => {
      const { service } = fakeService(RESPONSE)
      const tool = createEvaluateTool(service)

      await expect(tool.execute({ state: 'x', questions }, EXEC)).rejects.toThrow(/questions/)
    })
  }

  const BAD_RESPONSES: ReadonlyArray<readonly [label: string, response: unknown]> = [
    ['a missing model', { answers: { a: {} }, usage: { input_tokens: 1, output_tokens: 1 } }],
    ['a missing usage', { model: 'm', answers: { a: {} } }],
    ['a missing answers', { model: 'm', usage: { input_tokens: 1, output_tokens: 1 } }],
    ['an empty answers map', { model: 'm', answers: {}, usage: { input_tokens: 1, output_tokens: 1 } }],
    ['a non-object answer', { model: 'm', answers: { a: 'nope' }, usage: { input_tokens: 1, output_tokens: 1 } }],
  ]

  for (const [label, response] of BAD_RESPONSES) {
    it(`rejects ${label}`, async () => {
      const { service } = fakeService(response)
      const tool = createEvaluateTool(service)

      await expect(tool.execute({ state: 'x', questions: QUESTIONS }, EXEC)).rejects.toBeInstanceOf(JevValidationError)
    })
  }

  it('forwards a per-call model override and omits model when absent', async () => {
    const { service, calls } = fakeService(RESPONSE)
    const tool = createEvaluateTool(service)

    await tool.execute({ state: 'x', questions: QUESTIONS, model: 'jev-1.12.0' }, EXEC)
    await tool.execute({ state: 'x', questions: QUESTIONS }, EXEC)

    expect(calls[0]?.model).toBe('jev-1.12.0')
    expect(calls[1] !== undefined && 'model' in calls[1]).toBe(false)
  })

  it('forwards the execution signal to the transport', async () => {
    const { service, calls } = fakeService(RESPONSE)
    const tool = createEvaluateTool(service)

    await tool.execute({ state: 'x', questions: QUESTIONS }, EXEC)

    expect(calls[0]?.signal).toBe(EXEC.signal)
  })

  it('propagates transport failures unchanged', async () => {
    const failure = new Error('offline')
    const service = { callSystemOne: vi.fn(async () => { throw failure }) } as unknown as JevService
    const tool = createEvaluateTool(service)

    await expect(tool.execute({ state: 'x', questions: QUESTIONS }, EXEC)).rejects.toBe(failure)
  })
})
