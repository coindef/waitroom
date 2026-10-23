import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { ArtifactKind, ShipMode, ShipOffer, ShipResult } from '../types'
import { applyCommandFor, commitFileText, formatSize, kitOf, parseDiffFiles, parseSubjects } from './ship'

const PANE_TAG = ' ship '
const DEFAULT_SHIP_DIR = '.waitroom/ship'
const CHANGELOG_NAME = 'CHANGELOG.md'
const RECENT_COMMIT_COUNT = 20
/** Untracked files diffed one by one per scan, so a stray folder cannot stall it. */
const UNTRACKED_LIMIT = 100

const offer = atom({ plugin: 'wait-ship', key: 'offer' } as const, null as ShipOffer | null)
const lastResult = atom({ plugin: 'wait-ship', key: 'lastResult' } as const, null as ShipResult | null)

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
 */
const scanFiles = async ($: EngineInterface, root: string) => {
  const tracked = await runGit($, ['diff', 'HEAD', '--no-color', '--no-prefix'], root)
  const chunks: string[] = tracked?.exitCode === 0 ? [tracked.stdout] : []

  const others = await runGit($, ['ls-files', '--others', '--exclude-standard'], root)
  const untracked = (others?.stdout ?? '')
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean)
    .slice(0, UNTRACKED_LIMIT)
  for (const path of untracked) {
    // --no-index exits 1 when the two sides differ, which is the point here.
    const one = await runGit($, ['diff', '--no-color', '--no-prefix', '--no-index', '--', '/dev/null', path], root)
    if (one && one.exitCode <= 1) chunks.push(one.stdout)
  }

  return parseDiffFiles(chunks.join('\n'))
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

/** The kit for the turn that just ended, or null when there is nothing to ship or nowhere to ship it. */
const buildOffer = async ($: EngineInterface, config: Config, turnId: string): Promise<ShipOffer | null> => {
  const root = await repoRoot($)
  if (root === undefined) return null
  const files = await scanFiles($, root)
  if (files.length === 0) return null
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

  const wrote: ShipResult['wrote'] = []
  for (const kind of artifactsFor(mode, kit.changelogEntry !== undefined)) {
    const text = textFor(kit, kind)
    if (text === undefined) continue
    const path = `${config.shipDir}/${ARTIFACT_NAME[kind]}`
    await $.fs.write(`${root}/${path}`, text)
    wrote.push({ kind, path })
  }

  return { turnId: kit.turnId, mode, wrote }
}

const respond = async ($: EngineInterface, config: Config, kit: ShipOffer, mode: ShipMode) => {
  const result = await applyOffer($, config, kit, mode)
  await update($, offer, () => null)
  await update($, lastResult, () => result)
}

export const register: Register = (on, options) => {
  const config: Config = {
    enabled: options.enabled !== false,
    shipDir:
      typeof options.shipDir === 'string' && options.shipDir.trim() !== '' ? options.shipDir.trim() : DEFAULT_SHIP_DIR,
    includeChangelog: options.includeChangelog !== false,
  }

  on('turn.start', async ($, e, next) => {
    if (e.agentId !== undefined) return next(e)
    // A new turn's own kit, once it lands, takes over the band; an answered
    // or ignored kit from the last one has nothing left to say.
    await update($, offer, () => null)
    await update($, lastResult, () => null)

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
   * The kit rides the same band `bet-on-your-agent` uses to ask about the
   * turn that just landed: no pane, no required answer, gone on its own once
   * the next turn starts.
   */
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (!config.enabled || e.props.hasSurvey) return next(e)
    const kit = await read($, offer)
    const result = await read($, lastResult)

    if (!kit) {
      if (!result || result.wrote.length === 0) return next(e)
      const { Box, Text } = $.ui.resolve(e)

      return (
        <Box flexDirection="column">
          <Text dimColor>Drafts written:</Text>
          {result.wrote.map(one => (
            <Text key={one.kind} dimColor wrap="truncate-end">
              {'  '}
              {one.path} — {applyCommandFor(one.kind, one.path)}
            </Text>
          ))}
        </Box>
      )
    }

    const { Box, Text, Button } = $.ui.resolve(e)
    const sizes = [
      `commit ${formatSize(commitFileText(kit.commit).length)}`,
      `PR ${formatSize(kit.prBody.length)}`,
      ...(kit.changelogEntry !== undefined ? [`changelog ${formatSize(kit.changelogEntry.length)}`] : []),
    ].join(' · ')

    return (
      <Box flexDirection="column">
        <Text wrap="truncate-end">
          {/* "success" renders as this mod's own icon green (#4eba65), not wait-review's shared "suggestion". */}
          <Text backgroundColor="success" color="inverseText" weight="bold">
            {PANE_TAG}
          </Text>{' '}
          Drafts ready: <Text weight="bold">{kit.commit.subject}</Text>
          <Text dimColor> · {sizes}</Text>
        </Text>
        <Box gap={2} flexWrap="wrap">
          <Button key="all" hotkey="a" plain onPress={() => respond($, config, kit, 'all')}>
            Accept all
          </Button>
          <Button key="commit" hotkey="c" plain dimColor onPress={() => respond($, config, kit, 'commit')}>
            Commit msg
          </Button>
          <Button key="pr" hotkey="p" plain dimColor onPress={() => respond($, config, kit, 'pr')}>
            PR body
          </Button>
          {kit.changelogEntry !== undefined && (
            <Button key="changelog" hotkey="l" plain dimColor onPress={() => respond($, config, kit, 'changelog')}>
              Changelog
            </Button>
          )}
          <Button key="edit" hotkey="e" plain dimColor onPress={() => respond($, config, kit, 'edit')}>
            Drafts for editing
          </Button>
          <Button key="skip" hotkey="s" plain dimColor onPress={() => respond($, config, kit, 'skip')}>
            Skip
          </Button>
        </Box>
        <Text dimColor>Drafts — read them before using them.</Text>
      </Box>
    )
  }).catch(($, e, next) => next(e))
}
