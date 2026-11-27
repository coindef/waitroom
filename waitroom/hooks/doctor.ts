/**
 * `/waitroom doctor`: a local, read-only report of whether the installed
 * rooms look healthy. The hooks module prints what this file returns; this
 * file itself talks to no engine and writes nothing.
 */

export type InstalledRoom = {
  name: string
  version: string | undefined
}

/** The reply when `/waitroom` is run with anything other than `doctor`. */
export const USAGE = 'usage: /waitroom doctor'

/**
 * The first Claude Code release that asked each AbovePrompt hook for its
 * own row and stacked the answers. On earlier builds this is not a problem.
 */
export const STACK_CLASH_SINCE = '2.1.323'

/**
 * The first release of each yield room that leaves other rows out of
 * AbovePromptList, so the status row stays one row on STACK_CLASH_SINCE
 * and later.
 */
export const STACK_MIN: Readonly<Record<string, string>> = {
  'bet-on-your-agent': '0.6.6',
  'wait-ship': '0.1.7',
  'wait-breathe': '0.2.2',
  'wait-scope': '0.1.2',
  'wait-secret': '0.1.2',
}

const STACK_ORDER = [
  'bet-on-your-agent',
  'wait-ship',
  'wait-breathe',
  'wait-scope',
  'wait-secret',
] as const

/** The first three numeric parts of a dotted version, or nothing. */
export const parseVersion = (text: string): [number, number, number] | undefined => {
  const match = /^([0-9]+)\.([0-9]+)\.([0-9]+)/.exec(text)
  if (match === null) return undefined
  const major = Number(match[1])
  const minor = Number(match[2])
  const patch = Number(match[3])
  if (!Number.isFinite(major) || !Number.isFinite(minor) || !Number.isFinite(patch)) return undefined

  return [major, minor, patch]
}

/** Whether `version` is at least `min`, both read as dotted numeric versions. */
export const isAtLeast = (version: string, min: string): boolean => {
  const left = parseVersion(version)
  const right = parseVersion(min)
  if (left === undefined || right === undefined) return false
  if (left[0] !== right[0]) return left[0] > right[0]
  if (left[1] !== right[1]) return left[1] > right[1]

  return left[2] >= right[2]
}

/** The release label the healthy line should print. */
export const displayClaudeVersion = (session: { version: string; base?: string }): string => {
  if (session.base !== undefined && session.base.length > 0) return session.base

  return session.version
}

/**
 * Installed Waitroom-marketplace plugins from an `installed_plugins.json`
 * body. Other marketplaces are ignored. A body that is not that file is
 * `'invalid'`.
 */
export const parseInstalledRooms = (text: string): InstalledRoom[] | 'invalid' => {
  let data: unknown
  try {
    data = JSON.parse(text)
  } catch {
    return 'invalid'
  }
  if (typeof data !== 'object' || data === null || Array.isArray(data)) return 'invalid'
  const plugins = (data as { plugins?: unknown }).plugins
  if (typeof plugins !== 'object' || plugins === null || Array.isArray(plugins)) return 'invalid'
  const rooms: InstalledRoom[] = []
  for (const [key, entries] of Object.entries(plugins)) {
    const name = nameFromWaitroomKey(key)
    if (name === undefined) continue
    rooms.push({ name, version: versionFromEntries(entries) })
  }

  return rooms
}

const nameFromWaitroomKey = (key: string): string | undefined => {
  const at = key.lastIndexOf('@')
  if (at <= 0) return undefined
  if (key.slice(at + 1) !== 'waitroom') return undefined
  const name = key.slice(0, at)

  return name.length > 0 ? name : undefined
}

const versionFromEntries = (entries: unknown): string | undefined => {
  if (!Array.isArray(entries) || entries.length === 0) return undefined
  const first = entries[0]
  if (typeof first !== 'object' || first === null) return undefined
  const version = (first as { version?: unknown }).version

  return typeof version === 'string' && version.length > 0 ? version : undefined
}

/**
 * The lines `/waitroom doctor` should print: one healthy line, or one ⚠️
 * line per outdated yield room, each with a copyable update command that
 * this function does not run.
 */
export const doctorLines = (input: { rooms: InstalledRoom[]; claudeVersion: string }): string[] => {
  const problems: string[] = []
  if (isAtLeast(input.claudeVersion, STACK_CLASH_SINCE)) {
    const byName = new Map(input.rooms.map(room => [room.name, room]))
    for (const name of STACK_ORDER) {
      const room = byName.get(name)
      if (room === undefined) continue
      const min = STACK_MIN[name]
      if (min !== undefined && room.version !== undefined && isAtLeast(room.version, min)) continue
      const labeled = room.version !== undefined ? `${name} ${room.version}` : name
      problems.push(
        `⚠️ ${labeled} stacks the status row on 2.1.323 and later · claude plugin update ${name}@waitroom`,
      )
    }
  }
  if (problems.length > 0) return problems

  return [`all ${input.rooms.length} rooms ok · claude ${input.claudeVersion}`]
}

/** Printed when the installed-plugins list cannot be read or parsed. */
export const INSTALL_LIST_UNREADABLE =
  "couldn't read the installed plugins list · try /waitroom doctor again"

/** Printed when `$.session.version` cannot be read. */
export const VERSION_UNREADABLE = "couldn't read the Claude Code version · try /waitroom doctor again"

const trimSlash = (path: string): string => path.replace(/[/\\]+$/, '')

/**
 * Where `installed_plugins.json` lives, from the same directories the
 * engine uses for its plugin cache. Undefined when none of those are set.
 */
export const installedPluginsPath = (env: {
  CLAUDE_CODE_PLUGIN_CACHE_DIR?: string
  CLAUDE_CONFIG_DIR?: string
  HOME?: string
  CLAUDE_CODE_USE_COWORK_PLUGINS?: string
}): string | undefined => {
  const cache = env.CLAUDE_CODE_PLUGIN_CACHE_DIR
  if (cache !== undefined && cache.length > 0) return `${trimSlash(cache)}/installed_plugins.json`
  const configured = env.CLAUDE_CONFIG_DIR
  const home = env.HOME
  const base =
    configured !== undefined && configured.length > 0
      ? configured
      : home !== undefined && home.length > 0
        ? `${trimSlash(home)}/.claude`
        : undefined
  if (base === undefined) return undefined
  const folder = env.CLAUDE_CODE_USE_COWORK_PLUGINS !== undefined ? 'cowork_plugins' : 'plugins'

  return `${trimSlash(base)}/${folder}/installed_plugins.json`
}

/**
 * The full `/waitroom doctor` reply: the healthy line, the ⚠️ lines, or
 * one fallback when a read failed.
 */
export const doctorReport = (
  installText: string | 'missing' | 'unreadable',
  session: { version: string; base?: string } | 'unreadable',
): string => {
  if (session === 'unreadable') return VERSION_UNREADABLE
  const claudeVersion = displayClaudeVersion(session)
  if (installText === 'missing' || installText === 'unreadable') return INSTALL_LIST_UNREADABLE
  const rooms = parseInstalledRooms(installText)
  if (rooms === 'invalid') return INSTALL_LIST_UNREADABLE

  return doctorLines({ rooms, claudeVersion }).join('\n')
}
