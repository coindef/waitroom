import { expect, test } from 'claude-code/testing'

import {
  canPrompt,
  COOLDOWN_MS,
  drawnBy,
  enabledRowKey,
  keepHistory,
  messageAt,
  MESSAGES,
  rowsKept,
  sessionSummaryLine,
  storeFrom,
  toggledLine,
  toggleRefusedLine,
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

test('the summary line counts a singular nudge correctly and pluralizes past it', () => {
  expect(sessionSummaryLine(1, 1)).toBe('1 nudge, 1 taken this session')
  expect(sessionSummaryLine(3, 2)).toBe('3 nudges, 2 taken this session')
})

test('the summary line omits the taken clause when the key is unsupported', () => {
  expect(sessionSummaryLine(3, undefined)).toBe('3 nudges this session')
})

test('a non-positive or non-numeric config value falls back, a positive one is floored', () => {
  expect(wholePositive(90, 999)).toBe(90)
  expect(wholePositive(0, 999)).toBe(999)
  expect(wholePositive(-5, 999)).toBe(999)
  expect(wholePositive('not a number', 999)).toBe(999)
  expect(wholePositive(12.9, 999)).toBe(12)
})

test('the toggle line says the state it is in now, the threshold while on, and that /breathe flips it back', () => {
  const on = toggledLine(true, 90)
  expect(on).toMatch(/^on · /)
  expect(on).toContain('90s')
  expect(on).toContain('/breathe again turns it off')

  const off = toggledLine(false, 90)
  expect(off).toMatch(/^off · /)
  expect(off).toContain('/breathe turns it on')
  // Off is just off: no threshold to wait on, nothing to talk anyone into.
  expect(off).not.toContain('90s')
})

test('the toggle lines make no health claim and no case for either choice', () => {
  for (const line of [toggledLine(true, 90), toggledLine(false, 90), toggleRefusedLine(false, 'locked')]) {
    expect(line).not.toMatch(/health|healthy|should|streak|miss(ed)?|good for|wellness/i)
  }
})

test('a refused toggle says nothing moved, why, and where else the setting lives', () => {
  const line = toggleRefusedLine(false, 'a managed setting owns it')
  expect(line).toMatch(/^still off · /)
  expect(line).toContain('a managed setting owns it')
  expect(line).toContain('/plugin → wait-breathe → Enable the breathing nudges')
  expect(toggleRefusedLine(true, 'x')).toMatch(/^still on · /)
})

test('no line names the plugin again: the engine already prints wait-breathe: in front of it', () => {
  for (const line of [
    toggledLine(true, 90),
    toggledLine(false, 90),
    toggleRefusedLine(false, 'locked'),
    sessionSummaryLine(2, 1),
    sessionSummaryLine(2, undefined),
  ]) {
    expect(line).not.toMatch(/^(wait-)?breathe\b/)
  }
})

test('a due nudge keeps the band ahead of a ship offer and a forecast, and an engine node names nobody', () => {
  const breathe = { plugin: 'wait-breathe', tree: { type: 'Box' } }
  const ship = { plugin: 'wait-ship', tree: { type: 'Box' } }
  const bet = { plugin: 'bet-on-your-agent', tree: { type: 'Box' } }
  const other = { plugin: 'some-other-plugin', tree: { type: 'Box' } }

  expect(drawnBy({ plugin: 'wait-breathe', tree: { type: 'Box' } })).toBe('wait-breathe')
  expect(drawnBy({ type: 'Box', part: { plugin: 'wait-ship' } })).toBe('wait-ship')
  expect(drawnBy({ type: 'engine', ref: 1 })).toBeUndefined()
  expect(rowsKept([ship, bet, breathe], true)[0]).toBe(breathe)
  expect(rowsKept([bet, ship], false)[0]).toBe(ship)
  expect(rowsKept([other], false)).toEqual([other])
})

test('storeFrom keeps a record this mod wrote and rejects a value it cannot read', () => {
  const record = { rotation: 3, lastPromptAt: 10, history: [{ at: 10, taken: true }] }
  expect(storeFrom(record)).toEqual(record)
  expect(storeFrom({ rotation: 0, lastPromptAt: null, history: [] })).toEqual({
    rotation: 0,
    lastPromptAt: null,
    history: [],
  })
  expect(storeFrom(undefined)).toBeUndefined()
  expect(storeFrom(null)).toBeUndefined()
  expect(storeFrom('not-a-record')).toBeUndefined()
  expect(storeFrom(4)).toBeUndefined()
  expect(storeFrom([])).toBeUndefined()
  expect(storeFrom({ rotation: 1, lastPromptAt: null, history: { not: 'a list' } })).toBeUndefined()
  expect(storeFrom({ rotation: 1, lastPromptAt: null, history: 'nope' })).toBeUndefined()
  expect(storeFrom({ rotation: '1', lastPromptAt: null, history: [] })).toBeUndefined()
  expect(storeFrom({ lastPromptAt: null, history: [] })).toBeUndefined()
  expect(storeFrom({ rotation: 1, lastPromptAt: '1', history: [] })).toBeUndefined()
  expect(storeFrom({ rotation: Number.NaN, lastPromptAt: null, history: [] })).toBeUndefined()
  expect(storeFrom({ rotation: 1, lastPromptAt: null, history: [{ at: 1 }] })).toBeUndefined()
  expect(storeFrom({ rotation: 1, lastPromptAt: null, history: [{ at: 1, taken: 'yes' }] })).toBeUndefined()
})

test('the enabled row is found under the installed name or a working copy\'s, and nothing else', () => {
  expect(enabledRowKey([{ key: 'theme' }, { key: 'wait-breathe.enabled' }])).toBe('wait-breathe.enabled')
  expect(enabledRowKey([{ key: 'wait-breathe@inline.enabled' }])).toBe('wait-breathe@inline.enabled')
  expect(enabledRowKey([{ key: 'wait-breathe.longTurnSeconds' }, { key: 'wait-breathe-x.enabled' }])).toBe(
    'wait-breathe.enabled',
  )
  expect(enabledRowKey([])).toBe('wait-breathe.enabled')
})
