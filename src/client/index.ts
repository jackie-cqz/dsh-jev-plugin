/**
 * Web client half: register keyed tool rows for the two Jev tools.
 *
 * The types below describe the host's contract structurally instead of
 * importing `@deepseek-ai/dsh-client-*`: those packages carry their own release
 * line, and this plugin only needs the two methods it calls. Re-check the slot
 * name, the registration entry, and the tool-row props when the host version
 * moves.
 *
 * @module dsh-jev/client
 */

import type { ReactElement } from 'react'
import { cardsFromMeta, toCardModels, type CardModel } from './cards.ts'
import { DecisionCards } from './components.ts'

/** Client-side plugin name. */
export const name = 'tool-jev-client'

/** Host services the client half needs; `slots` is baseline. */
export const inject = ['slots']

/** The tool-row block as far as this plugin reads it. */
interface ToolCallBlock {
  content?: readonly unknown[]
  isError?: boolean
  /** Projected by the host from the tool definition; absent on older results. */
  meta?: unknown
}

/** Props the tool-row slot passes to a registered component. */
interface ToolCallViewProps {
  block: ToolCallBlock
}

/** The slot registry surface this plugin uses. */
interface SlotsRegistry {
  inject(name: string, callback: () => unknown): void
  register(
    entry: { name: string; key: string },
    component: (props: ToolCallViewProps) => ReactElement | null,
  ): void
}

/** Client root context, as far as this plugin reads it. */
interface ClientContext {
  slots: SlotsRegistry
}

/**
 * Render the cards for one tool row.
 * @param props - the host's tool-row props.
 * @returns the card stack, or `null` to let the host render its generic row.
 */
function JevRow(props: ToolCallViewProps): ReactElement | null {
  const isError = props.block.isError === true
  const content = Array.isArray(props.block.content) ? props.block.content : []
  // Prefer the projected metadata; a result recorded before the projection
  // existed still carries the canonical envelope in its text.
  const fromMeta = cardsFromMeta(props.block.meta, isError)
  const models: readonly CardModel[] = fromMeta.length > 0
    ? fromMeta
    : toCardModels(content, isError)
  return DecisionCards({ models })
}

/**
 * Register one keyed tool row per Jev tool.
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  for (const key of ['jev_decide', 'jev_evaluate']) {
    ctx.slots.inject('tool.call.toolview', () => ctx.slots.register(
      { name: 'tool.call.toolview', key },
      JevRow,
    ))
  }
}
