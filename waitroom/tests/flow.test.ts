import type { On } from 'claude-code'
import type { Engine } from 'claude-code/testing'
import { expect, test } from 'claude-code/testing'

import {
  INSTALL_LIST_UNREADABLE,
  USAGE,
  VERSION_UNREADABLE,
  installedPluginsPath,
} from '../hooks/doctor'
import { FIRST_SESSION_TIP, TIP_SHOWN_KEY } from '../hooks/tip'

/**
 * Stands in for the engine beneath the mod, and keeps the store and the
 * transcript lines the mod writes so a test can read both back.
 */
const engineBottom = (on: On, saved = new Map<string, unknown>()) => {
  const logged: string[] = []
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('store.get', ($, e) => ({ value: saved.get(e.key) }))
  on('store.set', ($, e) => {
    saved.set(e.key, e.value)

    return { value: undefined }
  })
  on('ui.log', ($, e) => {
    logged.push(e.text)

    return { value: undefined }
  })

  return { logged, saved }
}

const start = ($: Engine, isInteractive: boolean) =>
  $.session.start({ cwd: '/work', surface: 'terminal', isInteractive })

const CURRENT: Record<string, string> = {
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

const ROOM_NAMES = Object.keys(CURRENT)

const installJson = (versions: Partial<Record<string, string>> = {}): string =>
  JSON.stringify({
    version: 2,
    plugins: Object.fromEntries(
      ROOM_NAMES.map(name => [
        `${name}@waitroom`,
        [{ version: versions[name] ?? CURRENT[name], scope: 'user' }],
      ]),
    ),
  })

type DoctorHost = {
  installText?: string | 'missing' | 'unreadable'
  claude?: { version: string; base?: string } | 'unreadable'
}

/**
 * A host for `/waitroom doctor`. The tip is already recorded so session
 * start does not write the store. Any store or filesystem write is noted
 * and refused.
 */
const doctorBottom = (on: On, host: DoctorHost = {}) => {
  const storeWrites: string[] = []
  const fileWrites: string[] = []
  const envWrites: string[] = []
  const env = { CLAUDE_CONFIG_DIR: '/iso' }
  const installPath = installedPluginsPath(env)
  const saved = new Map<string, unknown>([[TIP_SHOWN_KEY, true]])
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('store.get', ($, e) => ({ value: saved.get(e.key) }))
  on('store.set', ($, e) => {
    storeWrites.push(e.key)
    throw new Error(`doctor writes no store key: ${e.key}`)
  })
  on('fs.write', ($, e) => {
    fileWrites.push(e.path)
    throw new Error(`doctor writes no file: ${e.path}`)
  })
  on('env.set', ($, e) => {
    envWrites.push(e.name)
    throw new Error(`doctor writes no env: ${e.name}`)
  })
  on('env.get', ($, e) => {
    if (e.name === 'CLAUDE_CONFIG_DIR') return { value: env.CLAUDE_CONFIG_DIR }

    return { value: undefined }
  })
  on('session.version', () => {
    if (host.claude === 'unreadable') throw new Error('version failed')

    return { value: host.claude ?? { version: '2.1.319', base: '2.1.319' } }
  })
  on('fs.read', ($, e) => {
    if (e.path !== installPath) throw new Error(`ENOENT: ${e.path}`)
    if (host.installText === 'missing') throw new Error(`ENOENT: ${e.path}`)
    if (host.installText === 'unreadable') throw new Error(`EACCES: ${e.path}`)

    return { value: host.installText ?? installJson() }
  })

  return { storeWrites, fileWrites, envWrites }
}

const runDoctor = ($: Engine, args = 'doctor') =>
  $.command.run({ command: 'waitroom', args } as never)

test('the first interactive session logs the tip once and records it', async ($, on) => {
  const { logged, saved } = engineBottom(on)

  await start($, true)

  expect(logged).toEqual([...FIRST_SESSION_TIP])
  expect(saved.get(TIP_SHOWN_KEY)).toBe(true)

  // The same session firing start again — a reload — does not repeat it.
  await start($, true)
  expect(logged).toEqual([...FIRST_SESSION_TIP])
})

test('a later session, store already set, logs nothing', async ($, on) => {
  const saved = new Map<string, unknown>([[TIP_SHOWN_KEY, true]])
  const { logged } = engineBottom(on, saved)

  await start($, true)

  expect(logged).toEqual([])
  expect(saved.get(TIP_SHOWN_KEY)).toBe(true)
})

test('a non-interactive start stays quiet and leaves the tip for a later interactive session', async ($, on) => {
  const { logged, saved } = engineBottom(on)

  await start($, false)

  expect(logged).toEqual([])
  expect(saved.has(TIP_SHOWN_KEY)).toBe(false)

  await start($, true)

  expect(logged).toEqual([...FIRST_SESSION_TIP])
  expect(saved.get(TIP_SHOWN_KEY)).toBe(true)

  await start($, true)
  expect(logged).toEqual([...FIRST_SESSION_TIP])
})

test('/waitroom doctor prints one healthy line and writes nothing', async ($, on) => {
  const writes = doctorBottom(on)

  await start($, false)
  const result = await runDoctor($)

  expect(result.text).toBe('all 12 rooms ok · claude 2.1.319')
  expect(writes.storeWrites).toEqual([])
  expect(writes.fileWrites).toEqual([])
  expect(writes.envWrites).toEqual([])
})

test('/waitroom doctor prints one ⚠️ line per outdated yield room and writes nothing', async ($, on) => {
  const writes = doctorBottom(on, {
    installText: installJson({ 'bet-on-your-agent': '0.6.5', 'wait-ship': '0.1.6' }),
    claude: { version: '2.1.325', base: '2.1.325' },
  })

  await start($, false)
  const result = await runDoctor($)

  expect(result.text).toBe(
    [
      '⚠️ bet-on-your-agent 0.6.5 stacks the status row on 2.1.323 and later · claude plugin update bet-on-your-agent@waitroom',
      '⚠️ wait-ship 0.1.6 stacks the status row on 2.1.323 and later · claude plugin update wait-ship@waitroom',
    ].join('\n'),
  )
  expect(writes.storeWrites).toEqual([])
  expect(writes.fileWrites).toEqual([])
  expect(writes.envWrites).toEqual([])
})

test('/waitroom without doctor prints the usage line', async ($, on) => {
  doctorBottom(on)

  await start($, false)
  expect((await runDoctor($, '')).text).toBe(USAGE)
  expect((await runDoctor($, 'status')).text).toBe(USAGE)
})

test('/waitroom doctor says so when the install list or the Claude Code version cannot be read', async ($, on) => {
  doctorBottom(on, { installText: 'missing' })
  await start($, false)
  expect((await runDoctor($)).text).toBe(INSTALL_LIST_UNREADABLE)
})

test('/waitroom doctor says so when the Claude Code version cannot be read', async ($, on) => {
  doctorBottom(on, { claude: 'unreadable' })
  await start($, false)
  expect((await runDoctor($)).text).toBe(VERSION_UNREADABLE)
})
