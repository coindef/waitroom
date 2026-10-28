import type { On } from 'claude-code'
import type { Engine } from 'claude-code/testing'
import { expect, test } from 'claude-code/testing'

import { FIRST_SESSION_TIP, TIP_SHOWN_KEY } from '../hooks/tip'

/**
 * Stands in for the engine beneath the mod, and keeps the store and the
 * transcript lines the mod writes so a test can read both back.
 */
const engineBottom = (on: On, saved = new Map<string, unknown>()) => {
  const logged: string[] = []
  on('session.start', ($, e) => ({ cwd: e.cwd }))
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
