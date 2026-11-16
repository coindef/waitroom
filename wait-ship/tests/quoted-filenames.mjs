/**
 * Real git, not the engine's stand-in. `claude plugin test` cannot import
 * node builtins, so this file is run with node. It uses the same argv the
 * scan in hooks/register.tsx uses.
 */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import {
  commitFileText,
  fingerprintOf,
  kitOf,
  parseDiffFiles,
  readDiff,
  splitNul,
  TRACKED_DIFF_ARGS,
  UNTRACKED_LIST_ARGS,
  untrackedDiffArgs,
} from '../hooks/ship.ts'

const CAFE = 'café.txt'
const QUOTED = 'a "quoted" name.txt'
const NAIVE = 'naïve.txt'

/** Git's own defaults: the harness injects core.quotePath=false, which hides this bug. */
const gitEnv = () => {
  const env = { ...process.env }
  for (const key of Object.keys(env)) {
    if (key.startsWith('GIT_CONFIG_')) delete env[key]
  }
  env.GIT_CONFIG_GLOBAL = '/dev/null'
  env.GIT_CONFIG_NOSYSTEM = '1'

  return env
}

const git = (cwd, args) => {
  const result = spawnSync('git', args, { cwd, env: gitEnv(), encoding: 'utf8' })

  return { status: result.status ?? -1, stdout: result.stdout ?? '' }
}

test('an untracked café.txt and a quoted name stay in the kit and the fingerprint', () => {
  const dir = mkdtempSync(join(tmpdir(), 'wait-ship-quote-'))
  try {
    assert.equal(git(dir, ['init', '-q']).status, 0)
    writeFileSync(join(dir, NAIVE), 'naive\n')
    const id = ['-c', 'user.email=t@example.com', '-c', 'user.name=t']
    assert.equal(git(dir, [...id, 'add', '--', NAIVE]).status, 0)
    assert.equal(git(dir, [...id, 'commit', '-qm', 'init']).status, 0)
    writeFileSync(join(dir, NAIVE), 'naive\nchanged\n')
    writeFileSync(join(dir, CAFE), 'cafe line\n')
    writeFileSync(join(dir, QUOTED), 'quoted line\n')

    const tracked = git(dir, [...TRACKED_DIFF_ARGS])
    const trackedText = readDiff(tracked.status, tracked.stdout)
    assert.equal(tracked.status, 0)
    assert.ok(trackedText)
    const chunks = [trackedText]

    const others = git(dir, [...UNTRACKED_LIST_ARGS])
    assert.equal(others.status, 0)
    const names = splitNul(others.stdout)
    assert.deepEqual(names, [QUOTED, CAFE])
    for (const path of names) {
      const one = git(dir, untrackedDiffArgs(path))
      const text = readDiff(one.status, one.stdout)
      assert.ok(text, path)
      chunks.push(text)
    }

    const missing = git(dir, untrackedDiffArgs('missing.txt'))
    assert.notEqual(missing.status, 0)
    assert.equal(missing.stdout, '')
    assert.equal(readDiff(missing.status, missing.stdout), undefined)

    const text = chunks.join('\n')
    const files = parseDiffFiles(text)
    assert.deepEqual(
      files.map(one => one.path),
      [NAIVE, QUOTED, CAFE],
    )
    const commit = commitFileText(kitOf(files, [], undefined).commit)
    assert.ok(commit.includes(CAFE))
    assert.ok(commit.includes(QUOTED))
    assert.ok(commit.includes(NAIVE))
    assert.equal(commit.includes('\\303'), false)
    assert.notEqual(fingerprintOf(text), fingerprintOf(''))
    assert.ok(text.includes(CAFE))
    assert.ok(text.includes(QUOTED) || text.includes(QUOTED.replaceAll('"', '\\"')))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
