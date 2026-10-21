/**
 * `plugin/track.ts` has no OpenCode types, so it runs under Node's own test
 * runner rather than `claude plugin test`. Run with:
 *
 *   node --experimental-strip-types --test bet-on-your-agent-opencode/tests/track.test.ts
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { askFrom, filePathOf, isBusy, isNewCompletion } from '../plugin/track.ts'

test('a session is busy only when its status says so', () => {
  assert.equal(isBusy({ type: 'busy' }), true)
  assert.equal(isBusy({ type: 'idle' }), false)
  assert.equal(isBusy({ type: 'retry' }), false)
})

test('a completed edit names the file it touched', () => {
  const path = filePathOf({ id: '1', tool: 'edit', state: { status: 'completed', input: { filePath: 'src/a.ts' } } })
  assert.equal(path, 'src/a.ts')
})

test('a completed write names the file it touched', () => {
  const path = filePathOf({ id: '2', tool: 'write', state: { status: 'completed', input: { filePath: 'src/b.ts' } } })
  assert.equal(path, 'src/b.ts')
})

test('a tool call still running names no file yet', () => {
  const path = filePathOf({ id: '3', tool: 'edit', state: { status: 'running', input: { filePath: 'src/a.ts' } } })
  assert.equal(path, undefined)
})

test('a tool that does not touch a single file names none', () => {
  const path = filePathOf({ id: '4', tool: 'bash', state: { status: 'completed', input: { command: 'ls' } } })
  assert.equal(path, undefined)
})

test('apply_patch is left unparsed on purpose, not read as a bare path', () => {
  const path = filePathOf({ id: '5', tool: 'apply_patch', state: { status: 'completed', input: { patchText: '...' } } })
  assert.equal(path, undefined)
})

test('a tool part counts the first time it completes', () => {
  const counted = new Set<string>()
  assert.equal(isNewCompletion({ id: 'a', tool: 'bash', state: { status: 'completed' } }, counted), true)
})

test('a tool part already counted does not count again', () => {
  const counted = new Set(['a'])
  assert.equal(isNewCompletion({ id: 'a', tool: 'bash', state: { status: 'completed' } }, counted), false)
})

test('a tool part still running or pending does not count yet', () => {
  const counted = new Set<string>()
  assert.equal(isNewCompletion({ id: 'a', tool: 'bash', state: { status: 'running' } }, counted), false)
  assert.equal(isNewCompletion({ id: 'a', tool: 'bash', state: { status: 'pending' } }, counted), false)
})

test('a user message is flattened from its text parts, in order', () => {
  const ask = askFrom([
    { type: 'text', text: 'add the ' },
    { type: 'file', text: 'ignored' },
    { type: 'text', text: 'retry logic' },
  ])
  assert.equal(ask, 'add the  retry logic')
})

test('a message with no text parts asks nothing', () => {
  assert.equal(askFrom([{ type: 'file' }]), '')
})
