import { expect, test } from 'claude-code/testing'

import { dollarPassProblems, topLevelHelpers } from '../hooks/load-shape'
import { register } from '../hooks/register'

/**
 * The hooks module Claude Code 2.1.318 refused to load. Compiled line 109 was
 * `await remind($, e)`, and `remind` was declared inside `register`.
 */
const NESTED_REMIND = `
const load = async ($: EngineInterface) => {
  return $.store.get('k')
}
export const register = on => {
  const remind = async ($: EngineInterface, prompt) => {
    await load($)
  }
  on('prompt.submit', async ($, e, next) => {
    await remind($, e)
    return next(e)
  })
}
`

const TOP_LEVEL_REMIND = `
const load = async ($: EngineInterface) => {
  return $.store.get('k')
}
const remind = async ($: EngineInterface, prompt, claim) => {
  await load($)
}
export const register = on => {
  on('prompt.submit', async ($, e, next) => {
    await remind($, e, claim)
    return next(e)
  })
}
`

test('a helper nested inside register that is passed $ is the load failure', () => {
  expect(dollarPassProblems(NESTED_REMIND)).toEqual(['remind'])
  expect(topLevelHelpers(NESTED_REMIND).has('load')).toBe(true)
  expect(topLevelHelpers(NESTED_REMIND).has('remind')).toBe(false)
})

test('a top-level remind that is passed $ is allowed', () => {
  expect(dollarPassProblems(TOP_LEVEL_REMIND)).toEqual([])
  expect(topLevelHelpers(TOP_LEVEL_REMIND).has('remind')).toBe(true)
})

test('register declares no helper that takes $; each one is top level', () => {
  const body = Function.prototype.toString.call(register)

  expect(/(?:const|let)\s+\w+\s*=\s*(?:async\s*)?\(\s*\$/.test(body)).toBe(false)
  expect(/function\s+\w+\s*\(\s*\$/.test(body)).toBe(false)
  expect(body.includes('ask($')).toBe(true)
})
