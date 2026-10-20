/**
 * Git scanning for the OpenCode adapter: no OpenCode types, no engine, so it
 * can be tested the same way `wait-review/hooks/diff.ts` is.
 *
 * Ported from `wait-review/hooks/register.tsx`'s `repoRoot`/`scanRepo`. The
 * logic is unchanged; only the git runner is injected rather than being
 * `$.process.run`, since a TUI plugin has no engine-sandboxed process API —
 * it runs as plain Node/Bun code and can shell out directly.
 */

import { isIgnored, parseDiff } from '../../wait-review/hooks/diff.ts'
import type { Hunk } from '../../wait-review/types/index.ts'

export type GitResult = { stdout: string; exitCode: number }
export type GitRunner = (argv: readonly string[], cwd: string) => Promise<GitResult | undefined>

export type ScanConfig = { contextLines: number; ignore: readonly string[] }

export type Scan = { hunks: Hunk[]; truncatedFiles: number }

/** Untracked files diffed one by one per scan, so a stray folder cannot stall it. */
export const UNTRACKED_LIMIT = 40

/** The repository root, or undefined where `cwd` is not in a repository. */
export const repoRoot = async (run: GitRunner, cwd: string): Promise<string | undefined> => {
  const found = await run(['rev-parse', '--show-toplevel'], cwd)
  const root = found?.exitCode === 0 ? found.stdout.trim() : ''

  return root === '' ? undefined : root
}

/**
 * Every hunk in the repository right now, against `anchor` (falling back to
 * `HEAD`, then to no base at all for a repository with no commits yet).
 */
export const scanRepo = async (
  run: GitRunner,
  root: string,
  anchor: string | null,
  config: ScanConfig,
): Promise<Scan> => {
  const unified = `--unified=${config.contextLines}`
  const found: Hunk[] = []

  let diff =
    anchor === null ? undefined : await run(['diff', anchor, '--no-color', '--no-prefix', unified], root)
  if (!diff || diff.exitCode !== 0) {
    diff = await run(['diff', 'HEAD', '--no-color', '--no-prefix', unified], root)
  }
  if (!diff || diff.exitCode !== 0) {
    diff = await run(['diff', '--no-color', '--no-prefix', unified], root)
  }
  if (diff?.exitCode === 0) found.push(...parseDiff(diff.stdout))

  // A file the agent created is untracked: no blob on either side, so plain
  // `git diff` says nothing about it at all.
  const others = await run(['ls-files', '--others', '--exclude-standard'], root)
  const reviewableUntracked = (others?.stdout ?? '')
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean)
    // Ignored before the cap, not after: see wait-review/hooks/register.tsx.
    .filter(path => !isIgnored(path, config.ignore))
  const untracked = reviewableUntracked.slice(0, UNTRACKED_LIMIT)
  for (const path of untracked) {
    const one = await run(
      ['diff', '--no-color', '--no-prefix', unified, '--no-index', '--', '/dev/null', path],
      root,
    )
    if (one && one.exitCode <= 1) found.push(...parseDiff(one.stdout))
  }

  return { hunks: found, truncatedFiles: reviewableUntracked.length - untracked.length }
}

/**
 * `HEAD` as it stands right now, to anchor a session the first time it is seen.
 *
 * There is no OpenCode event named `session.start`, so `plugin/tui.tsx` takes
 * this and the pre-existing-hunk snapshot the first time a session id turns
 * up at all (on its first `session.status` event), the same way the Claude
 * Code mod takes both once on its own `session.start`.
 */
export const currentHead = async (run: GitRunner, root: string): Promise<string | null> => {
  const found = await run(['rev-parse', 'HEAD'], root)

  return found?.exitCode === 0 ? found.stdout.trim() : null
}
