/** Rendering of decision cards to static markup. @module dsh-jev/test/client-components */

import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { CardModel } from '../src/client/cards.ts'
import { DecisionCard, DecisionCards } from '../src/client/components.ts'

/** Every model variant, for the render-everything assertions. */
const MODELS: readonly CardModel[] = [
  { kind: 'pending' },
  { kind: 'empty' },
  { kind: 'noul', id: 'is_urgent', probability: 0.93 },
  {
    kind: 'choice',
    id: 'department',
    chosen: 'billing',
    confidence: 0.87,
    options: [
      { label: 'billing', probability: 0.73 },
      { label: 'sales', probability: 0.07 },
    ],
  },
  { kind: 'score', id: 'decision', score: 2.99, max: 3, level: '紧急', confidence: 0.99 },
]

/** Render one model. */
function render(model: CardModel): string {
  return renderToStaticMarkup(createElement(DecisionCard, { model }))
}

describe('DecisionCard', () => {
  it('renders a noul probability as a labelled progressbar', () => {
    const html = render({ kind: 'noul', id: 'is_urgent', probability: 0.93 })
    expect(html).toContain('93%')
    expect(html).toContain('is_urgent')
    expect(html).toContain('role="progressbar"')
    expect(html).toContain('aria-valuenow="93"')
  })

  it('renders the chosen label and every option', () => {
    const html = render(MODELS[3] as CardModel)
    expect(html).toContain('billing')
    expect(html).toContain('sales')
    expect(html).toContain('73%')
    expect(html).toContain('7%')
  })

  it('renders a score against its maximum with the level label', () => {
    const html = render(MODELS[4] as CardModel)
    expect(html).toContain('2.99/3')
    expect(html).toContain('紧急')
    expect(html).toContain('100%')
  })

  it('shows a bare score when the legend declares no levels', () => {
    const html = render({ kind: 'score', id: 'decision', score: 1.5, max: 0 })
    expect(html).toContain('1.5/0')
    expect(html).not.toContain('progressbar')
  })

  it('renders the pending and empty placeholders', () => {
    expect(render({ kind: 'pending' })).toContain('judging')
    expect(render({ kind: 'empty' })).toContain('no answers')
  })

  it('renders every variant without throwing', () => {
    for (const model of MODELS) expect(() => render(model)).not.toThrow()
  })
})

describe('DecisionCards', () => {
  it('returns null when there is nothing to show', () => {
    expect(DecisionCards({ models: [] })).toBeNull()
  })

  it('renders one card per model, in order', () => {
    const html = renderToStaticMarkup(createElement(DecisionCards, { models: MODELS }))
    expect(html.indexOf('judging')).toBeLessThan(html.indexOf('no answers'))
    expect(html).toContain('is_urgent')
    expect(html).toContain('billing')
    expect(html).toContain('2.99/3')
  })
})
