/**
 * React rendering for decision cards.
 *
 * Built with `createElement` rather than JSX so the client half needs no second
 * JSX build configuration. Styling is inline and deliberately neutral: the
 * host's design tokens are an internal contract that may move between releases.
 *
 * @module dsh-jev/client/components
 */

import { createElement, type CSSProperties, type ReactElement } from 'react'
import type { CardModel } from './cards.ts'

const ROW: CSSProperties = { alignItems: 'center', display: 'flex', gap: '8px', margin: '2px 0' }
const LABEL: CSSProperties = { fontSize: '12px', minWidth: '5em', opacity: 0.75 }
const TRACK: CSSProperties = {
  background: '#e5e7eb',
  borderRadius: '999px',
  flex: '1',
  height: '6px',
  overflow: 'hidden',
}
const FILL: CSSProperties = { background: '#2563eb', height: '100%' }
const MUTED: CSSProperties = { fontSize: '12px', opacity: 0.6 }

/**
 * One labelled proportion bar.
 * @param key - React key for the enclosing list.
 * @param label - visible label for the row.
 * @param fraction - value in `[0, 1]`.
 * @returns the row element.
 */
function barRow(key: string, label: string, fraction: number): ReactElement {
  const percent = Math.round(fraction * 100)
  return createElement(
    'div',
    { key, style: ROW },
    createElement('span', { style: LABEL }, label),
    createElement(
      'span',
      {
        'aria-label': `${label}: ${percent}%`,
        'aria-valuemax': 100,
        'aria-valuemin': 0,
        'aria-valuenow': percent,
        'role': 'progressbar',
        'style': TRACK,
      },
      createElement('div', { style: { ...FILL, width: `${percent}%` } }),
    ),
    createElement('span', { style: LABEL }, `${percent}%`),
  )
}

/**
 * Render one decision card.
 * @param props - the derived model.
 * @returns the card element.
 */
export function DecisionCard(props: { model: CardModel }): ReactElement {
  const { model } = props
  switch (model.kind) {
    case 'pending':
      return createElement('div', { style: MUTED }, 'judging…')
    case 'noul':
      return createElement('div', null, barRow('noul', model.id, model.probability))
    case 'choice':
      return createElement(
        'div',
        null,
        createElement('div', { style: LABEL }, model.chosen),
        ...model.options.map(option => barRow(option.label, option.label, option.probability)),
      )
    case 'score': {
      const fraction = model.max > 0 ? Math.min(1, Math.max(0, model.score / model.max)) : 0
      const title = `${model.score}/${model.max}${model.level === undefined ? '' : ` ${model.level}`}`
      return createElement(
        'div',
        null,
        model.max > 0
          ? barRow('score', title, fraction)
          : createElement('div', { style: LABEL }, title),
      )
    }
  }
}

/**
 * Render every card for one call.
 * @param props - the derived models, in answer order.
 * @returns the stack element, or `null` when there is nothing to show.
 */
export function DecisionCards(props: { models: readonly CardModel[] }): ReactElement | null {
  if (props.models.length === 0) return null
  return createElement(
    'div',
    null,
    ...props.models.map((model, index) => createElement(DecisionCard, { key: String(index), model })),
  )
}
