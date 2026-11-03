import { expect, test } from 'claude-code/testing'

import {
  accepts,
  BAND_PRECEDENCE,
  cardFor,
  clip,
  commandFrom,
  countLine,
  DISABLE_LABEL,
  DISMISS_LABEL,
  drawnBy,
  earlierLine,
  enabledRowKey,
  hintOf,
  markOf,
  MAX_COMMAND_CHARS,
  MAX_ROWS,
  oneLine,
  outcomeOf,
  roomFor,
  rowLine,
  startTurn,
  statusLine,
  SUBTITLE,
  TITLE,
  toggleRefusedLine,
  turnedOffLine,
  turnedOffLocallyLine,
  turnedOnLine,
  withCommand,
  yieldsBand,
} from '../hooks/shell'
import type { ShellCommand, ShellTurn } from '../types'

const ran = (id: string, text: string): ShellCommand => ({ id, text, outcome: 'ran' })

/** A turn that ran `count` commands, `c1` first. */
const turnOf = (count: number): ShellTurn =>
  Array.from({ length: count }, (_, at) => ran(`t${at + 1}`, `c${at + 1}`)).reduce(withCommand, startTurn('turn-1'))

test('the copy is the spec copy', () => {
  expect(TITLE).toBe('Shell commands this turn')
  expect(SUBTITLE).toBe('Newest last · only a list, nothing blocked or sent')
  expect(DISMISS_LABEL).toBe('Close')
  expect(DISABLE_LABEL).toBe("Don't show again")
  expect(MAX_ROWS).toBe(8)
  expect(countLine(1)).toBe('1 shell command')
  expect(countLine(3)).toBe('3 shell commands')
  expect(earlierLine(1)).toBe('1 earlier command…')
  expect(earlierLine(4)).toBe('4 earlier commands…')
  expect(rowLine({ text: 'git status' })).toBe('$ git status')
  expect(hintOf('ran')).toBe('')
  expect(hintOf('error')).toBe('error')
  expect(hintOf('stopped')).toBe('stopped')
  expect(hintOf('background')).toBe('background')
})

test('the status line counts every command, and says nothing at 0 or once closed', () => {
  expect(statusLine({ total: 0, isDismissed: false })).toBeUndefined()
  expect(statusLine({ total: 1, isDismissed: false })).toBe('1 shell command')
  expect(statusLine({ total: 12, isDismissed: false })).toBe('12 shell commands')
  expect(statusLine({ total: 12, isDismissed: true })).toBeUndefined()
})

// One command, one line

test('a one-line command is shown as it was typed, its spaces folded', () => {
  expect(oneLine('ls')).toBe('ls')
  expect(oneLine('  git   status  ')).toBe('git status')
  expect(oneLine('printf "a\tb"')).toBe('printf "a b"')
  expect(oneLine('   ')).toBe('')
  expect(oneLine('')).toBe('')
})

test('a line break shows as ↵, a backslash continuation joins the next line, and blank lines go', () => {
  expect(oneLine('cd web\nnpm i')).toBe('cd web ↵ npm i')
  expect(oneLine('cd web\r\n\r\n  npm i\n')).toBe('cd web ↵ npm i')
  expect(oneLine('npm install \\\n  --save-dev vitest')).toBe('npm install --save-dev vitest')
  expect(oneLine('a \\\n\\\nb')).toBe('a b')
  // An even run of backslashes is a literal backslash: the line break stays one.
  expect(oneLine('echo x\\\\\necho y')).toBe('echo x\\\\ ↵ echo y')
  expect(oneLine("cat > a.txt <<'EOF'\nhello\nEOF")).toBe("cat > a.txt <<'EOF' ↵ hello ↵ EOF")
})

test('escape sequences, control characters and reordering marks never reach a row', () => {
  expect(oneLine('echo \u001b[31mred\u001b[0m')).toBe('echo red')
  expect(oneLine('echo \u001b]0;title\u0007hi')).toBe('echo hi')
  expect(oneLine('echo a\u0000b\u0007c')).toBe('echo a b c')
  // A right-to-left override would make the row read differently from what ran.
  expect(oneLine('ls ‮txt.exe')).toBe('ls txt.exe')
  expect(oneLine('rm -rf ⁦/⁩')).toBe('rm -rf /')
})

test('a long command is cut to 200 characters with an ellipsis, never through a surrogate pair', () => {
  const long = `echo ${'x'.repeat(400)}`
  const cut = oneLine(long)
  expect(Array.from(cut)).toHaveLength(MAX_COMMAND_CHARS)
  expect(cut.endsWith('…')).toBe(true)
  expect(cut.startsWith('echo xxx')).toBe(true)
  expect(clip('abc', 3)).toBe('abc')
  expect(clip('abcd', 3)).toBe('ab…')
  expect(clip('a 😀😀😀', 4)).toBe('a 😀…')
  expect(clip('ab  cd', 4)).toBe('ab…')
})

// A Bash call, once its answer is back

test('a call the hooks refused never ran and is left out; an error, a stop and the background each have a word', () => {
  const call = { tool_use_id: 'toolu_1', command: 'npm i' }
  expect(outcomeOf(call, { deny: 'no' })).toBeUndefined()
  expect(commandFrom(call, { deny: 'no' })).toBeNull()
  expect(outcomeOf(call, { isError: true, result: 'Exit code 1', text: 'Exit code 1' })).toBe('error')
  expect(outcomeOf(call, { result: { stdout: '', stderr: '', interrupted: true } })).toBe('stopped')
  expect(outcomeOf(call, { result: { stdout: '', stderr: '', interrupted: false, backgroundTaskId: 'b1' } })).toBe(
    'background',
  )
  expect(outcomeOf({ ...call, run_in_background: true }, { result: { stdout: '' } })).toBe('background')
  expect(outcomeOf(call, { result: { stdout: 'ok\n', stderr: '', interrupted: false } })).toBe('ran')
  expect(outcomeOf(call, { result: 'answered by a hook' })).toBe('ran')
  expect(commandFrom(call, { result: { stdout: '' } })).toEqual({ id: 'toolu_1', text: 'npm i', outcome: 'ran' })
})

test('a call with no command, or nothing but space, adds no row', () => {
  expect(commandFrom({ tool_use_id: 'a', command: '  \n ' }, { result: {} })).toBeNull()
  expect(commandFrom({ tool_use_id: 'a' }, { result: {} })).toBeNull()
  expect(commandFrom({ tool_use_id: 'a', command: 42 }, { result: {} })).toBeNull()
  expect(commandFrom({ command: 'ls' }, { result: {} })).toEqual({ id: '', text: 'ls', outcome: 'ran' })
})

// This turn

test('commands join newest last, the list keeps the newest eight, and the count keeps them all', () => {
  const twelve = turnOf(12)
  expect(twelve.total).toBe(12)
  expect(twelve.commands.map(one => one.text)).toEqual(['c5', 'c6', 'c7', 'c8', 'c9', 'c10', 'c11', 'c12'])
  // The same call twice is one row and one count.
  const again = withCommand(twelve, ran('t12', 'c12'))
  expect(again).toBe(twelve)
  // A call with no id still gets a row of its own.
  const one = withCommand(withCommand(startTurn('t'), ran('', 'ls')), ran('', 'ls'))
  expect(one.total).toBe(2)
  expect(new Set(one.commands.map(row => row.id)).size).toBe(2)
})

test('a call that starts while the turn runs joins it; one that starts after, only from a subagent', () => {
  expect(accepts({ isDone: false }, undefined)).toBe(true)
  expect(accepts({ isDone: false }, 'agent-1')).toBe(true)
  expect(accepts({ isDone: true }, 'agent-1')).toBe(true)
  expect(accepts({ isDone: true }, undefined)).toBe(false)
})

test('a stored turn leaves the mark a reloaded module takes up again', () => {
  expect(markOf(null)).toBeNull()
  expect(markOf(startTurn('turn-1'))).toEqual({ turnId: 'turn-1', isDone: false })
  expect(markOf({ ...turnOf(3), isDone: true })).toEqual({ turnId: 'turn-1', isDone: true })
})

test('the list shows nothing before a command, and nothing once closed', () => {
  expect(cardFor(startTurn('t'))).toBeNull()
  expect(cardFor({ ...turnOf(2), isDismissed: true })).toBeNull()
  expect(cardFor(turnOf(2))).toEqual({ rows: turnOf(2).commands, earlier: 0 })
})

test('past eight, the newest eight show and one line counts the earlier ones', () => {
  const eight = cardFor(turnOf(8), 40)
  expect(eight?.rows).toHaveLength(8)
  expect(eight?.earlier).toBe(0)
  const ten = cardFor(turnOf(10), 40)
  expect(ten?.rows.map(row => row.text)).toEqual(['c3', 'c4', 'c5', 'c6', 'c7', 'c8', 'c9', 'c10'])
  expect(ten?.earlier).toBe(2)
  // An unknown height takes the cap.
  expect(cardFor(turnOf(10))?.rows).toHaveLength(8)
  expect(cardFor(turnOf(10), Number.NaN)?.rows).toHaveLength(8)
})

test('a short band keeps the newest commands in view rather than scrolling them out', () => {
  // Six rows: the title, the subtitle, then four commands, or three and the earlier count.
  expect(roomFor(6, 4)).toBe(4)
  expect(roomFor(6, 5)).toBe(3)
  const five = cardFor(turnOf(5), 6)
  expect(five?.rows.map(row => row.text)).toEqual(['c3', 'c4', 'c5'])
  expect(five?.earlier).toBe(2)
  // Never none, however short.
  expect(roomFor(2, 3)).toBe(1)
  expect(roomFor(0, 3)).toBe(1)
  expect(roomFor(undefined, 3)).toBe(3)
})

// The command and the settings row

test('the command lines do not lead with the plugin name, or offer a write or a network', () => {
  for (const line of [turnedOnLine(), turnedOffLine(), turnedOffLocallyLine('locked'), toggleRefusedLine('locked')]) {
    // The engine prints `wait-shell:` in front. The settings path may name it; the line must not.
    expect(line).not.toMatch(/^wait-shell\b/)
    expect(line).not.toMatch(/\b(commit|push|upload|https?)\b/i)
  }
  expect(turnedOnLine()).toBe('on · a list of the shell commands each turn runs · /wait-shell turns it off')
  expect(turnedOffLine()).toBe('off · /wait-shell turns it back on · /plugin → wait-shell → List the shell commands a turn ran')
  expect(turnedOffLocallyLine('a managed setting owns it')).toBe(
    'off · the setting did not change (a managed setting owns it) · kept off on this machine · /wait-shell turns it back on',
  )
  expect(toggleRefusedLine('a managed setting owns it')).toMatch(/^still off · /)
})

test("the enabled row is found under the installed name or a working copy's, and nothing else", () => {
  expect(enabledRowKey([{ key: 'theme' }, { key: 'wait-shell.enabled' }])).toBe('wait-shell.enabled')
  expect(enabledRowKey([{ key: 'wait-shell@inline.enabled' }])).toBe('wait-shell@inline.enabled')
  expect(enabledRowKey([{ key: 'wait-shell.other' }, { key: 'wait-shell-x.enabled' }])).toBe('wait-shell.enabled')
  expect(enabledRowKey([])).toBe('wait-shell.enabled')
})

test('the row goes to every other waitroom mod first, as their own lists already have it', () => {
  expect(BAND_PRECEDENCE).toEqual([
    'wait-breathe',
    'wait-changed',
    'wait-ship',
    'bet-on-your-agent',
    'wait-scope',
    'wait-secret',
    'wait-shell',
  ])
  for (const other of ['wait-breathe', 'wait-changed', 'wait-ship', 'bet-on-your-agent', 'wait-scope', 'wait-secret'] as const) {
    expect(yieldsBand('wait-shell', other)).toBe(true)
    expect(yieldsBand(other, 'wait-shell')).toBe(false)
  }
  expect(yieldsBand('wait-shell', undefined)).toBe(false)
  expect(yieldsBand('wait-shell', 'some-other-plugin')).toBe(false)
  expect(drawnBy({ type: 'Box', part: { plugin: 'wait-secret' } })).toBe('wait-secret')
  expect(drawnBy({ type: 'Box' })).toBeUndefined()
})
