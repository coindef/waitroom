/**
 * SIMULATED HOST FIXTURE. These tests drive `register` without Claude Code.
 * `claude plugin test` is the engine run, in `flow.test.ts`, and it was not
 * executed in the environment that added this mod.
 */

import { expect, test } from 'claude-code/testing'

import { install } from '../demo/host'

const person = (text: string) => ({ text, origin: { kind: 'composer' } })

const start = async (host: ReturnType<typeof install>) => {
  await host.dispatch('session.start', { cwd: '/work', surface: 'terminal', isInteractive: true })
}

test('set, show, replace, and clear on the simulated host', async () => {
  const host = install({ root: '/work/app', sessionId: 'sess-a' })
  await start(host)

  const set = (await host.dispatch('command.run', {
    command: 'anchor',
    args: 'ship login fix · check: redirect works',
  })) as { text: string }

  expect(set.text).toBe('ship login fix · check: redirect works')
  expect(host.status.at(-1)).toBe('⚓ ship login fix → redirect works')

  const shown = (await host.dispatch('command.run', { command: 'anchor', args: '' })) as { text: string }
  expect(shown.text).toBe('ship login fix · check: redirect works')

  const replaced = (await host.dispatch('command.run', {
    command: 'anchor',
    args: 'ship logout · check: session ends',
  })) as { text: string }
  expect(replaced.text).toBe('ship logout · check: session ends')
  expect(host.status.at(-1)).toBe('⚓ ship logout → session ends')

  const cleared = (await host.dispatch('command.run', { command: 'anchor', args: 'clear' })) as { text: string }
  expect(cleared.text).toBe('cleared')
  expect(host.status.at(-1)).toBeUndefined()
  expect(host.store.size).toBe(0)
  expect(host.calls).toEqual({ http: 0, model: 0, messages: 0 })
  expect(host.prompts).toEqual([])
})

test('Stop then the first prompt reminds you once, and a second register on the same store still has the note', async () => {
  const store = new Map<string, unknown>()
  const first = install({ root: '/work/app', sessionId: 'sess-a', store })
  await start(first)
  await first.dispatch('command.run', {
    command: 'anchor',
    args: 'ship login fix · check: redirect works',
  })
  await first.dispatch('turn.complete', { turnId: 'turn-1', isAborted: true })
  expect(first.logs).toEqual([])

  // A second register() on the same store: the note is still there, and startup does not log.
  // A separate OS process is what demo/leave-and-return.ts runs.
  const resumed = install({ root: '/work/app', sessionId: 'sess-a', store })
  await start(resumed)
  expect(resumed.logs).toEqual([])
  expect(resumed.status.at(-1)).toBe('⚓ ship login fix → redirect works')

  const prompt = person('where was I')
  const returned = await resumed.dispatch('prompt.submit', prompt)
  expect(returned).toEqual(prompt)
  expect(resumed.logs).toEqual(['Back? You said: redirect works.'])

  await resumed.dispatch('prompt.submit', person('and now'))
  expect(resumed.logs).toEqual(['Back? You said: redirect works.'])
  expect(resumed.prompts).toEqual([])
  expect(resumed.calls).toEqual({ http: 0, model: 0, messages: 0 })
})

test('two prompts at once after Stop log the reminder once', async () => {
  const host = install({ root: '/work/app', sessionId: 'sess-a' })
  await start(host)
  await host.dispatch('command.run', {
    command: 'anchor',
    args: 'ship login fix · check: redirect works',
  })
  await host.dispatch('turn.complete', { turnId: 'turn-1' })

  await Promise.all([
    host.dispatch('prompt.submit', person('one')),
    host.dispatch('prompt.submit', person('two')),
  ])

  expect(host.logs).toEqual(['Back? You said: redirect works.'])
})

test('a subagent turn and a task notice do not spend the reminder', async () => {
  const host = install({ root: '/work/app', sessionId: 'sess-a' })
  await start(host)
  await host.dispatch('command.run', {
    command: 'anchor',
    args: 'ship login fix · check: redirect works',
  })
  await host.dispatch('turn.complete', { turnId: 'sub-1', agentId: 'worker' })
  await host.dispatch('prompt.submit', person('still working'))
  expect(host.logs).toEqual([])

  await host.dispatch('turn.complete', { turnId: 'turn-1', isAborted: true })
  await host.dispatch('prompt.submit', { text: 'done', origin: { kind: 'task-notification' } })
  expect(host.logs).toEqual([])
  await host.dispatch('prompt.submit', person('back'))
  expect(host.logs).toEqual(['Back? You said: redirect works.'])
})

test('two sessions and two directories named app do not read each other', async () => {
  const store = new Map<string, unknown>()
  const left = install({ root: '/tmp/a/app', sessionId: 'sess-a', store })
  const right = install({ root: '/tmp/b/app', sessionId: 'sess-b', store })
  await start(left)
  await start(right)
  await left.dispatch('command.run', { command: 'anchor', args: 'left goal · check: left check' })
  await right.dispatch('command.run', { command: 'anchor', args: 'right goal · check: right check' })

  const shownLeft = (await left.dispatch('command.run', { command: 'anchor', args: '' })) as { text: string }
  const shownRight = (await right.dispatch('command.run', { command: 'anchor', args: '' })) as { text: string }

  expect(shownLeft.text).toBe('left goal · check: left check')
  expect(shownRight.text).toBe('right goal · check: right check')
  expect(store.size).toBe(2)
  expect(left.status.at(-1)).toBe('⚓ left goal → left check')
  expect(right.status.at(-1)).toBe('⚓ right goal → right check')
})

test('a missing session id saves nothing and does not show a project-only note', async () => {
  const store = new Map<string, unknown>([
    ['note/project-only', { v: 1, goal: 'not yours', check: 'hidden', awaitingReturn: true }],
  ])
  const host = install({ root: '/work/app', store })
  await start(host)
  const reply = (await host.dispatch('command.run', {
    command: 'anchor',
    args: 'ship login fix · check: redirect works',
  })) as { text: string }

  expect(reply.text).toContain('no stable session id')
  expect(reply.text).toContain('nothing was saved')
  expect(reply.text.includes('not yours')).toBe(false)
  expect(reply.text.includes('hidden')).toBe(false)
  expect(host.status.at(-1)).toBeUndefined()
  expect(store.size).toBe(1)
  expect(host.logs).toEqual([])
})

test('a missing project root saves nothing', async () => {
  const store = new Map<string, unknown>()
  const host = install({ sessionId: 'sess-a', store })
  await start(host)
  const reply = (await host.dispatch('command.run', {
    command: 'anchor',
    args: 'ship login fix · check: redirect works',
  })) as { text: string }

  expect(reply.text).toContain('no project root')
  expect(store.size).toBe(0)
  expect(host.status.at(-1)).toBeUndefined()
})

test('a failed save does not show the return line, and the next prompt can still show it once', async () => {
  const store = new Map<string, unknown>()
  const host = install({ root: '/work/app', sessionId: 'sess-a', store })
  await start(host)
  await host.dispatch('command.run', {
    command: 'anchor',
    args: 'ship login fix · check: redirect works',
  })
  await host.dispatch('turn.complete', { turnId: 'turn-1', isAborted: true })
  host.order.length = 0
  host.fail.sets = 1

  const prompt = person('where was I')
  const returned = await host.dispatch('prompt.submit', prompt)

  expect(returned).toEqual(prompt)
  expect(host.logs).toEqual([])
  expect(host.order.includes('log')).toBe(false)
  expect(host.order[0]).toBe('set')
  // `.catch` reads next.error and returns next(e). The error does not leave dispatch.
  expect(host.recovered.count).toBe(1)
  expect(host.errorReads.count).toBeGreaterThanOrEqual(1)
  expect(typeof host.failures[0]).toBe('object')
  expect(host.failures[0]?.message).toBe('store set failed')
  const kept = [...store.values()][0] as { awaitingReturn?: boolean }
  expect(kept.awaitingReturn).toBe(true)

  const again = await host.dispatch('prompt.submit', person('still here'))
  expect(again).toEqual(person('still here'))
  expect(host.logs).toEqual(['Back? You said: redirect works.'])
  const setAt = host.order.lastIndexOf('set')
  const logAt = host.order.lastIndexOf('log')
  expect(setAt < logAt).toBe(true)
  expect(host.recovered.count).toBe(1)
})

test('an empty anchor prints the help and draws no status line', async () => {
  const host = install({ root: '/work/app', sessionId: 'sess-a' })
  await start(host)
  const reply = (await host.dispatch('command.run', { command: 'anchor' })) as { text: string }

  expect(reply.text).toBe("/anchor what you're doing · check: what to verify")
  expect(host.status.at(-1)).toBeUndefined()
})
