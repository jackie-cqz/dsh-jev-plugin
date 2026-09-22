/** Contract tests for the `jev_decide` tool. @module dsh-jev/test/decide */

import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import { describe, expect, it, vi } from 'vitest'

import type { CallSystemOneOptions } from '../src/client.ts'
import type { JevService } from '../src/service.ts'
import { JevValidationError } from '../src/errors.ts'
import type { DecideEnvelope, JevResponse } from '../src/protocol.ts'
import { buildDecideQuestions, createDecideTool } from '../src/tools/decide.ts'

const RESPONSE: JevResponse = {
  model: 'jev-1.13.0',
  answers: { decision: { type: 'choice', choice: 'billing', probabilities: { billing: 0.91 }, confidence: 0.87 } },
  usage: { input_tokens: 320, output_tokens: 34 },
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

describe('buildDecideQuestions', () => {
  it('maps noul to instructions without criteria', () => {
    expect(buildDecideQuestions({ question: 'Is it urgent?', kind: 'noul' })).toEqual({
      decision: { type: 'noul', instructions: 'Is it urgent?' },
    })
  })

  it('maps choice labels to a null-valued rubric in first-seen order', () => {
    expect(buildDecideQuestions({ question: 'Which team?', kind: 'choice', options: ['b', 'a', 'b'] })).toEqual({
      decision: { type: 'choice', instructions: 'Which team?', criteria: { b: null, a: null } },
    })
  })

  it('maps score levels to an ordered array', () => {
    expect(buildDecideQuestions({ question: 'How urgent?', kind: 'score', options: ['low', 'mid', 'high'] })).toEqual({
      decision: { type: 'score', instructions: 'How urgent?', criteria: ['low', 'mid', 'high'] },
    })
  })

  it('rejects options supplied for noul', () => {
    expect(() => buildDecideQuestions({ question: 'q', kind: 'noul', options: ['a', 'b'] }))
      .toThrow(JevValidationError)
    expect(() => buildDecideQuestions({ question: 'q', kind: 'noul', options: ['a', 'b'] })).toThrow(/options/)
  })

  const REJECTED: ReadonlyArray<readonly [label: string, options: unknown]> = [
    ['a missing choice list', undefined],
    ['a single choice label', ['only']],
    ['a non-array choice list', 'billing'],
    ['a blank choice label', ['a', '  ']],
    ['a non-string choice label', ['a', 7]],
    ['a 256-label choice list', Array.from({ length: 256 }, (_, index) => `l${index}`)],
    ['a missing score list', undefined],
    ['a single score level', ['low']],
    ['a blank score level', ['low', '']],
    ['an 11-level score list', Array.from({ length: 11 }, (_, index) => `l${index}`)],
  ]

  for (const [label, options] of REJECTED) {
    it(`rejects ${label}`, () => {
      const kind = label.includes('score') ? 'score' : 'choice'
      expect(() => buildDecideQuestions({ question: 'q', kind, options: options as string[] }))
        .toThrow(/options/)
    })
  }
})

describe('createDecideTool', () => {
  it('exposes the model-facing metadata', () => {
    const { service } = fakeService(RESPONSE)
    const tool = createDecideTool(service)

    expect(tool.name).toBe('jev_decide')
    // `type: 'json'` compiles to the unconstrained JSON Schema: any JSON value.
    expect(tool.output.schema).toEqual({})
    expect(tool.description).toMatch(/Jev/)
    expect(tool.description).toMatch(/counting|arithmetic|date/)
    expect(tool.description).toMatch(/session log/)
    // The description rides every model request, so it must stay compact.
    expect(tool.description.length).toBeLessThan(1100)
  })

  it('names every primitive and shows one argument example per kind', () => {
    const { service } = fakeService(RESPONSE)
    const tool = createDecideTool(service)

    for (const kind of ['noul', 'choice', 'score']) expect(tool.description).toContain(kind)
    // noul carries no options; choice and score do.
    expect(tool.description).toMatch(/kind:"noul"[^;]*question/)
    expect(tool.description).toMatch(/kind:"choice"[^;]*options/)
    expect(tool.description).toMatch(/kind:"score"[^;]*options/)
    // A single question points at the multi-question alternative.
    expect(tool.description).toContain('jev_evaluate')
  })

  it('projects the card facts a Web decision card rebuilds from', () => {
    const { service } = fakeService(RESPONSE)
    const tool = createDecideTool(service)
    const value = {
      model: 'jev-1.13.0',
      answer: { type: 'score', score: 2.99, legend: { 3: 'critical' }, probabilities: { 3: 0.99 }, confidence: 0.99 },
      usage: { input_tokens: 1, output_tokens: 2 },
    }

    const meta = tool.output.presentationMeta?.({}, value)

    expect(meta).toEqual({
      tool: 'jev_decide',
      answers: [{
        kind: 'score',
        id: 'decision',
        score: 2.99,
        legend: { 3: 'critical' },
        confidence: 0.99,
        probabilities: { 3: 0.99 },
      }],
    })
  })

  it('never projects undefined, which the registry treats as invalid output', () => {
    const { service } = fakeService(RESPONSE)
    const tool = createDecideTool(service)

    expect(tool.output.presentationMeta?.({}, { model: 'm' })).toEqual({ tool: 'jev_decide', answers: [] })
  })

  it('renders a summary line above the canonical JSON', () => {
    const { service } = fakeService(RESPONSE)
    const tool = createDecideTool(service)
    const value = { model: 'jev-1.13.0', answer: { type: 'noul', noul: 1 }, usage: { input_tokens: 1, output_tokens: 2 } }

    const blocks = tool.output.render({}, value) as Array<{ type: string; text: string }>

    expect(blocks).toHaveLength(1)
    const text = blocks[0]?.text ?? ''
    expect(text).toContain('noul: yes')
    expect(text.endsWith(JSON.stringify(value, null, 2))).toBe(true)
    expect(text).toBe(`noul: yes, p=1 (100%)\n\n${JSON.stringify(value, null, 2)}`)
  })

  it('returns the decide envelope from answers.decision', async () => {
    const { service, calls } = fakeService(RESPONSE)
    const tool = createDecideTool(service)

    const value = await tool.execute({ state: 'Payouts failing', question: 'Which team?', kind: 'choice', options: ['billing', 'technical'] }, EXEC) as DecideEnvelope

    expect(calls[0]?.questions).toEqual({
      decision: { type: 'choice', instructions: 'Which team?', criteria: { billing: null, technical: null } },
    })
    expect(value).toEqual({
      model: 'jev-1.13.0',
      answer: { type: 'choice', choice: 'billing', probabilities: { billing: 0.91 }, confidence: 0.87 },
      usage: { input_tokens: 320, output_tokens: 34 },
    })
  })

  it('accepts string, array, and object states', async () => {
    const { service, calls } = fakeService(RESPONSE)
    const tool = createDecideTool(service)

    await tool.execute({ state: 'text', question: 'q', kind: 'noul' }, EXEC)
    await tool.execute({ state: [1, 'two'], question: 'q', kind: 'noul' }, EXEC)
    await tool.execute({ state: { ticket: 42 }, question: 'q', kind: 'noul' }, EXEC)

    expect(calls.map(call => call.state)).toEqual(['text', [1, 'two'], { ticket: 42 }])
  })

  for (const state of [null, 7, true]) {
    it(`rejects a ${state === null ? 'null' : typeof state} state`, async () => {
      const { service } = fakeService(RESPONSE)
      const tool = createDecideTool(service)

      await expect(tool.execute({ state, question: 'q', kind: 'noul' }, EXEC)).rejects.toBeInstanceOf(JevValidationError)
    })
  }

  const BAD_RESPONSES: ReadonlyArray<readonly [label: string, response: unknown]> = [
    ['a missing model', { answers: { decision: {} }, usage: { input_tokens: 1, output_tokens: 1 } }],
    ['a missing usage', { model: 'm', answers: { decision: {} } }],
    ['a missing answers', { model: 'm', usage: { input_tokens: 1, output_tokens: 1 } }],
    ['a missing decision answer', { model: 'm', answers: { other: {} }, usage: { input_tokens: 1, output_tokens: 1 } }],
    ['a blank model', { model: '', answers: { decision: {} }, usage: { input_tokens: 1, output_tokens: 1 } }],
    ['a non-numeric token count', { model: 'm', answers: { decision: {} }, usage: { input_tokens: '1', output_tokens: 1 } }],
  ]

  for (const [label, response] of BAD_RESPONSES) {
    it(`rejects ${label}`, async () => {
      const { service } = fakeService(response)
      const tool = createDecideTool(service)

      await expect(tool.execute({ state: 'x', question: 'q', kind: 'noul' }, EXEC))
        .rejects.toBeInstanceOf(JevValidationError)
    })
  }

  it('forwards a per-call model override and omits model when absent', async () => {
    const { service, calls } = fakeService(RESPONSE)
    const tool = createDecideTool(service)

    await tool.execute({ state: 'x', question: 'q', kind: 'noul', model: 'jev-1.12.0' }, EXEC)
    await tool.execute({ state: 'x', question: 'q', kind: 'noul' }, EXEC)

    expect(calls[0]?.model).toBe('jev-1.12.0')
    expect(calls[1] !== undefined && 'model' in calls[1]).toBe(false)
  })

  it('forwards the execution signal to the transport', async () => {
    const { service, calls } = fakeService(RESPONSE)
    const tool = createDecideTool(service)

    await tool.execute({ state: 'x', question: 'q', kind: 'noul' }, EXEC)

    expect(calls[0]?.signal).toBe(EXEC.signal)
  })

  it('propagates transport failures unchanged', async () => {
    const failure = new Error('offline')
    const service = { callSystemOne: vi.fn(async () => { throw failure }) } as unknown as JevService
    const tool = createDecideTool(service)

    await expect(tool.execute({ state: 'x', question: 'q', kind: 'noul' }, EXEC)).rejects.toBe(failure)
  })
})
