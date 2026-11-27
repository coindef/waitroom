/**
 * The doctor report: one healthy line, or one ⚠️ line per outdated room,
 * built from a room list and a Claude Code version. No engine.
 *
 * Requires `claude plugin test`.
 */

import { expect, test } from 'claude-code/testing'

import {
  INSTALL_LIST_UNREADABLE,
  USAGE,
  VERSION_UNREADABLE,
  displayClaudeVersion,
  doctorLines,
  doctorReport,
  installedPluginsPath,
  isAtLeast,
  parseInstalledRooms,
  parseVersion,
} from '../hooks/doctor'

const twelve = (
  versions: Partial<Record<string, string>> = {},
): { name: string; version: string | undefined }[] => {
  const names = [
    'waitroom',
    'bet-on-your-agent',
    'wait-ship',
    'wait-breathe',
    'wait-ping',
    'wait-scope',
    'wait-secret',
    'wait-notify',
    'wait-anchor',
    'wait-cards',
    'wait-focus',
    'wait-chore',
  ]
  const current: Record<string, string> = {
    waitroom: '0.1.2',
    'bet-on-your-agent': '0.6.7',
    'wait-ship': '0.1.8',
    'wait-breathe': '0.2.3',
    'wait-ping': '0.1.2',
    'wait-scope': '0.1.3',
    'wait-secret': '0.1.3',
    'wait-notify': '0.1.1',
    'wait-anchor': '0.1.2',
    'wait-cards': '0.1.1',
    'wait-focus': '0.1.1',
    'wait-chore': '0.1.0',
  }

  return names.map(name => ({
    name,
    version: Object.hasOwn(versions, name) ? versions[name] : current[name],
  }))
}

test('twelve healthy rooms on 2.1.319 print exactly one line with the real count and version', () => {
  const lines = doctorLines({ rooms: twelve(), claudeVersion: '2.1.319' })
  expect(lines).toEqual(['all 12 rooms ok · claude 2.1.319'])
})

test('the room count and Claude Code version are taken from the input, not hardcoded', () => {
  const rooms = [
    { name: 'waitroom', version: '0.1.2' },
    { name: 'bet-on-your-agent', version: '0.6.7' },
    { name: 'wait-ship', version: '0.1.8' },
    { name: 'wait-breathe', version: '0.2.3' },
  ]
  expect(doctorLines({ rooms, claudeVersion: '2.1.325' })).toEqual([
    'all 4 rooms ok · claude 2.1.325',
  ])
})

test('an old yield room is not a problem on 2.1.319 and earlier', () => {
  const rooms = twelve({ 'bet-on-your-agent': '0.6.5', 'wait-ship': '0.1.6' })
  expect(doctorLines({ rooms, claudeVersion: '2.1.319' })).toEqual([
    'all 12 rooms ok · claude 2.1.319',
  ])
  expect(doctorLines({ rooms, claudeVersion: '2.1.322' })).toEqual([
    'all 12 rooms ok · claude 2.1.322',
  ])
})

test('on 2.1.323 and later, one outdated yield room prints one ⚠️ line with a copyable update command', () => {
  const rooms = twelve({ 'bet-on-your-agent': '0.6.5' })
  const lines = doctorLines({ rooms, claudeVersion: '2.1.323' })
  expect(lines).toEqual([
    '⚠️ bet-on-your-agent 0.6.5 stacks the status row on 2.1.323 and later · claude plugin update bet-on-your-agent@waitroom',
  ])
})

test('each outdated yield room gets its own line, in a fixed order, and the healthy line stays off the screen', () => {
  const rooms = twelve({
    'bet-on-your-agent': '0.6.5',
    'wait-breathe': '0.2.1',
    'wait-secret': '0.1.1',
  })
  const lines = doctorLines({ rooms, claudeVersion: '2.1.325' })
  expect(lines).toEqual([
    '⚠️ bet-on-your-agent 0.6.5 stacks the status row on 2.1.323 and later · claude plugin update bet-on-your-agent@waitroom',
    '⚠️ wait-breathe 0.2.1 stacks the status row on 2.1.323 and later · claude plugin update wait-breathe@waitroom',
    '⚠️ wait-secret 0.1.1 stacks the status row on 2.1.323 and later · claude plugin update wait-secret@waitroom',
  ])
})

test('a room at the yield version, or newer, is fine on 2.1.323 and later', () => {
  const rooms = twelve({
    'bet-on-your-agent': '0.6.6',
    'wait-ship': '0.1.7',
    'wait-breathe': '0.2.2',
    'wait-scope': '0.1.2',
    'wait-secret': '0.1.2',
  })
  expect(doctorLines({ rooms, claudeVersion: '2.1.323' })).toEqual([
    'all 12 rooms ok · claude 2.1.323',
  ])
})

test('a yield room that is not installed is not reported', () => {
  const rooms = [
    { name: 'waitroom', version: '0.1.2' },
    { name: 'wait-ping', version: '0.1.2' },
  ]
  expect(doctorLines({ rooms, claudeVersion: '2.1.325' })).toEqual([
    'all 2 rooms ok · claude 2.1.325',
  ])
})

test('an unreadable yield version on 2.1.323 and later is reported as a problem', () => {
  const rooms = twelve({ 'wait-scope': undefined })
  expect(doctorLines({ rooms, claudeVersion: '2.1.325' })).toEqual([
    '⚠️ wait-scope stacks the status row on 2.1.323 and later · claude plugin update wait-scope@waitroom',
  ])
})

test('parseVersion and isAtLeast compare dotted numeric versions, including a -dev suffix', () => {
  expect(parseVersion('2.1.323')).toEqual([2, 1, 323])
  expect(parseVersion('2.1.323-dev')).toEqual([2, 1, 323])
  expect(parseVersion('0.6.6')).toEqual([0, 6, 6])
  expect(parseVersion('not-a-version')).toBe(undefined)
  expect(isAtLeast('0.6.6', '0.6.6')).toBe(true)
  expect(isAtLeast('0.6.7', '0.6.6')).toBe(true)
  expect(isAtLeast('0.6.5', '0.6.6')).toBe(false)
  expect(isAtLeast('2.1.323-dev', '2.1.323')).toBe(true)
  expect(isAtLeast('2.1.322', '2.1.323')).toBe(false)
  expect(isAtLeast('broken', '2.1.323')).toBe(false)
})

test('displayClaudeVersion prefers the release base, then the full version', () => {
  expect(displayClaudeVersion({ version: '2.1.319' })).toBe('2.1.319')
  expect(displayClaudeVersion({ version: '2.1.325-dev.20261120.t101500.sha1a2b3c4', base: '2.1.325-dev' })).toBe(
    '2.1.325-dev',
  )
  expect(displayClaudeVersion({ version: '2.1.325', base: '2.1.325' })).toBe('2.1.325')
})

test('parseInstalledRooms counts only @waitroom entries and reads each version', () => {
  const text = JSON.stringify({
    version: 2,
    plugins: {
      'waitroom@waitroom': [{ version: '0.1.2', scope: 'user' }],
      'bet-on-your-agent@waitroom': [{ version: '0.6.7' }],
      'wait-ship@waitroom': [{ version: '0.1.8' }],
      'wait-breathe@waitroom': [{ version: '0.2.3' }],
      'other@elsewhere': [{ version: '9.9.9' }],
      'wait-review@waitroom': [{ version: '0.4.3' }],
    },
  })
  expect(parseInstalledRooms(text)).toEqual([
    { name: 'waitroom', version: '0.1.2' },
    { name: 'bet-on-your-agent', version: '0.6.7' },
    { name: 'wait-ship', version: '0.1.8' },
    { name: 'wait-breathe', version: '0.2.3' },
    { name: 'wait-review', version: '0.4.3' },
  ])
})

test('parseInstalledRooms returns invalid for unreadable JSON or a missing plugins object', () => {
  expect(parseInstalledRooms('not json')).toBe('invalid')
  expect(parseInstalledRooms('[]')).toBe('invalid')
  expect(parseInstalledRooms('{"version":2}')).toBe('invalid')
})

test('USAGE is the one-line hint for anything other than doctor', () => {
  expect(USAGE).toBe('usage: /waitroom doctor')
})

test('doctorReport joins healthy or problem lines, and uses one fallback when the list or version cannot be read', () => {
  const text = JSON.stringify({
    version: 2,
    plugins: {
      'waitroom@waitroom': [{ version: '0.1.2' }],
      'bet-on-your-agent@waitroom': [{ version: '0.6.5' }],
    },
  })
  expect(doctorReport(text, { version: '2.1.319', base: '2.1.319' })).toBe(
    'all 2 rooms ok · claude 2.1.319',
  )
  expect(doctorReport(text, { version: '2.1.325', base: '2.1.325' })).toBe(
    '⚠️ bet-on-your-agent 0.6.5 stacks the status row on 2.1.323 and later · claude plugin update bet-on-your-agent@waitroom',
  )
  expect(doctorReport('unreadable', { version: '2.1.325', base: '2.1.325' })).toBe(
    INSTALL_LIST_UNREADABLE,
  )
  expect(doctorReport('missing', { version: '2.1.325', base: '2.1.325' })).toBe(
    INSTALL_LIST_UNREADABLE,
  )
  expect(doctorReport(text, 'unreadable')).toBe(VERSION_UNREADABLE)
})

test('installedPluginsPath prefers the cache dir, then the config dir, then ~/.claude, and cowork when that flag is set', () => {
  expect(installedPluginsPath({ CLAUDE_CODE_PLUGIN_CACHE_DIR: '/cache/' })).toBe(
    '/cache/installed_plugins.json',
  )
  expect(installedPluginsPath({ CLAUDE_CONFIG_DIR: '/cfg' })).toBe('/cfg/plugins/installed_plugins.json')
  expect(installedPluginsPath({ HOME: '/home/u' })).toBe('/home/u/.claude/plugins/installed_plugins.json')
  expect(installedPluginsPath({ HOME: '/home/u', CLAUDE_CODE_USE_COWORK_PLUGINS: '1' })).toBe(
    '/home/u/.claude/cowork_plugins/installed_plugins.json',
  )
  expect(installedPluginsPath({})).toBe(undefined)
})
