import { expect, test } from 'claude-code/testing'

import { FIRST_SESSION_TIP, shouldShowTip } from '../hooks/tip'

const LOCKED = [
  'Waitroom ready: wait-review · bet-on-your-agent · wait-ship · wait-breathe.',
  'wait-breathe stays off until /breathe.',
  'Optional turn-end file list (not in this install): claude plugin install wait-changed@waitroom',
] as const

test('the tip is the three locked lines, and nothing else', () => {
  expect([...FIRST_SESSION_TIP]).toEqual([...LOCKED])
})

test('a fresh interactive session shows the tip, and a recorded one does not', () => {
  expect(shouldShowTip(true, undefined)).toBe(true)
  expect(shouldShowTip(true, true)).toBe(false)
})

test('a non-interactive start never shows the tip, recorded or not', () => {
  expect(shouldShowTip(false, undefined)).toBe(false)
  expect(shouldShowTip(false, true)).toBe(false)
})
