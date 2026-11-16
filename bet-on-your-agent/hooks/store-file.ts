import type { EngineInterface } from 'claude-code'

/**
 * The engine's plugin store. `$.store` reads and writes it, but a hook
 * cannot ask for the path or the storage id: those stay inside the host.
 * The file is `<root>/store/<fileName(source)>`.
 *
 * `source` is this copy's own id. A marketplace install lives at
 * `<root>/cache/<marketplace>/<plugin>/<version>/`, so the id is
 * `<plugin>@<marketplace>`. Anything else loaded from its own directory
 * (`--plugin-dir`, and this repository) is `<plugin>@inline`. A path that
 * does not name a plugin falls back to the bare plugin name. Another
 * install's file is never opened, and a directory listing is never used
 * to pick one.
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
 * This copy's store id, from the file URL the engine loaded. A cache
 * install names its marketplace. A directory that is not a cache install
 * is `@inline` (`--plugin-dir`). A URL that does not name the plugin is
 * the bare name, which is the id the engine uses when it has no source.
 */
export function sourceIdFor(moduleUrl: string): string {
  const market = marketplaceFrom(moduleUrl)
  if (market !== undefined) return `${PLUGIN}@${market}`
  if (pluginNameFrom(moduleUrl) === undefined) return PLUGIN
  return `${PLUGIN}@inline`
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
  return `${root}/store/${storeFileName(sourceIdFor(import.meta.url))}`
}

/**
 * Make one unreadable store file readable again, so the next save lands.
 * Only this install's file is touched. The engine's lock (`<path>.lock`,
 * taken the way proper-lockfile does, by creating that directory) is held
 * for the repair. If it is already held, this turn is left alone.
 * A missing file is left alone. Zero bytes become `{}` with no backup.
 * Invalid JSON, JSON that is not an object, and an object whose `turns`
 * is not a list are copied aside and rebuilt. The first backup stays at
 * `<path>.bak`; a later one is `<path>.bak-<ms>`.
 */
export async function repairPluginStore($: EngineInterface): Promise<StoreRepair> {
  let lock: string | undefined
  try {
    const path = await storeFilePath($)
    if (path === undefined) return 'none'
    if (!(await $.fs.exists(path))) return 'none'
    const taken = (await $.process.run(['mkdir', `${path}.lock`])) as { exitCode?: number }
    if (taken.exitCode !== 0) return 'none'
    lock = `${path}.lock`
    return await repairFile($, path)
  } catch {
    return 'none'
  } finally {
    if (lock !== undefined) await $.process.run(['rmdir', lock]).catch(() => undefined)
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

const pluginNameFrom = (moduleUrl: string): string | undefined => {
  const parts = moduleUrl.replace(/\\/g, '/').split(/[/]+/)
  const hooksAt = parts.lastIndexOf('hooks')
  if (hooksAt > 0 && parts[hooksAt - 1] === PLUGIN) return PLUGIN
  return undefined
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
  const bits = new Uint8Array(message.length)
  for (let i = 0; i < message.length; i++) bits[i] = message.charCodeAt(i) & 0xff
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
      const s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3)
      const s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10)
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0
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
      const temp1 = (h + s1 + ch + k[i] + w[i]) >>> 0
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
