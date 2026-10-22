import { expect, test } from 'claude-code/testing'

import {
  canPrompt,
  COOLDOWN_MS,
  keepHistory,
  messageAt,
  MESSAGES,
  sessionCountsOf,
  sessionSummaryLine,
  wholePositive,
} from '../hooks/breathe'

test('the rotation cycles through every message with no immediate repeat', () => {
  const seen = Array.from({ length: MESSAGES.length * 3 }, (_, at) => messageAt(at))

  // Each step differs from the one before it, all the way around twice.
  for (let at = 1; at < seen.length; at++) expect(seen[at]).not.toBe(seen[at - 1])
  // And it is a genuine round-robin, not just "different": it repeats the
  // same four on a fixed period.
  expect(seen.slice(0, MESSAGES.length)).toEqual(seen.slice(MESSAGES.length, MESSAGES.length * 2))
  expect(new Set(seen)).toEqual(new Set(MESSAGES))
})

test('messageAt wraps a negative rotation the same way the positive one would', () => {
  expect(messageAt(-1)).toBe(messageAt(MESSAGES.length - 1))
})

test('no earlier prompt always allows the first one', () => {
  expect(canPrompt(null, 0)).toBe(true)
})

test('the cooldown blocks a second prompt inside ten minutes and allows it past that', () => {
  const shownAt = 1_000_000
  expect(canPrompt(shownAt, shownAt + COOLDOWN_MS - 1)).toBe(false)
  expect(canPrompt(shownAt, shownAt + COOLDOWN_MS)).toBe(true)
})

test('history is capped from the oldest end, not the newest', () => {
  let history: { at: number; taken: boolean }[] = []
  for (let at = 0; at < 5; at++) history = keepHistory(history, { at, taken: false }, 3)

  expect(history.map(one => one.at)).toEqual([2, 3, 4])
})

test('session counts only include what happened at or after the session began', () => {
  const history = [
    { at: 100, taken: true },
    { at: 200, taken: false },
    { at: 300, taken: true },
  ]

  expect(sessionCountsOf(history, 200)).toEqual({ shown: 2, taken: 1 })
  expect(sessionCountsOf(history, null)).toEqual({ shown: 3, taken: 2 })
})

test('the summary line counts a singular prompt correctly and pluralizes past it', () => {
  expect(sessionSummaryLine(1, 1)).toBe('breathe: 1 prompt, 1 taken this session')
  expect(sessionSummaryLine(3, 2)).toBe('breathe: 3 prompts, 2 taken this session')
})

test('the summary line omits the taken clause when the key is unsupported', () => {
  expect(sessionSummaryLine(3, undefined)).toBe('breathe: 3 prompts this session')
})

test('a non-positive or non-numeric config value falls back, a positive one is floored', () => {
  expect(wholePositive(90, 999)).toBe(90)
  expect(wholePositive(0, 999)).toBe(999)
  expect(wholePositive(-5, 999)).toBe(999)
  expect(wholePositive('not a number', 999)).toBe(999)
  expect(wholePositive(12.9, 999)).toBe(12)
})
