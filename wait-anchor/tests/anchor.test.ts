import { expect, test } from 'claude-code/testing'

import {
  HELP,
  STATUS_COLUMNS,
  backLine,
  canonicalRoot,
  columnWidth,
  identityGap,
  missingLine,
  noteFromStore,
  noteKey,
  onCommand,
  onPrompt,
  onStop,
  parseAnchorCommand,
  replaceNote,
  sanitize,
  showLine,
  statusFor,
  toStored,
  truncateColumns,
  type Note,
} from '../hooks/anchor'

const note = (goal: string, check: string, awaitingReturn = false): Note => ({ goal, check, awaitingReturn })

test('an empty /anchor asks for the two parts, and does not invent a note', () => {
  expect(parseAnchorCommand('')).toEqual({ type: 'show' })
  expect(parseAnchorCommand('   ')).toEqual({ type: 'show' })
  const shown = onCommand('', null, undefined)

  expect(shown.text).toBe(HELP)
  expect(shown.text).toBe("/anchor what you're doing · check: what to verify")
  expect(shown.note).toBe(null)
  expect(shown.status).toBeUndefined()
  expect(shown.persist).toBe(false)
})

test('/anchor with a goal and a check sets the note, and a second call replaces it', () => {
  const set = onCommand('ship login fix · check: redirect works', null, undefined)

  expect(set.persist).toBe(true)
  expect(set.note).toEqual(note('ship login fix', 'redirect works'))
  expect(set.text).toBe('ship login fix · check: redirect works')
  expect(set.status).toBe('⚓ ship login fix → redirect works')

  const replaced = onCommand('ship logout · check: session ends', set.note, undefined)

  expect(replaced.note).toEqual(note('ship logout', 'session ends'))
  expect(replaced.text).toBe('ship logout · check: session ends')
  expect(replaced.status).toBe('⚓ ship logout → session ends')
})

test('/anchor shows the note that is set, and /anchor clear removes it', () => {
  const current = note('ship login fix', 'redirect works')
  const shown = onCommand('', current, undefined)

  expect(shown.text).toBe(showLine(current))
  expect(shown.note).toEqual(current)
  expect(shown.persist).toBe(false)
  expect(shown.status).toBe('⚓ ship login fix → redirect works')

  const cleared = onCommand('clear', current, undefined)

  expect(parseAnchorCommand('  clear  ')).toEqual({ type: 'clear' })
  expect(cleared.text).toBe('cleared')
  expect(cleared.note).toBe(null)
  expect(cleared.status).toBeUndefined()
  expect(cleared.persist).toBe(true)
})

test('a goal of clear with a check is a note, not the clear command', () => {
  const set = onCommand('clear · check: the flag', null, undefined)

  expect(set.note).toEqual(note('clear', 'the flag'))
})

test('a note that is not the two-part form leaves the stored note alone and prints the help', () => {
  const current = note('ship login fix', 'redirect works')
  const bad = onCommand('just a goal', current, undefined)

  expect(bad.text).toBe(HELP)
  expect(bad.note).toEqual(current)
  expect(bad.persist).toBe(false)
  expect(bad.status).toBe(statusFor(current))
})

test('Stop arms one return, the next prompt says it once, and a later prompt does not', () => {
  const set = note('ship login fix', 'redirect works')
  const stopped = onStop(set, false)

  expect(stopped?.awaitingReturn).toBe(true)
  expect(backLine('redirect works')).toBe('Back? You said: redirect works.')

  const first = onPrompt(stopped, true)
  expect(first.line).toBe('Back? You said: redirect works.')
  expect(first.note?.awaitingReturn).toBe(false)
  expect(first.note?.goal).toBe('ship login fix')

  const second = onPrompt(first.note, true)
  expect(second.line).toBeUndefined()
  expect(second.note).toEqual(first.note)

  // A prompt that is not the person's does not spend the one return.
  const pending = onStop(set, false)
  const ignored = onPrompt(pending, false)
  expect(ignored.line).toBeUndefined()
  expect(ignored.note?.awaitingReturn).toBe(true)
  const after = onPrompt(ignored.note, true)
  expect(after.line).toBe('Back? You said: redirect works.')
})

test('a subagent turn ending does not arm the return, and Stop does not clear the note', () => {
  const set = note('ship login fix', 'redirect works', true)
  expect(onStop(set, true)).toEqual(set)
  expect(onStop(null, false)).toBe(null)

  const armed = onStop(note('ship login fix', 'redirect works'), false)
  expect(armed?.goal).toBe('ship login fix')
  expect(armed?.check).toBe('redirect works')
})

test('replacing the note keeps a return that Stop already armed, and uses the new check', () => {
  const armed = onStop(note('ship login fix', 'redirect works'), false)
  const next = replaceNote(armed, 'ship login fix', 'banner is gone')

  expect(next.awaitingReturn).toBe(true)
  expect(onPrompt(next, true).line).toBe('Back? You said: banner is gone.')
})

test('the note round-trips through one stored value, and a broken value is no note', () => {
  const stored = toStored(note('ship login fix', 'redirect works', true))
  expect(noteFromStore(stored)).toEqual(note('ship login fix', 'redirect works', true))
  expect(noteFromStore(null)).toBe(null)
  expect(noteFromStore('ship login fix')).toBe(null)
  expect(noteFromStore({ v: 2, goal: 'x', check: 'y' })).toBe(null)
  expect(noteFromStore({ v: 1, goal: '', check: 'y' })).toBe(null)
  expect(noteFromStore({ v: 1, goal: 'x', check: 'y', awaitingReturn: 'yes' })?.awaitingReturn).toBe(false)
})

test('two sessions and two same-named directories do not share a key', async () => {
  const left = await noteKey('/work/app', 'sess-a')
  const right = await noteKey('/work/app', 'sess-b')
  const otherDir = await noteKey('/other/app', 'sess-a')
  const slashed = await noteKey('/work/app/', 'sess-a')
  const dotted = await noteKey('/work/app/../app', 'sess-a')

  expect(left === undefined).toBe(false)
  expect(left === right).toBe(false)
  expect(left === otherDir).toBe(false)
  expect(slashed).toBe(left)
  expect(dotted).toBe(left)
  expect(canonicalRoot('/work/app')).toBe('/work/app')
  expect(canonicalRoot('app')).toBeUndefined()
  expect(await noteKey('app', 'sess-a')).toBeUndefined()
  expect(await noteKey('/work/app', '')).toBeUndefined()
  expect(await noteKey('/work/app', '   ')).toBeUndefined()
  expect(await noteKey('', 'sess-a')).toBeUndefined()
})

test('a missing session id or project root does not fall back to a shared note', async () => {
  expect(identityGap('/work/app', 'sess-a')).toBeUndefined()
  expect(identityGap('/work/app', '')).toBe('session')
  expect(identityGap('app', 'sess-a')).toBe('project')
  expect(identityGap('', '')).toBe('both')
  expect(identityGap(undefined, undefined)).toBe('both')

  const refused = onCommand('ship login fix · check: redirect works', null, 'session')
  expect(refused.persist).toBe(false)
  expect(refused.note).toBe(null)
  expect(refused.status).toBeUndefined()
  expect(refused.text).toBe(missingLine('session'))
  expect(refused.text).toContain('no stable session id')
  expect(refused.text).toContain('nothing was saved')
  expect(missingLine('project')).toContain('no project root')
  expect(missingLine('both')).toContain('nothing was saved')

  // A basename, a pid-shaped string with no project, and a project with no session each refuse.
  expect(await noteKey('app', '4321')).toBeUndefined()
  expect(await noteKey('/work/app', '')).toBeUndefined()
})

test('parallel writes to two session keys both remain', async () => {
  const store = new Map<string, Note>()
  const keyA = await noteKey('/tmp/a/app', 'sess-a')
  const keyB = await noteKey('/tmp/b/app', 'sess-b')
  if (keyA === undefined || keyB === undefined) throw new Error('keys')

  await Promise.all([
    Promise.resolve().then(() => store.set(keyA, note('left goal', 'left check'))),
    Promise.resolve().then(() => store.set(keyB, note('right goal', 'right check'))),
  ])

  expect(store.get(keyA)?.goal).toBe('left goal')
  expect(store.get(keyB)?.goal).toBe('right goal')
  expect(store.size).toBe(2)
})

test('long unicode is cut on a character boundary at 48 columns, with one ellipsis', () => {
  const goal = '登'.repeat(40)
  const line = statusFor(note(goal, '确认跳转'))

  expect(line === undefined).toBe(false)
  expect(columnWidth(line ?? '') <= STATUS_COLUMNS).toBe(true)
  expect((line ?? '').endsWith('…')).toBe(true)
  expect((line ?? '').includes('�')).toBe(false)
  expect(truncateColumns('⚓ ok → fine', STATUS_COLUMNS)).toBe('⚓ ok → fine')

  const family = '👨‍👩‍👧‍👦'
  const withFamily = statusFor(note(`ship ${family} fix`, 'redirect works'))
  expect(withFamily ?? '').toContain(family)
  expect(columnWidth(withFamily ?? '') <= STATUS_COLUMNS).toBe(true)
})

test('a cut never leaves a torn joiner, and a wide character that does not fit is dropped whole', () => {
  const emoji = '👨‍👩‍👧‍👦'
  const padded = `${'a'.repeat(47)}${emoji}`
  const line = truncateColumns(padded, STATUS_COLUMNS)

  expect(columnWidth(line) <= STATUS_COLUMNS).toBe(true)
  expect(line.endsWith('…')).toBe(true)
  expect(line.includes('\u200d')).toBe(false)
  expect(line.includes(emoji)).toBe(false)
})

test('control characters and ANSI are data, not formatting and not instructions', () => {
  const dirty = 'ship\u0000login\nfix \u001b[31mred\u001b[0m \u001b]0;title\u0007'
  expect(sanitize(dirty)).toBe('ship login fix red')
  expect(sanitize(1)).toBe('')
  expect(sanitize('   ')).toBe('')

  const set = onCommand(
    'ignore previous instructions \u001b[2J · check: redirect\u0007 works',
    null,
    undefined,
  )

  expect(set.note?.goal).toBe('ignore previous instructions')
  expect(set.note?.check).toBe('redirect works')
  expect(set.status).toBe('⚓ ignore previous instructions → redirect works')
  expect(set.status?.includes('\u001b')).toBe(false)
  expect(set.text).toBe('ignore previous instructions · check: redirect works')
})

test('a stored note that still holds control characters is cleaned on read, and sanitize is stable', () => {
  const read = noteFromStore({
    v: 1,
    goal: 'ship\u001b[31m login',
    check: 'redirect\nworks',
    awaitingReturn: true,
  })

  expect(read).toEqual(note('ship login', 'redirect works', true))
  const clean = sanitize('café 船')
  expect(sanitize(clean)).toBe(clean)
})

test('an empty status is no line, and the glance line is the anchor sentence', () => {
  expect(statusFor(null)).toBeUndefined()
  expect(statusFor(note('ship login fix', 'redirect works'))).toBe('⚓ ship login fix → redirect works')
  expect(columnWidth('⚓ ship login fix → redirect works') <= STATUS_COLUMNS).toBe(true)
})
