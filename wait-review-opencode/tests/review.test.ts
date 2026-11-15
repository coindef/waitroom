/**
 * Key handling, pane repaint, and the first-turn snapshot.
 *
 * `plugin/review.ts` has no OpenCode types. The keymap cases dispatch real
 * key events through `@opentui/keymap@0.9.0` (the library OpenCode 1.19
 * embeds, including `registerEnabledFields` from `createDefaultOpenTuiKeymap`).
 * The snapshot case uses real git.
 *
 *   node --conditions=browser --experimental-strip-types --test wait-review-opencode/tests/review.test.ts
 *
 * `--conditions=browser` selects solid-js's client build. Node's default
 * condition loads `dist/server.js`, which renders once and does not track.
 * OpenCode's solid plugin swaps that server file for the client build, so
 * the test has to ask for the same one.
 */

import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { promisify } from 'node:util'

import { registerEnabledFields } from '@opentui/keymap/addons'
import { createTestKeymap, type TestKeymapEvent, type TestKeymapHarness } from '@opentui/keymap/testing'
import { createEffect, createRoot } from 'solid-js'

import { createReview, reviewLayer, type Review, type ReviewCommand } from '../plugin/review.ts'
import type { GitResult, GitRunner } from '../plugin/scan.ts'

const exec = promisify(execFile)

const ok = (stdout: string): GitResult => ({ stdout, exitCode: 0 })

const KEYS = ['o', 'f', 'l', 'x', 'u'] as const

const added = (path: string, line: string): string =>
  [`diff --git a/${path} b/${path}`, '--- /dev/null', `+++ ${path}`, '@@ -0,0 +1,1 @@', `+${line}`, ''].join('\n')

const TWO = [added('a.ts', 'b').trimEnd(), added('b.ts', 'd').trimEnd(), ''].join('\n')

type Phase = 'baseline' | 'turn'

/** A git stand-in: the baseline diff, then whatever the turn wrote. */
const phased = (turn: string): { run: GitRunner; wrote: () => void } => {
  let phase: Phase = 'baseline'
  const run: GitRunner = async argv => {
    const [cmd, sub] = argv
    if (cmd === 'rev-parse' && sub === '--show-toplevel') return ok('/repo\n')
    if (cmd === 'rev-parse' && sub === 'HEAD') return ok('abc\n')
    if (cmd === 'ls-files') return ok('')
    if (cmd === 'diff') return ok(phase === 'baseline' ? '' : turn)
    throw new Error(`unexpected git invocation: git ${argv.join(' ')}`)
  }

  return { run, wrote: () => (phase = 'turn') }
}

const sessionReview = async (turn: string, active: () => string | undefined = () => 'ses'): Promise<Review> => {
  const git = phased(turn)
  const review = createReview({ run: git.run, worktree: '/repo', activeSessionId: active })
  await review.ready()
  git.wrote()
  await review.busy('ses')
  await review.idle('ses')

  return review
}

const attach = (review: Review, registerEnabled: boolean): TestKeymapHarness => {
  // OpenCode builds its keymap with `registerDefaultKeys` (so `o` parses)
  // and `registerEnabledFields` (so a layer `enabled` function is consulted
  // on each key). `createDefaultOpenTuiKeymap` does both.
  const harness = createTestKeymap({ defaultKeys: true })
  if (registerEnabled) registerEnabledFields(harness.keymap)
  const prompt = harness.host.createTarget('prompt')
  harness.root.append(prompt)
  harness.host.focus(prompt)
  harness.keymap.registerLayer(reviewLayer(review))

  return harness
}

const press = (harness: TestKeymapHarness, key: string): TestKeymapEvent => harness.host.press(key)

const assertPassedThrough = (event: TestKeymapEvent, key: string): void => {
  assert.equal(event.defaultPrevented, false, `${key} was consumed`)
  assert.equal(event.propagationStopped, false, `${key} stopped propagation`)
}

const assertConsumed = (event: TestKeymapEvent, key: string): void => {
  assert.equal(event.defaultPrevented, true, `${key} reached the prompt`)
  assert.equal(event.propagationStopped, true, `${key} kept propagating`)
}

test('OC-2: with no hunk on screen, o/f/l/x/u are not handled and reach the prompt', async () => {
  const review = await sessionReview('')
  assert.equal(review.layerEnabled(), false)
  for (const key of KEYS) assert.equal(review.command(key as ReviewCommand), false)

  for (const registerEnabled of [true, false]) {
    const harness = attach(review, registerEnabled)
    for (const key of KEYS) assertPassedThrough(press(harness, key), key)
    harness.cleanup()
  }
})

test('OC-2: off the session screen a queued hunk does not take o/f/l/x/u', async () => {
  let onSession = true
  const review = await sessionReview(added('new.ts', 'hi'), () => (onSession ? 'ses' : undefined))
  assert.equal(review.pane('ses').showing, true)
  onSession = false
  assert.equal(review.layerEnabled(), false)

  const harness = attach(review, true)
  for (const key of KEYS) {
    assert.equal(review.command(key as ReviewCommand), false)
    assertPassedThrough(press(harness, key), key)
  }
  assert.equal(review.pane('ses').showing, true)
  harness.cleanup()
})

test('OC-2: a showing hunk takes o/f/l/x, and u only when there is something to undo', async () => {
  const review = await sessionReview(TWO)
  const before = review.pane('ses')
  assert.equal(before.showing, true)
  if (!before.showing) return
  assert.equal(before.path, 'a.ts')
  assert.equal(review.layerEnabled(), true)
  assert.equal(review.command('undo'), false)

  const harness = attach(review, true)
  assertPassedThrough(press(harness, 'u'), 'u')
  const held = review.pane('ses')
  assert.equal(held.showing, true)
  if (held.showing) assert.equal(held.path, 'a.ts')

  assertConsumed(press(harness, 'o'), 'o')
  const next = review.pane('ses')
  assert.equal(next.showing, true)
  if (next.showing) assert.equal(next.path, 'b.ts')

  assertConsumed(press(harness, 'u'), 'u')
  const restored = review.pane('ses')
  assert.equal(restored.showing, true)
  if (restored.showing) assert.equal(restored.path, 'a.ts')

  assertConsumed(press(harness, 'f'), 'f')
  assertConsumed(press(harness, 'l'), 'l')
  const last = review.pane('ses')
  assert.equal(last.showing, true)
  if (last.showing) assert.equal(last.path, 'b.ts')
  assertConsumed(press(harness, 'x'), 'x')
  assert.equal(review.pane('ses').showing, false)
  // Skip-file clears the stored decision, so `u` is not handled once the pane is empty.
  assert.equal(review.command('undo'), false)
  assertPassedThrough(press(harness, 'u'), 'u')
  harness.cleanup()
})

test('OC-6: the pane repaints when a scan finishes and when a key decides a hunk', async () => {
  const git = phased(added('new.ts', 'hi'))
  const review = createReview({ run: git.run, worktree: '/repo', activeSessionId: () => 'ses' })
  await review.ready()

  let runs = 0
  let path = ''
  let showing = false
  const dispose = createRoot(done => {
    createEffect(() => {
      runs += 1
      const view = review.pane('ses')
      showing = view.showing
      path = view.showing ? view.path : ''
    })

    return done
  })

  const painted = runs
  assert.equal(showing, false)
  git.wrote()
  await review.busy('ses')
  await review.idle('ses')
  assert.ok(runs > painted, 'a finished scan did not repaint')
  assert.equal(showing, true)
  assert.equal(path, 'new.ts')

  const decided = runs
  assert.equal(review.command('ok'), true)
  assert.ok(runs > decided, 'a keypress did not repaint')
  assert.equal(showing, false)
  dispose()
})

test('OC-7: an idle that arrives while the baseline git is still running still shows the turn', async () => {
  let release = (): void => {}
  const gate = new Promise<void>(resolve => {
    release = resolve
  })
  let diffs = 0
  const run: GitRunner = async argv => {
    const [cmd, sub] = argv
    if (cmd === 'rev-parse' && sub === '--show-toplevel') return ok('/repo\n')
    if (cmd === 'rev-parse' && sub === 'HEAD') return ok('abc\n')
    if (cmd === 'ls-files') return ok('')
    if (cmd === 'diff') {
      diffs += 1
      if (diffs === 1) {
        await gate
        return ok('')
      }
      return ok(added('new.ts', 'hi'))
    }
    throw new Error(`unexpected git invocation: git ${argv.join(' ')}`)
  }

  const review = createReview({ run, worktree: '/repo', activeSessionId: () => 'ses' })
  const busy = review.busy('ses')
  const idle = review.idle('ses')
  release()
  await busy
  await idle
  const view = review.pane('ses')
  assert.equal(view.showing, true)
  if (view.showing) assert.equal(view.path, 'new.ts')
})

const gitEnv = (): NodeJS.ProcessEnv => {
  const env: NodeJS.ProcessEnv = { ...process.env }
  for (const key of Object.keys(env)) {
    if (key === 'GIT_CONFIG_COUNT' || key.startsWith('GIT_CONFIG_KEY_') || key.startsWith('GIT_CONFIG_VALUE_')) {
      delete env[key]
    }
  }
  env.GIT_CONFIG_GLOBAL = '/dev/null'
  env.GIT_CONFIG_NOSYSTEM = '1'
  env.GIT_AUTHOR_NAME = 'wait-review'
  env.GIT_AUTHOR_EMAIL = 'wait-review@example.com'
  env.GIT_COMMITTER_NAME = 'wait-review'
  env.GIT_COMMITTER_EMAIL = 'wait-review@example.com'

  return env
}

const git = (cwd: string, args: readonly string[]): Promise<void> =>
  exec('git', args as string[], { cwd, env: gitEnv(), encoding: 'utf8' }).then(() => undefined)

const realGit: GitRunner = (argv, cwd) =>
  new Promise(resolve => {
    exec('git', argv as string[], { cwd, env: gitEnv(), encoding: 'utf8' })
      .then(({ stdout }) => resolve({ stdout, exitCode: 0 }))
      .catch((error: { stdout?: string; code?: number }) =>
        resolve({ stdout: error.stdout ?? '', exitCode: typeof error.code === 'number' ? error.code : 1 }),
      )
  })

test('OC-7: real git shows the first turn and not the dirt that was already there', async () => {
  const root = await mkdtemp(join(tmpdir(), 'wait-review-'))
  try {
    await git(root, ['init', '-b', 'main'])
    await writeFile(join(root, 'old.ts'), 'one\n')
    await git(root, ['add', 'old.ts'])
    await git(root, ['commit', '-m', 'init'])
    await writeFile(join(root, 'old.ts'), 'one\ntwo\n')

    const review = createReview({ run: realGit, worktree: root, activeSessionId: () => 'ses' })
    await review.ready()
    await writeFile(join(root, 'new.ts'), 'hi\n')
    await review.busy('ses')
    await review.idle('ses')

    const view = review.pane('ses')
    assert.equal(view.showing, true)
    if (!view.showing) return
    assert.equal(view.path, 'new.ts')
    assert.equal(review.command('ok'), true)
    assert.equal(review.pane('ses').showing, false)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
