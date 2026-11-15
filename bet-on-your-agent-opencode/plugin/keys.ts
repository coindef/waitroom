import type { Keymap, KeymapEvent } from '@opentui/keymap'
import { registerEnabledFields } from '@opentui/keymap/addons'

import { BANDS, BONUS_BUCKETS, FILE_BUCKETS } from '../../bet-on-your-agent/hooks/bet.ts'
import type { BonusBucket, FileBucket } from '../../bet-on-your-agent/types/index.ts'
import type { OpenBet } from './open-bet.ts'

const DIGITS = [1, 2, 3, 4, 5, 0] as const

/**
 * Whether a forecast or an owed verdict is on screen for this bet.
 *
 * The status line after the answers are in is not a question: those digits
 * belong to the prompt again.
 */
export const questionShowing = (bet: OpenBet, owed: boolean): boolean => {
  if (bet.turnId !== '' && bet.isDeclined !== true) {
    if (bet.saidConfidence === undefined) return true
    if (bet.saidFiles === undefined) return true
    if (bet.bonusDim !== undefined && bet.saidBonus === undefined && bet.isBonusDeclined !== true) return true

    return false
  }

  return owed
}

type DigitActions = {
  placeConfidence: (said: number) => void
  placeFiles: (said: FileBucket) => void
  decline: () => void
  placeBonus: (said: BonusBucket) => void
  declineBonus: () => void
  giveVerdict: (turnId: string, landed: boolean) => void
  waveVerdict: (turnId: string) => void
}

/**
 * Apply one digit to the question on screen.
 *
 * Returns false when the digit did not answer anything, which is what
 * `@opentui/keymap` treats as "not handled": the binding then leaves the key
 * event alone so it reaches the focused prompt. `undefined` would count as
 * handled and swallow the key.
 */
export const applyDigit = (digit: number, bet: OpenBet, owedTurnId: string | undefined, act: DigitActions): boolean => {
  if (bet.turnId !== '' && bet.isDeclined !== true) {
    if (bet.saidConfidence === undefined) {
      if (digit === 0) {
        act.decline()

        return true
      }
      const band = BANDS[digit - 1]
      if (band === undefined) return false
      act.placeConfidence(band)

      return true
    }
    if (bet.saidFiles === undefined) {
      if (digit === 0) {
        act.decline()

        return true
      }
      const bucket = FILE_BUCKETS[digit - 1]
      if (bucket === undefined) return false
      act.placeFiles(bucket)

      return true
    }
    if (bet.bonusDim !== undefined && bet.saidBonus === undefined && bet.isBonusDeclined !== true) {
      if (digit === 0) {
        act.declineBonus()

        return true
      }
      const bucket = BONUS_BUCKETS[bet.bonusDim][digit - 1]
      if (bucket === undefined) return false
      act.placeBonus(bucket)

      return true
    }

    return false
  }
  if (owedTurnId === undefined) return false
  if (digit === 1) {
    act.giveVerdict(owedTurnId, true)

    return true
  }
  if (digit === 2) {
    act.giveVerdict(owedTurnId, false)

    return true
  }
  if (digit === 3) {
    act.waveVerdict(owedTurnId)

    return true
  }

  return false
}

export type BetKeyActions = {
  sessionID: () => string | undefined
  bet: (sessionID: string) => OpenBet
  owedTurnId: () => string | undefined
  placeConfidence: (sessionID: string, said: number) => void
  placeFiles: (sessionID: string, said: FileBucket) => void
  decline: (sessionID: string) => void
  placeBonus: (sessionID: string, said: BonusBucket) => void
  declineBonus: (sessionID: string) => void
  giveVerdict: (sessionID: string, turnId: string, landed: boolean) => void
  waveVerdict: (sessionID: string, turnId: string) => void
}

/**
 * Bind 0–5 only while a question is on screen.
 *
 * `enabled` is the keymap addon's layer predicate (`registerEnabledFields`).
 * `createDefaultOpenTuiKeymap` installs it; calling it here is a no-op
 * refcount bump when the host already did. The command also returns false
 * when that digit is not an answer, so a 5 on the files row still reaches
 * the prompt while the row is up.
 */
export const registerBetKeys = <Target extends object, Event extends KeymapEvent>(
  keymap: Keymap<Target, Event>,
  actions: BetKeyActions,
): (() => void) => {
  const offEnabled = registerEnabledFields(keymap)
  const offLayer = keymap.registerLayer({
    enabled: () => {
      const sessionID = actions.sessionID()
      if (!sessionID) return false

      return questionShowing(actions.bet(sessionID), actions.owedTurnId() !== undefined)
    },
    bindings: DIGITS.map(digit => ({ key: String(digit), cmd: `bet.digit-${digit}` })),
    commands: DIGITS.map(digit => ({
      name: `bet.digit-${digit}`,
      run: () => {
        const sessionID = actions.sessionID()
        if (!sessionID) return false

        return applyDigit(digit, actions.bet(sessionID), actions.owedTurnId(), {
          placeConfidence: said => actions.placeConfidence(sessionID, said),
          placeFiles: said => actions.placeFiles(sessionID, said),
          decline: () => actions.decline(sessionID),
          placeBonus: said => actions.placeBonus(sessionID, said),
          declineBonus: () => actions.declineBonus(sessionID),
          giveVerdict: (turnId, landed) => actions.giveVerdict(sessionID, turnId, landed),
          waveVerdict: turnId => actions.waveVerdict(sessionID, turnId),
        })
      },
    })),
  })

  return () => {
    offLayer()
    offEnabled()
  }
}
