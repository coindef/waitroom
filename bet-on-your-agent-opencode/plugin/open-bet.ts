import type { BonusBucket, BonusDim, FileBucket } from '../../bet-on-your-agent/types/index.ts'

/** One session's open forecast. Empty `turnId` means nothing is open. */
export type OpenBet = {
  turnId: string
  ask: string
  files: string[]
  startedAt: number
  toolCalls: number
  saidConfidence?: number
  saidFiles?: FileBucket
  isDeclined?: true
  bonusDim?: BonusDim
  saidBonus?: BonusBucket
  isBonusDeclined?: true
  /**
   * Paths `session.diff` already listed when the turn opened.
   *
   * Absent until that look exists. A later diff counts only paths that were
   * not in it, so dirt from before the turn is not this turn's forecast.
   */
  baseline?: string[]
  /** `git status` content hashes, used only when `session.diff` cannot be read. */
  baselineLook?: Readonly<Record<string, string>>
}

export const noBet = (): OpenBet => ({ turnId: '', ask: '', files: [], startedAt: 0, toolCalls: 0 })
