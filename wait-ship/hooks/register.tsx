import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { ArtifactKind, ShipMode, ShipOffer, ShipResult } from '../types'
import {
  commitFileText,
  DRAFTS_GITIGNORE,
  drawnBy,
  fingerprintOf,
  formatSize,
  isOwnFolder,
  isUnder,
  kitOf,
  parseDiffFiles,
  parseSubjects,
  receiptLines,
  yieldsBand,
} from './ship'

const PANE_TAG = ' ship '
const DEFAULT_SHIP_DIR = '.waitroom/ship'
const CHANGELOG_NAME = 'CHANGELOG.md'
const RECENT_COMMIT_COUNT = 20
/** Untracked files diffed one by one per scan, so a stray folder cannot stall it. */
const UNTRACKED_LIMIT = 100

const offer = atom({ plugin: 'wait-ship', key: 'offer' } as const, null as ShipOffer | null)
const lastSeen = atom({ plugin: 'wait-ship', key: 'lastSeen' } as const, null as string | null)

type Config = { enabled: boolean; shipDir: string; includeChangelog: boolean }

const ARTIFACT_NAME: Record<ArtifactKind, string> = {
  commit: 'COMMIT_EDITMSG.txt',
  pr: 'PR_BODY.md',
  changelog: 'CHANGELOG_ENTRY.md',
}

const runGit = async ($: EngineInterface, argv: readonly string[], cwd?: string) =>
  $.process.run(['git', ...argv], { cwd, timeoutMs: 15000 }).catch(() => undefined)

/** The repository root, or undefined where the session is not in a repository. */
const repoRoot = async ($: EngineInterface): Promise<string | undefined> => {
  const found = await runGit($, ['rev-parse', '--show-toplevel'])
  const root = found?.exitCode === 0 ? found.stdout.trim() : ''

  return root === '' ? undefined : root
}

/**
 * Every file changed against HEAD right now: staged and unstaged tracked
 * changes, plus untracked files, which plain `git diff` says nothing about.
 * This mod's own drafts are its output, not a change to ship, so the drafts
 * folder is left out. `text` is the diff as read, for `fingerprintOf`.
 */
const scanTree = async ($: EngineInterface, root: string, config: Config) => {
  const tracked = await runGit($, ['diff', 'HEAD', '--no-color', '--no-prefix'], root)
  const chunks: string[] = tracked?.exitCode === 0 ? [tracked.stdout] : []

  const others = await runGit($, ['ls-files', '--others', '--exclude-standard'], root)
  const untracked = (others?.stdout ?? '')
    .split('\n')
    .map(line => line.trim())
    .filter(path => path !== '' && !isUnder(path, config.shipDir))
    .slice(0, UNTRACKED_LIMIT)
  for (const path of untracked) {
    // --no-index exits 1 when the two sides differ, which is the point here.
    const one = await runGit($, ['diff', '--no-color', '--no-prefix', '--no-index', '--', '/dev/null', path], root)
    if (one && one.exitCode <= 1) chunks.push(one.stdout)
  }
  const text = chunks.join('\n')

  return { files: parseDiffFiles(text).filter(one => !isUnder(one.path, config.shipDir)), text }
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
 * Reads the tree once, keeps its fingerprint as the one the next turn is
 * measured against, and says whether it moved since the last read. Unknown
 * (no earlier read) counts as moved, so a missed baseline never hides a kit.
 */
const readTree = async ($: EngineInterface, root: string, config: Config) => {
  const scanned = await scanTree($, root, config)
  const now = fingerprintOf(scanned.text)
  const before = await read($, lastSeen)
  await update($, lastSeen, () => now)

  return { ...scanned, hasMoved: before !== now }
}

/**
 * The kit for the turn that just ended, or null when there is nothing to ship,
 * nowhere to ship it, or the turn changed nothing: changes already sitting in
 * the tree from before it were offered then, or were never this turn's.
 */
const buildOffer = async ($: EngineInterface, config: Config, turnId: string): Promise<ShipOffer | null> => {
  const root = await repoRoot($)
  if (root === undefined) return null
  const { files, hasMoved } = await readTree($, root, config)
  if (!hasMoved || files.length === 0) return null
  const subjects = await recentSubjects($, root)
  const changelogContent = await loadChangelog($, root, config)

  return { turnId, ...kitOf(files, subjects, changelogContent) }
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

  const wrote: ShipResult['wrote'] = []
  for (const { kind, text } of drafts) {
    const path = `${config.shipDir}/${ARTIFACT_NAME[kind]}`
    await $.fs.write(`${root}/${path}`, text)
    wrote.push({ kind, path })
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
   * and a kit comes ahead of the bet's question and behind a breathe nudge.
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
        <Text dimColor>Drafts — read them before using them.</Text>
      </Box>
    )
    const beneath = await next(e).catch(() => undefined)

    return beneath !== undefined && yieldsBand('wait-ship', drawnBy(beneath)) ? beneath : mine
  }).catch(($, e, next) => next(e))
}
