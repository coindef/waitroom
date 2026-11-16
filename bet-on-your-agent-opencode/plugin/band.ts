import { createSignal } from 'solid-js'
import { createStore } from 'solid-js/store'

import { owedVerdict } from '../../bet-on-your-agent/hooks/bet.ts'
import type { RankChange, TurnRecord } from '../../bet-on-your-agent/types/index.ts'
import { noBet, type OpenBet } from './open-bet.ts'

/** A verdict just given, kept so the slot can name a rank climb once. */
export type LastVerdict = { result: 'landed' | 'fixed' | 'skipped'; rankUp?: RankChange }

/**
 * The band's state, in Solid stores.
 *
 * The slot is a Solid computation. It re-runs when a store or signal it read
 * changes. A `Map` write is not one of those, so a keypress used to stick
 * the previous question on screen.
 */
export const createBandState = () => {
  const [open, setOpen] = createStore<Record<string, OpenBet>>({})
  const [lastVerdict, setLastVerdict] = createStore<Record<string, LastVerdict | undefined>>({})
  const [turns, setTurns] = createSignal<TurnRecord[]>([])

  return {
    open,
    lastVerdict,
    turns,
    setOpen,
    setLastVerdict,
    setTurns,
    /** Read this inside the slot. Every field it touches is tracked. */
    view(sessionID: string) {
      const bet = open[sessionID] ?? noBet()
      const history = turns()
      const last = lastVerdict[sessionID]

      return { bet, owed: owedVerdict(history), last }
    },
  }
}
