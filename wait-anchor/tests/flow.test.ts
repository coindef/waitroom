/**
 * The loop through the engine: `/anchor` sets, shows, replaces, and clears;
 * the status line is this mod's own; Stop arms one reminder for the next
 * prompt you type; a second session does not see the note.
 *
 * Requires `claude plugin test`. The simulated-host run is `demo/leave-and-return.ts`.
 */

import type { On } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'

const person = (text: string) => ({ text, wait: false, origin: { kind: 'composer' as const } })

const finish = (turnId: string, extra: { isAborted?: boolean; agentId?: string } = {}) =>
  ({
    turnId,
    answer: 'done',
    durationMs: 1000,
    isAborted: extra.isAborted === true,
    reason: extra.isAborted === true ? 'aborted' : 'answer',
    ...(extra.agentId === undefined ? {} : { agentId: extra.agentId }),
  }) as const

const engineBottom = (
  on: On,
  identity: { root?: string; sessionId?: string } = { root: '/work/app', sessionId: 'sess-a' },
  store: Record<string, unknown> = {},
) => {
  const said: (string | undefined)[] = []
  const logged: string[] = []
  const fetched: string[] = []
  const modeled: string[] = []
  const readTranscript = { count: 0 }
  mock.store(on, store)
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('session.root', () => {
    if (identity.root === undefined) throw new Error('no project root')

    return { value: identity.root }
  })
  on('session.id', () => {
    if (identity.sessionId === undefined) throw new Error('no session id')

    return { value: identity.sessionId }
  })
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('prompt.submit', ($, e) => ({ text: e.text }))
  on('turn.complete', ($, e) => ({ text: e.answer }))
  on('ui.status', ($, e) => {
    said.push(e.text)

    return { value: undefined }
  })
  on('ui.log', ($, e) => {
    logged.push(e.text)

    return { value: undefined }
  })
  on('http.fetch', ($, e) => {
    fetched.push(e.url)
    throw new Error(`wait-anchor opens no connection: ${e.url}`)
  })
  on('model.complete', () => {
    modeled.push('complete')
    throw new Error('wait-anchor calls no model')
  })
  on('session.messages', () => {
    readTranscript.count += 1
    throw new Error('wait-anchor reads no transcript')
  })

  return { said, logged, fetched, modeled, readTranscript, store }
}

test('/anchor sets, shows, replaces, and clears, and an empty note has no status line', async ($, on) => {
  const { said, fetched, modeled, readTranscript } = engineBottom(on)
  await $.session.start({ cwd: '/work/app', surface: 'terminal', isInteractive: true })

  const empty = await $.command.run({ command: 'anchor', args: '' } as never)
  expect(empty.text).toBe("/anchor what you're doing · check: what to verify")
  expect(said.at(-1)).toBeUndefined()

  const set = await $.command.run({
    command: 'anchor',
    args: 'ship login fix · check: redirect works',
  } as never)
  expect(set.text).toBe('ship login fix · check: redirect works')
  expect(said.at(-1)).toBe('⚓ ship login fix → redirect works')

  const shown = await $.command.run({ command: 'anchor' } as never)
  expect(shown.text).toBe('ship login fix · check: redirect works')

  const replaced = await $.command.run({
    command: 'anchor',
    args: 'ship logout · check: session ends',
  } as never)
  expect(replaced.text).toBe('ship logout · check: session ends')
  expect(said.at(-1)).toBe('⚓ ship logout → session ends')

  const cleared = await $.command.run({ command: 'anchor', args: 'clear' } as never)
  expect(cleared.text).toBe('cleared')
  expect(said.at(-1)).toBeUndefined()
  expect(fetched).toEqual([])
  expect(modeled).toEqual([])
  expect(readTranscript.count).toBe(0)
})

test('Stop then the next prompt you type reminds you once', async ($, on) => {
  const { said, logged } = engineBottom(on)
  await $.session.start({ cwd: '/work/app', surface: 'terminal', isInteractive: true })
  await $.command.run({ command: 'anchor', args: 'ship login fix · check: redirect works' } as never)
  await $.turn.complete(finish('turn-1', { isAborted: true }))
  expect(logged).toEqual([])
  expect(said.at(-1)).toBe('⚓ ship login fix → redirect works')

  const first = await $.prompt.submit(person('where was I'))
  expect(first.text).toBe('where was I')
  expect(logged).toEqual(['Back? You said: redirect works.'])

  const second = await $.prompt.submit(person('continue'))
  expect(second.text).toBe('continue')
  expect(logged).toEqual(['Back? You said: redirect works.'])
})

test('a subagent turn does not arm the reminder', async ($, on) => {
  const { logged } = engineBottom(on)
  await $.session.start({ cwd: '/work/app', surface: 'terminal', isInteractive: true })
  await $.command.run({ command: 'anchor', args: 'ship login fix · check: redirect works' } as never)
  await $.turn.complete(finish('sub-1', { agentId: 'worker' }))
  await $.prompt.submit(person('still here'))
  expect(logged).toEqual([])
})

test('setting a note leaves a foreign store key where it was', async ($, on) => {
  const shared: Record<string, unknown> = {
    'note/project-only': { v: 1, goal: 'not yours', check: 'hidden', awaitingReturn: true },
  }
  const left = engineBottom(on, { root: '/tmp/a/app', sessionId: 'sess-a' }, shared)
  await $.session.start({ cwd: '/tmp/a/app', surface: 'terminal', isInteractive: true })
  await $.command.run({ command: 'anchor', args: 'left goal · check: left check' } as never)

  // The engine's store is per test. A second test below covers the other session.
  expect(left.said.at(-1)).toBe('⚓ left goal → left check')
  expect(Object.keys(shared).includes('note/project-only')).toBe(true)
  expect(left.logged).toEqual([])
})

test('no session id explains the limit and does not read a project-only note', async ($, on) => {
  const store: Record<string, unknown> = {
    'note/project-only': { v: 1, goal: 'not yours', check: 'hidden', awaitingReturn: true },
  }
  const { said, logged } = engineBottom(on, { root: '/work/app', sessionId: undefined }, store)
  await $.session.start({ cwd: '/work/app', surface: 'terminal', isInteractive: true })
  const reply = await $.command.run({
    command: 'anchor',
    args: 'ship login fix · check: redirect works',
  } as never)

  expect(reply.text).toContain('no stable session id')
  expect(reply.text.includes('not yours')).toBe(false)
  expect(said.at(-1)).toBeUndefined()
  expect(Object.keys(store)).toEqual(['note/project-only'])
  expect(logged).toEqual([])
})
