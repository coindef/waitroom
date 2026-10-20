/**
 * `plugin/scan.ts` has no OpenCode types, so it runs under Node's own test
 * runner rather than `claude plugin test` (which is specific to the Claude
 * Code mods next to this one). Run with:
 *
 *   node --experimental-strip-types --test wait-review-opencode/tests/scan.test.ts
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { currentHead, repoRoot, scanRepo, type GitResult, type GitRunner } from '../plugin/scan.ts'

const ok = (stdout: string): GitResult => ({ stdout, exitCode: 0 })

const routed =
  (table: Record<string, GitResult | undefined>): GitRunner =>
  async argv => {
    const key = argv.join(' ')
    if (!(key in table)) throw new Error(`unexpected git invocation: git ${key}`)

    return table[key]
  }

test('the repository root is the trimmed stdout of a clean rev-parse', async () => {
  const run = routed({ 'rev-parse --show-toplevel': ok('/repo\n') })
  assert.equal(await repoRoot(run, '/repo/sub'), '/repo')
})

test('no repository root where rev-parse fails', async () => {
  const run = routed({ 'rev-parse --show-toplevel': { stdout: '', exitCode: 128 } })
  assert.equal(await repoRoot(run, '/tmp'), undefined)
})

test('the current HEAD sha is read straight off rev-parse', async () => {
  const run = routed({ 'rev-parse HEAD': ok('abc123\n'), 'ls-files --others --exclude-standard': ok('') })
  assert.equal(await currentHead(run, '/repo'), 'abc123')
})

test('a repository with no commits yields no HEAD rather than throwing', async () => {
  const run = routed({ 'rev-parse HEAD': { stdout: '', exitCode: 128 } })
  assert.equal(await currentHead(run, '/repo'), null)
})

test('a scan against a resolving anchor never falls back to HEAD', async () => {
  const diff = 'diff --git a/x.ts b/x.ts\n--- x.ts\n+++ x.ts\n@@ -1,1 +1,2 @@\n a\n+b\n'
  const run = routed({
    'diff abc123 --no-color --no-prefix --unified=3': ok(diff),
    'ls-files --others --exclude-standard': ok(''),
  })
  const found = await scanRepo(run, '/repo', 'abc123', { contextLines: 3, ignore: [] })
  assert.equal(found.hunks.length, 1)
  assert.equal(found.hunks[0]?.path, 'x.ts')
})

test('an anchor that no longer resolves falls back to HEAD, then to no base', async () => {
  const diff = 'diff --git a/x.ts b/x.ts\n--- x.ts\n+++ x.ts\n@@ -1,1 +1,2 @@\n a\n+b\n'
  const run = routed({
    'diff stale --no-color --no-prefix --unified=3': { stdout: '', exitCode: 128 },
    'diff HEAD --no-color --no-prefix --unified=3': ok(diff),
    'ls-files --others --exclude-standard': ok(''),
  })
  const found = await scanRepo(run, '/repo', 'stale', { contextLines: 3, ignore: [] })
  assert.equal(found.hunks.length, 1)
})

test('a repository with no commits falls all the way to a bare diff', async () => {
  const diff = 'diff --git a/x.ts b/x.ts\n--- x.ts\n+++ x.ts\n@@ -1,1 +1,2 @@\n a\n+b\n'
  const run = routed({
    'diff HEAD --no-color --no-prefix --unified=3': { stdout: '', exitCode: 128 },
    'diff --no-color --no-prefix --unified=3': ok(diff),
    'ls-files --others --exclude-standard': ok(''),
  })
  const found = await scanRepo(run, '/repo', null, { contextLines: 3, ignore: [] })
  assert.equal(found.hunks.length, 1)
})

test('untracked files are ignored before the cap, not after', async () => {
  const run = routed({
    'diff missing --no-color --no-prefix --unified=3': { stdout: '', exitCode: 128 },
    'diff HEAD --no-color --no-prefix --unified=3': ok(''),
    'ls-files --others --exclude-standard': ok('build/out.js\nsrc/new.ts\n'),
    'diff --no-color --no-prefix --unified=3 --no-index -- /dev/null src/new.ts': ok(
      'diff --git a/src/new.ts b/src/new.ts\n--- /dev/null\n+++ src/new.ts\n@@ -0,0 +1,1 @@\n+hi\n',
    ),
  })
  const found = await scanRepo(run, '/repo', 'missing', { contextLines: 3, ignore: ['**/build/**'] })
  assert.equal(found.hunks.length, 1)
  assert.equal(found.hunks[0]?.path, 'src/new.ts')
  assert.equal(found.truncatedFiles, 0)
})

test('a scan truncated by the untracked cap reports how many it left out', async () => {
  const names = Array.from({ length: 45 }, (_, at) => `file${at}.ts`)
  const table: Record<string, GitResult | undefined> = {
    'diff missing --no-color --no-prefix --unified=3': { stdout: '', exitCode: 128 },
    'diff HEAD --no-color --no-prefix --unified=3': ok(''),
    'ls-files --others --exclude-standard': ok(names.join('\n')),
  }
  for (const name of names.slice(0, 40)) {
    table[`diff --no-color --no-prefix --unified=3 --no-index -- /dev/null ${name}`] = ok('')
  }
  const run = routed(table)
  const found = await scanRepo(run, '/repo', 'missing', { contextLines: 3, ignore: [] })
  assert.equal(found.truncatedFiles, 5)
})
