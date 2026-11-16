import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { ArtifactKind, ShipMode, ShipOffer, ShipResult } from '../types'
import {
  commitFileText,
  DRAFTS_GITIGNORE,
  draftAbsolute,
  drawnBy,
  filesSince,
  rowsKept,
  formatSize,
  isOwnFolder,
  isUnder,
  kitOf,
  parseDiffFiles,
  parseSubjects,
  pathFromCwd,
  readDiff,
  receiptLines,
  seenFrom,
  skippedLine,
  splitNul,
  TRACKED_DIFF_ARGS,
  treeSeenOf,
  UNTRACKED_LIST_ARGS,
  untrackedDiffArgs,
  writtenRelative,
  yieldsBand,
  type TreeSeen,
} from './ship'

const PANE_TAG = ' ship '
const DEFAULT_SHIP_DIR = '.waitroom/ship'
const CHANGELOG_NAME = 'CHANGELOG.md'
const RECENT_COMMIT_COUNT = 20
/** Untracked files diffed one by one per scan, so a stray folder cannot stall it. */
const UNTRACKED_LIMIT = 100

const offer = atom({ plugin: 'wait-ship', key: 'offer' } as const, null as ShipOffer | null)
const lastSeen = atom({ plugin: 'wait-ship', key: 'lastSeen' } as const, null as TreeSeen | string | null)

/** How long a turn-start snapshot may run before it is unknown and the turn starts. */
const SNAPSHOT_CAP_MS = 4000

/**
 * Timers are not in this mod's `es2023` lib. The snapshot cap only needs a
 * handle it can clear. These stay local so the DOM lib is not pulled in.
 */
type TimeoutHandle = number
declare function setTimeout(callback: () => void, delayMs: number): TimeoutHandle
declare function clearTimeout(handle: TimeoutHandle | undefined): void

type Config = { enabled: boolean; shipDir: string; includeChangelog: boolean }

const ARTIFACT_NAME: Record<ArtifactKind, string> = {
  commit: 'COMMIT_EDITMSG.txt',
  pr: 'PR_BODY.md',
  changelog: 'CHANGELOG_ENTRY.md',
}

const runGit = async ($: EngineInterface, argv: readonly string[], cwd?: string) =>
  $.process.run(['git', ...argv], { cwd, timeoutMs: 15000 }).catch(() => undefined)

/** The repository root, or undefined where the session is not in a repository. */
const repoRoot = async ($: EngineInterface, cwd?: string): Promise<string | undefined> => {
  const found = await runGit($, ['rev-parse', '--show-toplevel'], cwd)
  const root = found?.exitCode === 0 ? found.stdout.trim() : ''

  return root === '' ? undefined : root
}

/**
 * Where the session is right now, as git sees that directory: the physical
 * root and the physical folder. `git rev-parse --show-prefix` is taken from
 * `cwd`, so a symlink (logical cwd, physical root) still yields a `../` path
 * that opens, and a `/cd` or worktree switch is read at draft-write time.
 */
const placeOf = async (
  $: EngineInterface,
  cwd: string,
  fallbackRoot: string,
): Promise<{ root: string; cwd: string }> => {
  const prefix = await runGit($, ['rev-parse', '--show-prefix'], cwd)
  const physicalRoot = await repoRoot($, cwd)
  if (prefix?.exitCode !== 0 || physicalRoot === undefined) return { root: fallbackRoot, cwd }
  const pre = prefix.stdout.trim().replace(/\/+$/, '')

  return { root: physicalRoot, cwd: pre === '' ? physicalRoot : `${physicalRoot}/${pre}` }
}

/**
 * Every file changed against HEAD right now: staged and unstaged tracked
 * changes, plus untracked files, which plain `git diff` says nothing about.
 * This mod's own drafts are its output, not a change to ship, so the drafts
 * folder is left out. `text` is the diff as read, for `treeSeenOf`.
 */
const scanTree = async ($: EngineInterface, root: string, config: Config, stopWhenGitFails = false) => {
  const failed = { files: [], text: '', ok: false, skipped: 0 }
  // core.quotePath=false keeps non-ASCII names raw in the diff headers, so
  // the path in a draft is the path on disk rather than octal escapes.
  const tracked = await runGit($, [...TRACKED_DIFF_ARGS], root)
  // A baseline that git did not answer is not stored. Stopping here keeps one
  // unanswered read from turning into a hundred more before the turn starts.
  if (stopWhenGitFails && tracked === undefined) return failed
  const chunks: string[] = []
  const trackedText = tracked ? readDiff(tracked.exitCode, tracked.stdout) : undefined
  if (trackedText !== undefined) chunks.push(trackedText)

  // -z: NUL-separated and never quoted, so a name with a space, a quote or
  // non-ASCII characters comes back as it is on disk instead of skipped.
  const others = await runGit($, [...UNTRACKED_LIST_ARGS], root)
  if (stopWhenGitFails && others === undefined) return failed
  const untracked = (others?.exitCode === 0 ? splitNul(others.stdout) : [])
    .filter(path => !isUnder(path, config.shipDir))
    .slice(0, UNTRACKED_LIMIT)
  let skipped = 0
  for (const path of untracked) {
    // --no-index exits 1 when the two sides differ, which is the point here.
    // The same exit with an empty stdout means git could not open the path.
    const one = await runGit($, [...untrackedDiffArgs(path)], root)
    if (stopWhenGitFails && one === undefined) return failed
    const text = one ? readDiff(one.exitCode, one.stdout) : undefined
    if (text === undefined) {
      skipped += 1
      continue
    }
    chunks.push(text)
  }
  // Each diff already ends in a newline. A second one between chunks sticks
  // to the previous file, so that file's fingerprint changes when a later
  // file is appended even though its own diff did not.
  const text = chunks
    .filter(chunk => chunk !== '')
    .map(chunk => (chunk.endsWith('\n') ? chunk : `${chunk}\n`))
    .join('')

  return {
    files: parseDiffFiles(text).filter(one => !isUnder(one.path, config.shipDir)),
    text,
    ok: tracked !== undefined && others !== undefined,
    skipped,
  }
}

const recentSubjects = async ($: EngineInterface, root: string) => {
  const found = await runGit($, ['log', `-${RECENT_COMMIT_COUNT}`, '--format=%s'], root)

  return found?.exitCode === 0 ? parseSubjects(found.stdout) : []
}

/** CHANGELOG.md's own text, or undefined where there is none to draft against. */
const loadChangelog = async ($: EngineInterface, root: string, config: Config): Promise<string | undefined> => {
  if (!config.includeChangelog) return undefined
  const path = `${root}/${CHANGELOG_NAME}`
  const exists = await $.fs.exists(path).catch(() => false)

  return exists ? await $.fs.read(path).catch(() => undefined) : undefined
}

/**
 * Reads the tree once, keeps it as the one the next comparison is measured
 * against, and says whether it moved since the last read. Unknown (no
 * earlier read) counts as moved, so a missed baseline never hides a kit.
 * The files are only those whose own diff changed since that read.
 */
const readTree = async ($: EngineInterface, root: string, config: Config) => {
  const scanned = await scanTree($, root, config)
  const seen = treeSeenOf(scanned.text)
  const before = seenFrom(await read($, lastSeen))
  await update($, lastSeen, () => seen)

  return {
    files: filesSince(before, seen, scanned.files),
    hasMoved: before === null || before.tree !== seen.tree,
    skipped: scanned.skipped,
  }
}

/**
 * The tree at the start of a turn, taken before the turn writes. A git
 * failure leaves the previous read alone — session start, or the previous
 * turn's end — and does not throw. One unanswered command stops the read,
 * so a failed git cannot walk the rest of the tree before the turn starts.
 * The whole read gives up at `capMs` the same way: the previous read stays,
 * which is older than the turn, so nothing the turn writes is hidden, and a
 * turn that writes nothing still gets no kit. The turn starts either way.
 */
const takeBaseline = async ($: EngineInterface, config: Config, capMs: number) => {
  let timer: TimeoutHandle | undefined
  const cap = new Promise<'cap'>(resolve => {
    timer = setTimeout(() => resolve('cap'), capMs)
  })
  const scan = (async (): Promise<TreeSeen | 'skip'> => {
    try {
      const root = await repoRoot($)
      if (root === undefined) return 'skip'
      const scanned = await scanTree($, root, config, true)
      if (!scanned.ok) return 'skip'

      return treeSeenOf(scanned.text)
    } catch {
      return 'skip'
    }
  })()
  try {
    const result = await Promise.race([scan, cap])
    if (timer !== undefined) clearTimeout(timer)
    if (result === 'cap' || result === 'skip') return
    await update($, lastSeen, () => result)
  } catch {
    if (timer !== undefined) clearTimeout(timer)
  }
}

/**
 * The kit for the turn that just ended, or null when there is nothing to ship,
 * nowhere to ship it, or the turn changed nothing: changes already sitting in
 * the tree from before it were offered then, or were never this turn's.
 */
const buildOffer = async ($: EngineInterface, config: Config, turnId: string): Promise<ShipOffer | null> => {
  const root = await repoRoot($)
  if (root === undefined) return null
  const { files, hasMoved, skipped } = await readTree($, root, config)
  if (!hasMoved || files.length === 0) return null
  const subjects = await recentSubjects($, root)
  const changelogContent = await loadChangelog($, root, config)

  return { turnId, ...kitOf(files, subjects, changelogContent), ...(skipped > 0 ? { skipped } : {}) }
}

const artifactsFor = (mode: ShipMode, hasChangelog: boolean): ArtifactKind[] => {
  if (mode === 'commit' || mode === 'pr' || mode === 'changelog') return [mode]
  const base: ArtifactKind[] = ['commit', 'pr']

  return hasChangelog ? [...base, 'changelog'] : base
}

const textFor = (kit: ShipOffer, kind: ArtifactKind): string | undefined =>
  kind === 'commit' ? commitFileText(kit.commit) : kind === 'pr' ? kit.prBody : kit.changelogEntry

/** Writes whichever drafts `mode` calls for, into `config.shipDir`; never runs anything. */
const applyOffer = async ($: EngineInterface, config: Config, kit: ShipOffer, mode: ShipMode): Promise<ShipResult> => {
  if (mode === 'skip') return { turnId: kit.turnId, mode, wrote: [] }
  const root = await repoRoot($)
  if (root === undefined) return { turnId: kit.turnId, mode, wrote: [] }

  const drafts = artifactsFor(mode, kit.changelogEntry !== undefined).flatMap(kind => {
    const text = textFor(kit, kind)

    return text === undefined ? [] : [{ kind, text }]
  })
  // Before the first draft lands, the folder learns to ignore itself, so no
  // draft is ever read as a change: not by git status, not by wait-review,
  // not by the next kit. One already there, the person's own, is kept.
  const ignore = `${root}/${config.shipDir}/.gitignore`
  if (drafts.length > 0 && isOwnFolder(config.shipDir) && !(await $.fs.exists(ignore).catch(() => true))) {
    await $.fs.write(ignore, DRAFTS_GITIGNORE).catch(() => undefined)
  }

  // Read the folder at accept time. A cwd saved at session start is wrong
  // after `/cd` or a worktree switch.
  const here = await $.session.cwd().catch(() => '')
  const place = here === '' ? { root, cwd: undefined } : await placeOf($, here, root)

  const wrote: ShipResult['wrote'] = []
  for (const { kind, text } of drafts) {
    const repoPath = `${config.shipDir}/${ARTIFACT_NAME[kind]}`
    // An absolute shipDir is still written under the repository root
    // (`${root}/…`). The receipt names that file, not the absolute path.
    await $.fs.write(draftAbsolute(root, repoPath), text)
    wrote.push({ kind, path: pathFromCwd(place.root, place.cwd, writtenRelative(place.root, repoPath)) })
  }

  return { turnId: kit.turnId, mode, wrote }
}

/**
 * Answers the offer: writes what `mode` asks for, clears the row, and puts
 * one receipt line per draft in the transcript — not in the row, which is
 * shared, so a question waiting behind the offer (the bet's "Did it land?")
 * gets the row the moment this one is answered.
 */
const respond = async ($: EngineInterface, config: Config, kit: ShipOffer, mode: ShipMode) => {
  const result = await applyOffer($, config, kit, mode)
  await update($, offer, () => null)
  for (const line of receiptLines(result.wrote)) $.ui.log(line)
}

/** Shows each draft on its own key: one press, offered rather than spent on every offer. */
const expand = async ($: EngineInterface) => {
  await update($, offer, kit => (kit ? { ...kit, isExpanded: true as const } : kit))
}

export const register: Register = (on, options) => {
  const config: Config = {
    enabled: options.enabled !== false,
    shipDir:
      typeof options.shipDir === 'string' && options.shipDir.trim() !== '' ? options.shipDir.trim() : DEFAULT_SHIP_DIR,
    includeChangelog: options.includeChangelog !== false,
  }
  const capOption = (options as { snapshotCapMs?: unknown }).snapshotCapMs
  const snapshotCapMs = typeof capOption === 'number' && capOption > 0 ? capOption : SNAPSHOT_CAP_MS

  // The tree as the session found it: what was already changed then is not a
  // turn's to ship, so the first turn is measured against it like any other.
  on('session.start', async ($, e, next) => {
    const done = await next(e)
    if (!config.enabled || (await read($, lastSeen)) !== null) return done
    const root = await repoRoot($)
    if (root !== undefined) await readTree($, root, config).catch(() => undefined)

    return done
  }).catch(($, e, next) => next(e))

  on('turn.start', async ($, e, next) => {
    if (e.agentId !== undefined) return next(e)
    // A new turn's own kit, once it lands, takes over the band; an ignored
    // kit from the last one has nothing left to say.
    await update($, offer, () => null)
    // Before next(e), so the turn has not written yet. Anything the person
    // edited between turns is this baseline, not the turn's. A failed read
    // is caught and not stored, and the turn starts either way.
    if (config.enabled) await takeBaseline($, config, snapshotCapMs).catch(() => undefined)

    return next(e)
  }).catch(($, e, next) => next(e))

  on('turn.complete', async ($, e, next) => {
    const done = await next(e)
    if (e.agentId !== undefined || !config.enabled) return done
    await update($, offer, () => null)
    const kit = await buildOffer($, config, e.turnId)
    if (kit) await update($, offer, () => kit)

    return done
  }).catch(($, e, next) => next(e))

  /**
   * The kit rides the row above the prompt, the one `bet-on-your-agent` asks
   * about the turn that just landed from: no pane, no required answer, gone
   * on its own once the next turn starts. The row shows one mod at a time,
   * and a kit comes ahead of the bet's question and behind a breathe nudge
   * and, between turns, behind any higher-precedence waitroom card.
   */
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (!config.enabled || e.props.hasSurvey) return next(e)
    const kit = await read($, offer)
    if (!kit) return next(e)

    const { Box, Text, Button } = $.ui.resolve(e)
    const sizes = [
      `commit ${formatSize(commitFileText(kit.commit).length)}`,
      `PR ${formatSize(kit.prBody.length)}`,
      ...(kit.changelogEntry !== undefined ? [`changelog ${formatSize(kit.changelogEntry.length)}`] : []),
    ].join(' · ')
    // Accept-all and skip answer most offers, so they are all the row shows
    // until "More" asks for each draft on its own key — one press, in place.
    const eachDraft =
      kit.isExpanded === true
        ? [
            <Button key="commit" hotkey="c" plain dimColor onPress={() => respond($, config, kit, 'commit')}>
              Commit msg
            </Button>,
            <Button key="pr" hotkey="p" plain dimColor onPress={() => respond($, config, kit, 'pr')}>
              PR body
            </Button>,
            ...(kit.changelogEntry !== undefined
              ? [
                  <Button key="changelog" hotkey="l" plain dimColor onPress={() => respond($, config, kit, 'changelog')}>
                    Changelog
                  </Button>,
                ]
              : []),
            <Button key="edit" hotkey="e" plain dimColor onPress={() => respond($, config, kit, 'edit')}>
              Drafts for editing
            </Button>,
          ]
        : [
            <Button key="more" hotkey="m" plain dimColor onPress={() => expand($)}>
              More
            </Button>,
          ]

    const mine = (
      <Box flexDirection="column">
        <Text wrap="truncate-end">
          {/* "success" renders as this mod's own icon green (#4eba65), not wait-review's shared "suggestion". */}
          <Text backgroundColor="success" color="inverseText" weight="bold">
            {PANE_TAG}
          </Text>{' '}
          Drafts ready: <Text weight="bold">{kit.commit.subject}</Text>
          <Text dimColor> · {sizes}</Text>
        </Text>
        {kit.skipped !== undefined && kit.skipped > 0 ? (
          <Text dimColor wrap="truncate-end">
            {skippedLine(kit.skipped)}
          </Text>
        ) : null}
        {/* columnGap, not gap: a gap holds down as well as across, and put two
            blank rows between the keys once the expanded row wrapped. */}
        <Box columnGap={2} flexWrap="wrap">
          <Button key="all" hotkey="a" plain onPress={() => respond($, config, kit, 'all')}>
            Accept all
          </Button>
          {eachDraft}
          <Button key="skip" hotkey="s" plain dimColor onPress={() => respond($, config, kit, 'skip')}>
            Skip
          </Button>
        </Box>
        {/* Its keys are letters, which only answer once the row holds the
            keyboard: said in wait-review's own words, on the line the
            drafts' caveat already had, so the row grows no taller. */}
        <Text dimColor wrap="truncate-end">
          ctrl+x tab to use these keys · or click them · read each draft before using it
        </Text>
      </Box>
    )
    const beneath = await next(e).catch(() => undefined)
    // `{ type: "engine" }` names nobody. Returning it would hide this offer
    // even when the row is empty, so it is not a yield.
    return beneath !== undefined && yieldsBand('wait-ship', drawnBy(beneath)) ? beneath : mine
  }).catch(($, e, next) => next(e))

  // 2.1.325 stacks every plugin's row and `next(e)` there names nobody.
  // Leaving rows out of AbovePromptList is how one mod yields. 2.1.319
  // does not raise this event; the hook above still reads `part.plugin`.
  // The 2.1.319 types have no AbovePromptList. On 2.1.325 its props are the
  // band's plus `rows`, so it is typed as the band here and `rows` added.
  on('ui.render', { component: 'AbovePromptList', plugin: '*' } as unknown as { component: 'AbovePrompt' }, ($, e, next) => {
    const props = e.props as typeof e.props & { readonly rows: readonly { plugin?: unknown; tree?: unknown }[] }
    const kept = rowsKept(props.rows, props.isWorking)
    if (kept.length === props.rows.length) return next(e)

    return next({ ...e, props: { ...props, rows: kept } as typeof e.props })
  }).catch(($, e, next) => next(e))
}
