import type { EngineInterface } from 'claude-code'

/**
 * The engine's plugin store. `$.store` reads and writes it, but a hook
 * cannot ask for the path or the storage id: those stay inside the host.
 * The file is `<root>/store/<fileName(source)>`.
 *
 * `source` is this copy's own id. A copy under
 * `<root>/cache/<marketplace>/<plugin>/<version>/` is
 * `<plugin>@<marketplace>`. A copy outside that cache is ambiguous: it
 * may be `--plugin-dir` (`<plugin>@inline`) or a directory-source
 * marketplace (`<plugin>@<name>`), and those are different files. Unless
 * the settings prove no enabled directory marketplace covers this folder,
 * the repair does nothing. Another install's file is never opened, and a
 * directory listing is never used to pick one.
 *
 * `root` is `$CLAUDE_CODE_PLUGIN_CACHE_DIR` when that is set, otherwise
 * `<CLAUDE_CONFIG_DIR or ~/.claude>/plugins` — or `cowork_plugins` when
 * `CLAUDE_CODE_USE_COWORK_PLUGINS` is set. With neither config dir nor
 * home set, and no cache dir, there is nothing to repair.
 */

export type StoreRepair = 'none' | 'empty' | 'rebuilt'

/** One line, lowercase, under the 48-column band. */
export const REBUILT_NOTICE = "couldn't read the saved history · rebuilt"

const PLUGIN = 'bet-on-your-agent'

/**
 * The engine's `fileName`. A plain id is `<id>.json`. Anything with a
 * character outside `[a-z0-9._-]`, a Windows device name, `.` / `..`, or
 * more than 64 characters is the sanitized id (64 characters at most)
 * plus `-` and the first 12 hex digits of sha256(id).
 */
export const storeFileName = (id: string): string => {
  if (plainStoreId(id)) return `${id}.json`
  const cleaned = id.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64) || 'plugin'
  return `${cleaned}-${sha256(id).slice(0, 12)}.json`
}

/**
 * The store id a module URL proves by itself. A cache install names its
 * marketplace. A URL outside the cache does not: `--plugin-dir` and a
 * directory-source marketplace look the same from the path alone.
 */
export function sourceIdFor(moduleUrl: string): string | undefined {
  const market = marketplaceFrom(moduleUrl)
  if (market !== undefined) return `${PLUGIN}@${market}`
  return undefined
}

/** The folder this copy was loaded from, when the URL names the plugin. */
export function runningPluginFolder(): string | undefined {
  const moduleUrl = moduleUrlOf()
  if (moduleUrl === undefined) return undefined
  return pluginFolderFrom(moduleUrl)
}

/**
 * The `<root>` above, without `/store`. Undefined when the engine would
 * have nowhere to put the file.
 */
export async function storeRoot($: EngineInterface): Promise<string | undefined> {
  const cache = text(await $.env.get('CLAUDE_CODE_PLUGIN_CACHE_DIR').catch(() => undefined))
  if (cache !== undefined) return trimSlash(cache)
  const configured = text(await $.env.get('CLAUDE_CONFIG_DIR').catch(() => undefined))
  const home = text(await $.env.get('HOME').catch(() => undefined))
  const base = configured ?? (home !== undefined ? `${trimSlash(home)}/.claude` : undefined)
  if (base === undefined) return undefined
  const cowork = text(await $.env.get('CLAUDE_CODE_USE_COWORK_PLUGINS').catch(() => undefined))
  return `${trimSlash(base)}/${cowork !== undefined ? 'cowork_plugins' : 'plugins'}`
}

/**
 * Where this running copy's store file is. Undefined when there is no
 * root. The file does not have to exist yet.
 */
export async function storeFilePath($: EngineInterface): Promise<string | undefined> {
  const root = await storeRoot($)
  if (root === undefined) return undefined
  const id = await runningSourceId($)
  if (id === undefined) return undefined
  return `${root}/store/${storeFileName(id)}`
}

/**
 * Make one unreadable store file readable again, so the next save lands.
 * Only this install's file is touched. The engine locks its own read and
 * write by creating the directory `<path>.lock`. This repair does not
 * create that directory: a hook that created it and then ran `rmdir` left
 * the directory in place, so the engine could not take its lock, the save
 * failed, and the next repair found the lock already held. When the
 * directory is already there, this turn is skipped. The directory is
 * never removed.
 * A missing file is left alone. Zero bytes become `{}` with no backup.
 * Invalid JSON, JSON that is not an object, and an object whose `turns`
 * is not a list are copied aside and rebuilt. The first backup stays at
 * `<path>.bak`; a later one is `<path>.bak-<ms>`.
 */
export async function repairPluginStore($: EngineInterface): Promise<StoreRepair> {
  try {
    const path = await storeFilePath($)
    if (path === undefined) return 'none'
    if (!(await $.fs.exists(path))) return 'none'
    // `<path>.lock` is a directory the engine creates for its own read and
    // write. It belongs to that write. Skip while it is there.
    if (await $.fs.exists(`${path}.lock`)) return 'none'
    return await repairFile($, path)
  } catch {
    return 'none'
  }
}

const plainStoreId = (id: string): boolean =>
  /^[a-z0-9._-]+$/.test(id) && id !== '.' && id !== '..' && id.length <= 64 && !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i.test(id)

/** `<root>/cache/<marketplace>/<plugin>/<version>/` — the marketplace name, or undefined. */
const marketplaceFrom = (moduleUrl: string): string | undefined => {
  const parts = moduleUrl.replace(/\\/g, '/').split(/[/]+/)
  const cacheAt = parts.lastIndexOf('cache')
  const parent = cacheAt > 0 ? parts[cacheAt - 1] : undefined
  if (parent !== 'plugins' && parent !== 'cowork_plugins') return undefined
  const market = parts[cacheAt + 1]
  const plugin = parts[cacheAt + 2]
  const version = parts[cacheAt + 3]
  if (market === undefined || plugin !== PLUGIN || version === undefined || version === '') return undefined
  if (market === '' || market === '.' || market === '..') return undefined
  return decodeURIComponent(market)
}

/**
 * `import.meta.url` when this TypeScript knows it. The engine's
 * `ImportMeta` does not declare `url`, so the read is narrowed here.
 */
function moduleUrlOf(): string | undefined {
  const url = (import.meta as { url?: string }).url
  return typeof url === 'string' && url !== '' ? url : undefined
}

async function runningSourceId($: EngineInterface): Promise<string | undefined> {
  const moduleUrl = moduleUrlOf()
  if (moduleUrl === undefined) return undefined
  const known = sourceIdFor(moduleUrl)
  if (known !== undefined) return known
  const folder = pluginFolderFrom(moduleUrl)
  if (folder === undefined) return undefined
  if (!(await provenInline($, folder))) return undefined
  return `${PLUGIN}@inline`
}

/**
 * True only when every settings file we can reach was read, and no
 * directory marketplace that covers this folder enables this plugin. The
 * engine merges settings, so a marketplace declared in one file (or kept in
 * `known_marketplaces.json`) and enabled in another still counts. A missing
 * file is not a marketplace. A read or parse failure, or a directory path we
 * cannot place, means we cannot prove it.
 */
async function provenInline($: EngineInterface, pluginFolder: string): Promise<boolean> {
  const home = await configHome($)
  if (home === undefined) return false
  const roots = await projectRoots($)
  const files = [`${home}/settings.json`]
  for (const root of roots) {
    files.push(`${root}/.claude/settings.json`)
    files.push(`${root}/.claude/settings.local.json`)
  }
  const markets: [string, unknown][] = []
  const enabled = new Set<string>()
  for (const file of files) {
    const read = await readSettings($, file)
    if (read === 'missing') continue
    if (read === 'error') return false
    const entries = marketEntries(read)
    if (entries === 'error') return false
    if (entries !== 'absent') markets.push(...Object.entries(entries))
    const enabledRaw = read.enabledPlugins
    const on = recordOf(enabledRaw)
    if (enabledRaw !== undefined && on === undefined) return false
    for (const [id, value] of Object.entries(on ?? {})) if (value === true) enabled.add(id)
  }
  const root = await storeRoot($)
  if (root !== undefined) {
    const known = await readSettings($, `${root}/known_marketplaces.json`)
    if (known === 'error') return false
    if (known !== 'missing') markets.push(...Object.entries(known))
  }
  const covered = await directoryInstallCovers($, markets, enabled, pluginFolder, roots)
  return covered === false
}

async function configHome($: EngineInterface): Promise<string | undefined> {
  const configured = text(await $.env.get('CLAUDE_CONFIG_DIR').catch(() => undefined))
  if (configured !== undefined) return trimSlash(configured)
  const home = text(await $.env.get('HOME').catch(() => undefined))
  if (home !== undefined) return `${trimSlash(home)}/.claude`
  return undefined
}

/** The project settings live beside `.claude/` at the session root, or the cwd when that is all that is reachable. */
async function projectRoots($: EngineInterface): Promise<string[]> {
  const found: string[] = []
  const add = (value: unknown) => {
    const path = text(value)
    if (path !== undefined) found.push(trimSlash(normalizePath(path)))
  }
  try {
    add(await $.session.root())
  } catch {
    // The project settings are not reachable from here.
  }
  try {
    add(await $.session.cwd())
  } catch {
    // The working directory is not reachable from here.
  }
  return [...new Set(found)]
}

type SettingsBody = Record<string, unknown>

async function readSettings($: EngineInterface, path: string): Promise<SettingsBody | 'missing' | 'error'> {
  let there = false
  try {
    there = await $.fs.exists(path)
  } catch {
    return 'error'
  }
  if (!there) return 'missing'
  try {
    const parsed = JSON.parse(await $.fs.read(path)) as unknown
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return 'error'
    return parsed as SettingsBody
  } catch {
    return 'error'
  }
}

/**
 * An enabled `source: directory` marketplace whose path is this plugin's
 * parent, or an ancestor of the plugin folder that holds the marketplace
 * manifest. The name is the `extraKnownMarketplaces` key.
 */
async function directoryInstallCovers(
  $: EngineInterface,
  markets: readonly [string, unknown][],
  enabled: ReadonlySet<string>,
  pluginFolder: string,
  roots: readonly string[],
): Promise<boolean | 'error'> {
  for (const [name, entry] of markets) {
    const body = recordOf(entry)
    const source = recordOf(body?.source)
    if (source?.source !== 'directory' || typeof source.path !== 'string') continue
    if (!enabled.has(`${PLUGIN}@${name}`)) continue
    const paths = placedPaths(source.path, roots)
    if (paths === undefined) return 'error'
    for (const one of paths) {
      const covers = await directoryPathCovers($, one, pluginFolder)
      if (covers !== false) return covers
    }
  }
  return false
}

/** `extraKnownMarketplaces`, or its alias when that key is the only one present. */
function marketEntries(settings: SettingsBody): Record<string, unknown> | 'absent' | 'error' {
  const raw = settings.extraKnownMarketplaces !== undefined ? settings.extraKnownMarketplaces : settings.additionalMarketplaces
  if (raw === undefined) return 'absent'
  return recordOf(raw) ?? 'error'
}

async function directoryPathCovers($: EngineInterface, sourcePath: string, pluginFolder: string): Promise<boolean | 'error'> {
  const source = normalizePath(sourcePath)
  const plugin = normalizePath(pluginFolder)
  if (source === '' || plugin === '') return false
  const slash = plugin.lastIndexOf('/')
  const parent = slash <= 0 ? '/' : plugin.slice(0, slash)
  if (source === parent) return true
  if (!plugin.startsWith(`${source}/`)) return false
  try {
    return await $.fs.exists(`${source}/.claude-plugin/marketplace.json`)
  } catch {
    return 'error'
  }
}

/** Absolute paths to try. A relative path with nowhere to resolve it cannot be ruled out. */
function placedPaths(sourcePath: string, roots: readonly string[]): string[] | undefined {
  const trimmed = sourcePath.trim()
  if (trimmed === '') return undefined
  const slashed = trimmed.replace(/\\/g, '/')
  if (slashed.startsWith('/') || /^[A-Za-z]:/.test(slashed)) return [slashed]
  if (roots.length === 0) return undefined
  return roots.map(root => `${root}/${slashed}`)
}

function recordOf(value: unknown): Record<string, unknown> | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined
  return value as Record<string, unknown>
}

const pluginFolderFrom = (moduleUrl: string): string | undefined => {
  const parts = normalizePath(filePathFromUrl(moduleUrl)).split('/')
  const hooksAt = parts.lastIndexOf('hooks')
  if (hooksAt > 1 && parts[hooksAt - 1] === PLUGIN) return parts.slice(0, hooksAt).join('/')
  return undefined
}

const filePathFromUrl = (url: string): string => {
  if (!url.startsWith('file:')) return url
  let path = url.slice('file:'.length)
  if (path.startsWith('//')) {
    const slash = path.indexOf('/', 2)
    path = slash === -1 ? '' : path.slice(slash)
  }
  try {
    return decodeURIComponent(path)
  } catch {
    return path
  }
}

const normalizePath = (value: string): string => {
  const slashed = value.trim().replace(/\\/g, '/')
  const absolute = slashed.startsWith('/')
  const stack: string[] = []
  for (const part of slashed.split('/')) {
    if (part === '' || part === '.') continue
    if (part === '..') {
      stack.pop()
      continue
    }
    stack.push(part)
  }
  return `${absolute ? '/' : ''}${stack.join('/')}`
}

const text = (value: unknown): string | undefined => (typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined)

const trimSlash = (value: string): string => value.replace(/[\\/]+$/, '')

async function repairFile($: EngineInterface, path: string): Promise<StoreRepair> {
  const raw = await $.fs.read(path)
  if (raw.length === 0) {
    await $.fs.write(path, '{}\n')
    return 'empty'
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    await $.fs.write(await backupPath($, path), raw)
    await $.fs.write(path, '{}\n')
    return 'rebuilt'
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    await $.fs.write(await backupPath($, path), raw)
    await $.fs.write(path, '{}\n')
    return 'rebuilt'
  }
  const record = parsed as Record<string, unknown>
  if (record.turns === undefined || Array.isArray(record.turns)) return 'none'
  delete record.turns
  await $.fs.write(await backupPath($, path), raw)
  await $.fs.write(path, `${JSON.stringify(record)}\n`)
  return 'rebuilt'
}

/** `<path>.bak` the first time. A later repair keeps that file and writes `<path>.bak-<ms>`. */
async function backupPath($: EngineInterface, path: string): Promise<string> {
  const first = `${path}.bak`
  if (!(await $.fs.exists(first))) return first
  const stamp = Number(await $.clock.now())
  if (!Number.isFinite(stamp)) throw new Error('clock')
  return `${path}.bak-${stamp}`
}

/**
 * SHA-256, enough for the 12 hex digits in a store filename. A hook file
 * may only import `claude-code`, so this cannot be `node:crypto`.
 */
const sha256 = (message: string): string => {
  // UTF-8, as the engine hashes the id: a non-ASCII marketplace name must land on the same file.
  const bits = new TextEncoder().encode(message)
  const withPad = Math.ceil((bits.length + 9) / 64) * 64
  const padded = new Uint8Array(withPad)
  padded.set(bits)
  padded[bits.length] = 0x80
  const view = new DataView(padded.buffer)
  view.setUint32(withPad - 4, bits.length * 8)

  const k = [
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
    0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
    0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
    0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
  ]
  let h0 = 0x6a09e667
  let h1 = 0xbb67ae85
  let h2 = 0x3c6ef372
  let h3 = 0xa54ff53a
  let h4 = 0x510e527f
  let h5 = 0x9b05688c
  let h6 = 0x1f83d9ab
  let h7 = 0x5be0cd19
  const w = new Uint32Array(64)
  for (let block = 0; block < padded.length; block += 64) {
    for (let i = 0; i < 16; i++) w[i] = view.getUint32(block + i * 4)
    for (let i = 16; i < 64; i++) {
      // w has 64 words. i is 16..63, so i-16..i-1 are all inside it.
      const older = take(w[i - 15])
      const recent = take(w[i - 2])
      const s0 = rotr(older, 7) ^ rotr(older, 18) ^ (older >>> 3)
      const s1 = rotr(recent, 17) ^ rotr(recent, 19) ^ (recent >>> 10)
      w[i] = (take(w[i - 16]) + s0 + take(w[i - 7]) + s1) >>> 0
    }
    let a = h0
    let b = h1
    let c = h2
    let d = h3
    let e = h4
    let f = h5
    let g = h6
    let h = h7
    for (let i = 0; i < 64; i++) {
      const s1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)
      const ch = (e & f) ^ (~e & g)
      // k and w both have 64 entries, and i is 0..63.
      const temp1 = (h + s1 + ch + take(k[i]) + take(w[i])) >>> 0
      const s0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)
      const maj = (a & b) ^ (a & c) ^ (b & c)
      const temp2 = (s0 + maj) >>> 0
      h = g
      g = f
      f = e
      e = (d + temp1) >>> 0
      d = c
      c = b
      b = a
      a = (temp1 + temp2) >>> 0
    }
    h0 = (h0 + a) >>> 0
    h1 = (h1 + b) >>> 0
    h2 = (h2 + c) >>> 0
    h3 = (h3 + d) >>> 0
    h4 = (h4 + e) >>> 0
    h5 = (h5 + f) >>> 0
    h6 = (h6 + g) >>> 0
    h7 = (h7 + h) >>> 0
  }
  return [h0, h1, h2, h3, h4, h5, h6, h7].map(word => word.toString(16).padStart(8, '0')).join('')
}

const rotr = (value: number, bits: number): number => ((value >>> bits) | (value << (32 - bits))) >>> 0

/** A schedule or constant-table read. The caller only asks for an index the table holds. */
const take = (value: number | undefined): number => {
  if (value === undefined) throw new Error('sha')
  return value
}
