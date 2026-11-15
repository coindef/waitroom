/**
 * Regressions for the OpenCode bet audit: digits, retry, kv hydration,
 * file forecasts, and the band repainting. Run with the track tests:
 *
 *   node --conditions=browser --experimental-strip-types --test bet-on-your-agent-opencode/tests/*.test.ts
 *
 * `--conditions=browser` selects solid-js's client build. Node's default
 * condition loads the server build, whose createEffect does nothing, and the
 * repaint test cannot see a band update.
 */

import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { spawn } from 'node:child_process'

import { createTestKeymap } from '@opentui/keymap/testing'
import { createRoot, createEffect } from 'solid-js'

import { changedSince, keepRecord } from '../../bet-on-your-agent/hooks/bet.ts'
import type { TurnRecord } from '../../bet-on-your-agent/types/index.ts'
import { createBandState } from '../plugin/band.ts'
import { registerBetKeys } from '../plugin/keys.ts'
import { noBet, type OpenBet } from '../plugin/open-bet.ts'
import {
  endsTurn,
  filesAfterMove,
  mergeTouched,
  notePart,
  pathsFromApplyPatch,
  statusStep,
} from '../plugin/track.ts'
import { createTurnLog, type TurnKv } from '../plugin/turns.ts'
import { scanWorktree } from '../plugin/worktree.ts'

const openBet = (patch: Partial<OpenBet> = {}): OpenBet => ({
  ...noBet(),
  turnId: 'turn-1',
  ask: 'fix the login',
  startedAt: 1,
  ...patch,
})

test('a retry leaves the open bet alone and only idle ends it', () => {
  assert.equal(endsTurn({ type: 'retry' }), false)
  assert.equal(endsTurn({ type: 'idle' }), true)
  assert.equal(endsTurn({ type: 'busy' }), false)

  let tracking = false
  let started = 0
  let finished = 0
  for (const type of ['busy', 'retry', 'busy', 'idle']) {
    const step = statusStep({ type }, tracking)
    if (step === 'start') {
      tracking = true
      started++
    }
    if (step === 'finish') {
      tracking = false
      finished++
    }
  }
  assert.equal(started, 1)
  assert.equal(finished, 1)
  assert.equal(tracking, false)
  assert.equal(statusStep({ type: 'retry' }, true), 'ignore')
  assert.equal(statusStep({ type: 'idle' }, true), 'finish')
})

type HostFile = Record<string, unknown>

/** The host kv the audit modeled: set snapshots memory and a later write uses that snapshot. */
const hostKv = (disk: HostFile) => {
  let memory: HostFile = {}
  let ready = false
  let sets = 0
  let queued: HostFile | undefined
  const kv: TurnKv & {
    sets: () => number
    hydrate: () => void
    file: () => HostFile
  } = {
    get ready() {
      return ready
    },
    get<T>(key: string, fallback?: T): T {
      return (memory[key] as T) ?? (fallback as T)
    },
    set(key: string, value: unknown) {
      sets++
      const snapshot = { ...memory, [key]: value }
      queued = snapshot
    },
    sets: () => sets,
    hydrate() {
      memory = { ...disk }
      ready = true
    },
    file() {
      return queued ?? { ...memory }
    },
  }
  return kv
}

const record = (turnId: string): TurnRecord => ({
  turnId,
  at: 1,
  durationMs: 1,
  files: 0,
  filesBucket: '0',
  toolCalls: 0,
  isAborted: false,
})

test('a save before kv.ready does not write, and the flush keeps every other key', () => {
  const disk: HostFile = {
    'other-plugin:prefs': { theme: 'dark' },
    'bet-on-your-agent:turns': [record('kept')],
  }
  const kv = hostKv(disk)
  const log = createTurnLog(kv)
  log.update(records => keepRecord(records, record('new')))
  assert.equal(kv.sets(), 0)

  kv.hydrate()
  assert.equal(log.flush(), true)
  const file = kv.file()
  assert.deepEqual(file['other-plugin:prefs'], { theme: 'dark' })
  const turns = file['bet-on-your-agent:turns'] as TurnRecord[]
  assert.deepEqual(
    turns.map(one => one.turnId),
    ['kept', 'new'],
  )
  assert.equal(log.flush(), true)
  assert.equal(kv.sets(), 1)
})

test('apply_patch paths come from the patch text, not a filePath field', () => {
  const paths = pathsFromApplyPatch(`*** Begin Patch
*** Add File: src/new.ts
+export const hi = 1
*** Update File: src/old.ts
*** Move to: src/renamed.ts
@@
-a
+b
*** Delete File: src/gone.ts
*** End Patch`)
  assert.deepEqual(paths, ['src/new.ts', 'src/old.ts', 'src/renamed.ts', 'src/gone.ts'])
})

test('a bash or apply_patch turn counts the files it touched, and so does a patch part', () => {
  const bet = { toolCalls: 0, files: [] as string[] }
  const bash = notePart(
    bet,
    { type: 'tool', id: 'b', tool: 'bash', state: { status: 'completed', input: { command: 'touch src/a.ts' } } },
    new Set(),
    ['src/a.ts', 'src/already.ts'],
    ['src/already.ts'],
  )
  assert.ok(bash)
  assert.equal(bash.toolCalls, 1)
  assert.deepEqual(bash.files, ['src/a.ts'])
  assert.equal(bash.scan, true)

  const patched = notePart(
    bet,
    {
      type: 'tool',
      id: 'p',
      tool: 'apply_patch',
      state: { status: 'completed', input: { patchText: '*** Update File: src/from-patch.ts\n' } },
    },
    new Set(),
    undefined,
    [],
  )
  assert.ok(patched)
  assert.deepEqual(patched.files, ['src/from-patch.ts'])

  const errored = notePart(
    bet,
    { type: 'tool', id: 'e', tool: 'bash', state: { status: 'error', input: { command: 'false' } } },
    new Set(),
    ['src/err.ts'],
    [],
  )
  assert.ok(errored)
  assert.equal(errored.toolCalls, 1)
  assert.deepEqual(errored.files, ['src/err.ts'])

  const part = notePart(bet, { type: 'patch', files: ['src/one.ts', 'src/two.ts'] }, new Set(), undefined, [])
  assert.ok(part)
  assert.equal(part.toolCalls, 0)
  assert.deepEqual(part.files, ['src/one.ts', 'src/two.ts'])
  assert.equal(part.scan, false)

  const running = notePart(
    bet,
    { type: 'tool', id: 'r', tool: 'bash', state: { status: 'running', input: { command: 'ls' } } },
    new Set(),
    ['src/a.ts'],
    [],
  )
  assert.equal(running, undefined)
})

test('a worktree scan after bash reports the file whose content moved', () => {
  const moved = changedSince({ 'src/a.ts': 'before' }, { 'src/a.ts': 'after', 'src/b.ts': 'new' })
  assert.deepEqual(filesAfterMove(['src/kept.ts'], moved), ['src/kept.ts', 'src/a.ts', 'src/b.ts'])
})

const git = (cwd: string, args: string[]) =>
  new Promise<void>((resolve, reject) => {
    const child = spawn('git', args, {
      cwd,
      stdio: ['ignore', 'ignore', 'ignore'],
      env: {
        ...process.env,
        GIT_CONFIG_GLOBAL: '/dev/null',
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_AUTHOR_NAME: 't',
        GIT_AUTHOR_EMAIL: 't@example.com',
        GIT_COMMITTER_NAME: 't',
        GIT_COMMITTER_EMAIL: 't@example.com',
      },
    })
    child.on('error', reject)
    child.on('close', code => (code === 0 ? resolve() : reject(new Error(`git ${args.join(' ')} -> ${code}`))))
  })

test('scanWorktree sees a file written after the baseline', async () => {
  const root = await mkdtemp(join(tmpdir(), 'bet-oc-'))
  try {
    await git(root, ['init'])
    await writeFile(join(root, 'kept.ts'), 'a\n')
    await git(root, ['add', 'kept.ts'])
    await git(root, ['commit', '-m', 'base', '--author', 't <t@example.com>'])
    const before = await scanWorktree(root)
    assert.ok(before)
    await writeFile(join(root, 'from-bash.ts'), 'b\n')
    const after = await scanWorktree(root)
    assert.ok(after)
    assert.deepEqual(changedSince(before, after), ['from-bash.ts'])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

type KeyActions = {
  bet: OpenBet
  owed?: string
  sessionID?: string
  calls: string[]
  /** Text already in the prompt before the next key. Absent means empty. */
  prompt?: string
}

const harnessFor = (state: KeyActions) => {
  const harness = createTestKeymap({ defaultKeys: true })
  const prompt = harness.host.createTarget('prompt')
  harness.root.append(prompt)
  harness.host.focus(prompt)
  registerBetKeys(harness.keymap, {
    sessionID: () => state.sessionID,
    bet: () => state.bet,
    owedTurnId: () => state.owed,
    promptText: () => state.prompt ?? '',
    placeConfidence: (_id, said) => {
      state.calls.push(`confidence:${said}`)
      state.bet = { ...state.bet, saidConfidence: said }
    },
    placeFiles: (_id, said) => {
      state.calls.push(`files:${said}`)
      state.bet = { ...state.bet, saidFiles: said }
    },
    decline: () => {
      state.calls.push('decline')
      state.bet = { ...state.bet, isDeclined: true }
    },
    placeBonus: (_id, said) => {
      state.calls.push(`bonus:${said}`)
      state.bet = { ...state.bet, saidBonus: said }
    },
    declineBonus: () => {
      state.calls.push('decline-bonus')
      state.bet = { ...state.bet, isBonusDeclined: true }
    },
    giveVerdict: (_id, turnId, landed) => {
      state.calls.push(`verdict:${turnId}:${landed}`)
    },
    waveVerdict: (_id, turnId) => {
      state.calls.push(`wave:${turnId}`)
    },
  })
  return harness
}

test('digits 0-5 are not consumed when no bet question is showing', () => {
  const state: KeyActions = { bet: noBet(), calls: [], sessionID: 's1' }
  const harness = harnessFor(state)
  try {
    for (const key of ['0', '1', '2', '3', '4', '5']) {
      const event = harness.host.press(key)
      assert.equal(event.defaultPrevented, false, key)
      assert.equal(event.propagationStopped, false, key)
    }
    assert.deepEqual(state.calls, [])

    state.sessionID = undefined
    state.bet = openBet()
    const offSession = harness.host.press('1')
    assert.equal(offSession.defaultPrevented, false)
    assert.deepEqual(state.calls, [])
  } finally {
    harness.cleanup()
  }
})

test('a digit that answers the question on screen is consumed, and one that does not is not', () => {
  const state: KeyActions = { bet: openBet(), calls: [], sessionID: 's1' }
  const harness = harnessFor(state)
  try {
    const confidence = harness.host.press('1')
    assert.equal(confidence.defaultPrevented, true)
    assert.equal(state.bet.saidConfidence, 0.5)

    const skipFiles = harness.host.press('0')
    assert.equal(skipFiles.defaultPrevented, true)
    assert.equal(state.bet.isDeclined, true)

    state.bet = openBet({ saidConfidence: 0.8, saidFiles: '1' })
    const duringStatus = harness.host.press('1')
    assert.equal(duringStatus.defaultPrevented, false)

    state.bet = noBet()
    state.owed = 'owed-1'
    const landed = harness.host.press('1')
    assert.equal(landed.defaultPrevented, true)
    assert.deepEqual(state.calls.at(-1), 'verdict:owed-1:true')
    const unused = harness.host.press('4')
    assert.equal(unused.defaultPrevented, false)
    const notSkip = harness.host.press('3')
    assert.equal(notSkip.defaultPrevented, false)
    const skip = harness.host.press('0')
    assert.equal(skip.defaultPrevented, true)
    assert.deepEqual(state.calls.at(-1), 'wave:owed-1')
  } finally {
    harness.cleanup()
  }
})

test('a sentence that contains digits reaches the prompt while each question is up', () => {
  const questions: { bet: OpenBet; owed?: string; text: string }[] = [
    { bet: openBet(), text: 'also bump node to 22 and retry 5 times' },
    { bet: openBet({ saidConfidence: 0.8 }), text: 'touch 1 file and then 0 more' },
    { bet: openBet({ saidConfidence: 0.8, saidFiles: '1', bonusDim: 'toolCalls' }), text: 'call tool 3 then skip with 0' },
    { bet: noBet(), owed: 'owed-1', text: 'fix issue 312 then add 3 tests' },
  ]

  for (const question of questions) {
    const state: KeyActions = {
      bet: question.bet,
      owed: question.owed,
      sessionID: 's1',
      calls: [],
      prompt: '',
    }
    const harness = harnessFor(state)
    try {
      for (const ch of question.text) {
        const event = harness.host.press(ch === ' ' ? 'space' : ch)
        assert.equal(event.defaultPrevented, false, `${JSON.stringify(ch)} in ${question.text}`)
        state.prompt += ch
      }
      assert.equal(state.prompt, question.text)
      assert.deepEqual(state.calls, [])
    } finally {
      harness.cleanup()
    }
  }
})

test('placing a confidence repaints the band', () => {
  const seen: string[] = []
  let band: ReturnType<typeof createBandState>
  const dispose = createRoot(done => {
    band = createBandState()
    createEffect(() => {
      const view = band.view('s1')
      if (view.bet.turnId === '') seen.push('empty')
      else if (view.bet.saidConfidence === undefined) seen.push('confidence')
      else if (view.bet.saidFiles === undefined) seen.push('files')
      else seen.push('placed')
    })

    return done
  })
  try {
    assert.equal(seen.at(-1), 'empty')
    band!.setOpen('s1', openBet())
    assert.equal(seen.at(-1), 'confidence')
    band!.setOpen('s1', openBet({ saidConfidence: 0.8 }))
    assert.equal(seen.at(-1), 'files')
    band!.setTurns([{ ...record('old'), saidConfidence: 0.9 }])
    band!.setOpen('s1', noBet())
    assert.equal(band!.view('s1').owed?.turnId, 'old')
    assert.deepEqual(seen, ['empty', 'confidence', 'files', 'files', 'empty'])
  } finally {
    dispose()
  }
})

test('mergeTouched keeps a path already counted', () => {
  assert.deepEqual(mergeTouched(['src/a.ts'], ['src/a.ts', 'src/b.ts']), ['src/a.ts', 'src/b.ts'])
})
