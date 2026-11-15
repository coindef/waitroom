/**
 * The paths you asked about, and whether this turn touched them.
 *
 * No engine and no `$`, so the tests exercise it directly. It does not read a
 * transcript, call a model, or open a connection. A path is data: it is
 * checked, stored, and reported. It is never treated as an instruction, and
 * it is never a reason to block an edit.
 */

/** How many paths one list holds. A fourth is refused. */
export const MAX_PATHS = 3

/**
 * Changed files under the list that one read will hash. Past this, the read
 * fails open: guessing untouched would be a lie, and hashing a whole tree
 * would hold the turn.
 */
export const MAX_STAMPED = 40

/** Columns the status line may use. One column past this becomes an ellipsis. */
export const STATUS_COLUMNS = 48

/** What `/wait-focus` prints when nothing is watched. */
export const HELP = '/wait-focus src/auth/ or package.json · up to 3'

/** What `/wait-focus` prints when a fourth path is named. The list already stored stays. */
export const TOO_MANY = '3 paths max · name one to three, like src/auth/ or package.json'

/** What `/wait-focus clear` prints. */
export const CLEARED = 'cleared'

/** A missing project root. Nothing is saved, and no shorter key is tried. */
export const NO_ROOT = 'no paths kept · no project root'

/** A token that is not a path inside the project. */
export const EMPTY_PATH = 'name a path inside this repo · /wait-focus src/auth/ or package.json'

/** The list could not be written. The previous list is still the one stored. */
export const SAVED_FAIL = 'no paths kept · the list could not be saved'

const ELLIPSIS = '…'

export type StoredWatches = { v: 1; paths: string[] }

export type Decision =
  | { type: 'show' }
  | { type: 'clear' }
  | { type: 'reject'; text: string }
  | { type: 'set'; paths: string[] }

export type Change = { kind: 'present' | 'absent'; path: string }

export type StampPlan =
  | { ok: true; present: string[]; absent: string[]; untracked: string[] }
  | { ok: false }

export type FileStamp = { path: string; stamp: string }

export type Verdict = { path: string; touched: boolean }

type Normalized = { ok: true; path: string } | { ok: false; reason: 'outside' | 'empty' }

const collapse = (path: string): string => {
  const [head = '', ...rest] = path.split('/')
  const kept: string[] = []
  for (const part of rest) {
    if (part === '' || part === '.') continue
    if (part === '..') kept.pop()
    else kept.push(part)
  }

  return [head, ...kept].join('/')
}

/** A root with a drive letter, slashes, and `.` / `..` collapsed. A relative path is refused. */
export const canonicalRoot = (root: string): string | undefined => {
  if (typeof root !== 'string') return undefined
  const slashed = root.replace(/\\/g, '/').trim()
  if (slashed === '') return undefined
  const drive = /^[A-Za-z]:\//.test(slashed)
  if (!slashed.startsWith('/') && !drive) return undefined
  const letter = slashed[0]
  if (drive && letter === undefined) return undefined
  const upper = drive && letter !== undefined ? letter.toUpperCase() + slashed.slice(1) : slashed
  const collapsed = collapse(upper).replace(/\/+$/, '')

  return collapsed === '' ? '/' : collapsed
}

const relativeTo = (base: string, full: string): string | undefined => {
  const folds = /^[A-Z]:\//.test(base)
  const left = folds ? base.toLowerCase() : base
  const right = folds ? full.toLowerCase() : full
  if (left === right) return ''
  if (base === '/') return full.startsWith('/') && full !== '/' ? full.slice(1) : undefined

  return right.startsWith(`${left}/`) ? full.slice(base.length + 1) : undefined
}

const isAbsolute = (path: string): boolean => path.startsWith('/') || /^[A-Za-z]:\//.test(path)

/** A path git printed that is safe to hand back to `git hash-object`. */
const safePath = (path: string): boolean =>
  path !== '' && !path.includes('\0') && !isAbsolute(path) && !path.split('/').includes('..')

const displayToken = (token: string): string =>
  token.replace(/[\u0000-\u001F\u007F]/g, '').trim().slice(0, 180)

/** `${token} is outside this repo · name a path inside it`. */
export const outsideLine = (token: string): string => {
  const shown = displayToken(token)

  return shown === '' ? EMPTY_PATH : `${shown} is outside this repo · name a path inside it`
}

/**
 * One path as the list keeps it: relative to the project root, trailing slash
 * kept when you wrote a folder. Absolute, and `..` that leaves the root, are
 * outside. A path that is not on disk yet is still a path.
 */
export const normalizeWatch = (root: string, raw: string): Normalized => {
  const base = canonicalRoot(root)
  if (base === undefined) return { ok: false, reason: 'empty' }
  const slashed = raw.replace(/\\/g, '/').trim()
  if (slashed === '' || /^[A-Za-z]:$/.test(slashed)) return { ok: false, reason: 'empty' }
  const asFolder = slashed.endsWith('/')
  const joined = isAbsolute(slashed) ? slashed : `${base}/${slashed}`
  const collapsed = collapse(joined).replace(/\/+$/, '')
  const rel = relativeTo(base, collapsed)
  if (rel === undefined) return { ok: false, reason: 'outside' }
  if (rel === '') return { ok: true, path: '.' }

  return { ok: true, path: asFolder ? `${rel}/` : rel }
}

/** Quoted paths stay whole. Commas and whitespace separate the rest. */
export const tokenize = (args: string): string[] => {
  const tokens: string[] = []
  for (const match of args.matchAll(/"([^"]*)"|'([^']*)'|([^\s,]+)/g)) {
    const token = match[1] ?? match[2] ?? match[3] ?? ''
    if (token !== '') tokens.push(token)
  }

  return tokens
}

const watchId = (path: string): string => (path === '.' ? '.' : path.replace(/\/+$/, ''))

/**
 * What `/wait-focus` does to the list.
 *
 * `clear` is the only word that clears, and only when it is the whole
 * command. More than three paths, or a path outside the project, changes
 * nothing. A missing root changes nothing.
 */
export const decide = (args: string, root: string | undefined): Decision => {
  if (root === undefined || canonicalRoot(root) === undefined) return { type: 'reject', text: NO_ROOT }
  const tokens = tokenize(args)
  if (tokens.length === 0) return { type: 'show' }
  if (tokens.length === 1 && tokens[0] === 'clear') return { type: 'clear' }
  const paths: string[] = []
  const seen = new Set<string>()
  for (const token of tokens) {
    const one = normalizeWatch(root, token)
    if (!one.ok) return { type: 'reject', text: one.reason === 'outside' ? outsideLine(token) : EMPTY_PATH }
    const id = watchId(one.path)
    if (seen.has(id)) continue
    seen.add(id)
    paths.push(one.path)
  }
  if (paths.length > MAX_PATHS) return { type: 'reject', text: TOO_MANY }
  if (paths.length === 0) return { type: 'show' }

  return { type: 'set', paths }
}

/** The reply once the list is the one that will be watched. */
export const watchingLine = (paths: readonly string[], missing: readonly string[], git: boolean): string => {
  const gone = new Set(missing)
  const body = paths.map(path => (gone.has(path) ? `${path} (not on disk yet)` : path)).join(' · ')
  const line = `watching ${body}`

  return git ? line : `${line} · not a git repo, so a turn here stays quiet`
}

/** `/wait-focus` with no arguments: the list, or the help line when it is empty. */
export const showLine = (paths: readonly string[], missing: readonly string[], git: boolean): string =>
  paths.length === 0 ? HELP : watchingLine(paths, missing, git)

const rotr = (value: number, bits: number): number => (value >>> bits) | (value << (32 - bits))

const utf8 = (text: string): number[] => {
  const bytes: number[] = []
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0
    if (code < 0x80) bytes.push(code)
    else if (code < 0x800) bytes.push(0xc0 | (code >> 6), 0x80 | (code & 0x3f))
    else if (code < 0x10000) bytes.push(0xe0 | (code >> 12), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f))
    else bytes.push(0xf0 | (code >> 18), 0x80 | ((code >> 12) & 0x3f), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f))
  }

  return bytes
}

const SHA_K = [
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98,
  0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786,
  0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8,
  0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
  0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819,
  0xd6990624, 0xf40e3585, 0x106aa070, 0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a,
  0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7,
  0xc67178f2,
]

/** SHA-256 hex. The hooks module has no Node crypto; the hash only separates store keys. */
const digest = (text: string): string => {
  const bytes = utf8(text)
  const bitLength = bytes.length * 8
  bytes.push(0x80)
  while (bytes.length % 64 !== 56) bytes.push(0)
  const high = Math.floor(bitLength / 0x100000000)
  const low = bitLength >>> 0
  for (const shift of [24, 16, 8, 0]) bytes.push((high >>> shift) & 0xff)
  for (const shift of [24, 16, 8, 0]) bytes.push((low >>> shift) & 0xff)

  const hash = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]
  const words = new Array<number>(64)
  for (let block = 0; block < bytes.length; block += 64) {
    for (let i = 0; i < 16; i += 1) {
      const at = block + i * 4
      words[i] = ((bytes[at]! << 24) | (bytes[at + 1]! << 16) | (bytes[at + 2]! << 8) | bytes[at + 3]!) >>> 0
    }
    for (let i = 16; i < 64; i += 1) {
      const w15 = words[i - 15]!
      const w2 = words[i - 2]!
      const s0 = (rotr(w15, 7) ^ rotr(w15, 18) ^ (w15 >>> 3)) >>> 0
      const s1 = (rotr(w2, 17) ^ rotr(w2, 19) ^ (w2 >>> 10)) >>> 0
      words[i] = (words[i - 16]! + s0 + words[i - 7]! + s1) >>> 0
    }
    let a = hash[0]!
    let b = hash[1]!
    let c = hash[2]!
    let d = hash[3]!
    let e = hash[4]!
    let f = hash[5]!
    let g = hash[6]!
    let h = hash[7]!
    for (let i = 0; i < 64; i += 1) {
      const s1 = (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) >>> 0
      const ch = ((e & f) ^ (~e & g)) >>> 0
      const temp1 = (h + s1 + ch + SHA_K[i]! + words[i]!) >>> 0
      const s0 = (rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) >>> 0
      const maj = ((a & b) ^ (a & c) ^ (b & c)) >>> 0
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
    hash[0] = (hash[0]! + a) >>> 0
    hash[1] = (hash[1]! + b) >>> 0
    hash[2] = (hash[2]! + c) >>> 0
    hash[3] = (hash[3]! + d) >>> 0
    hash[4] = (hash[4]! + e) >>> 0
    hash[5] = (hash[5]! + f) >>> 0
    hash[6] = (hash[6]! + g) >>> 0
    hash[7] = (hash[7]! + h) >>> 0
  }

  return hash.map(word => word.toString(16).padStart(8, '0')).join('')
}

/**
 * The store key for this project. Undefined when the root is missing or
 * relative, so two folders are never collapsed onto one key. The session id
 * is not part of it: the list is about the project.
 */
export const focusKey = (root: string): string | undefined => {
  const canonical = canonicalRoot(root)
  if (canonical === undefined) return undefined

  return `focus/${digest(`root\0${canonical}`)}`
}

export const toStored = (paths: readonly string[]): StoredWatches => ({ v: 1, paths: [...paths] })

/** A value this mod did not write is no list. At most three paths come back. */
export const watchesFromStore = (raw: unknown): string[] => {
  if (typeof raw !== 'object' || raw === null) return []
  const row = raw as { v?: unknown; paths?: unknown }
  if (row.v !== 1 || !Array.isArray(row.paths)) return []
  const paths: string[] = []
  for (const path of row.paths) {
    if (typeof path !== 'string' || path === '') continue
    paths.push(path)
    if (paths.length === MAX_PATHS) break
  }

  return paths
}

/**
 * `git diff --name-status -z -M` records. A rename or a copy names two paths:
 * the old one is gone, the new one is here. A delete names one path that is
 * gone. Anything else names one path that is here.
 */
export const parseNameStatusZ = (output: string): Change[] => {
  const parts = output.split('\0')
  const changes: Change[] = []
  let at = 0
  while (at < parts.length) {
    const status = parts[at]
    if (status === undefined || status === '') break
    const code = status[0]
    if (code === 'R' || code === 'C') {
      const from = parts[at + 1]
      const to = parts[at + 2]
      if (from === undefined || to === undefined || from === '' || to === '') break
      changes.push({ kind: 'absent', path: from }, { kind: 'present', path: to })
      at += 3
      continue
    }
    const path = parts[at + 1]
    if (path === undefined || path === '') break
    changes.push({ kind: code === 'D' ? 'absent' : 'present', path })
    at += 2
  }

  return changes
}

/** NUL-separated paths. Nothing is trimmed: a name may begin or end with a space. */
export const splitNul = (output: string): string[] => output.split('\0').filter(path => path !== '')

/** Whether a watched file or folder covers a path git reported. */
export const covers = (watch: string, changed: string): boolean => {
  const base = watch === '.' ? '' : watch.replace(/\/+$/, '')
  if (base === '') return changed !== ''

  return changed === base || changed.startsWith(`${base}/`)
}

/**
 * The changed paths a read will hash, limited to the watch list. An unsafe
 * path or a list past the cap fails the whole read: a partial hash would
 * report untouched for a file that was skipped.
 */
export const planStamps = (
  changes: readonly Change[],
  untracked: readonly string[],
  watches: readonly string[],
): StampPlan => {
  const present: string[] = []
  const absent: string[] = []
  const extra: string[] = []
  const seen = new Set<string>()
  const watched = (path: string): boolean => watches.some(watch => covers(watch, path))
  for (const change of changes) {
    if (!watched(change.path)) continue
    if (!safePath(change.path)) return { ok: false }
    if (change.kind === 'absent') {
      absent.push(change.path)
      continue
    }
    if (seen.has(change.path)) continue
    seen.add(change.path)
    present.push(change.path)
  }
  for (const path of untracked) {
    if (!watched(path)) continue
    if (!safePath(path)) return { ok: false }
    if (seen.has(path)) continue
    seen.add(path)
    extra.push(path)
  }
  if (present.length + extra.length > MAX_STAMPED) return { ok: false }

  return { ok: true, present, absent, untracked: extra }
}

/**
 * One stamp per watched path that differs from HEAD, or that is untracked.
 * Undefined when a file that should have a hash has none: the caller fails
 * open instead of calling that file untouched.
 */
export const stampsFor = (
  plan: { present: readonly string[]; absent: readonly string[]; untracked: readonly string[] },
  hashes: ReadonlyMap<string, string>,
): FileStamp[] | undefined => {
  const stamps: FileStamp[] = []
  for (const path of plan.absent) stamps.push({ path, stamp: 'absent' })
  for (const path of plan.present) {
    const hash = hashes.get(path)
    if (hash === undefined || hash === '') return undefined
    stamps.push({ path, stamp: hash })
  }
  for (const path of plan.untracked) {
    const hash = hashes.get(path)
    if (hash === undefined || hash === '') return undefined
    stamps.push({ path, stamp: `new:${hash}` })
  }

  return stamps
}

/** Paths whose stamp changed between the start of the turn and the end. Sorted. */
export const touchedPaths = (before: readonly FileStamp[], after: readonly FileStamp[]): string[] => {
  const fold = (stamps: readonly FileStamp[]): Map<string, string[]> => {
    const out = new Map<string, string[]>()
    for (const stamp of stamps) {
      const list = out.get(stamp.path)
      if (list === undefined) out.set(stamp.path, [stamp.stamp])
      else list.push(stamp.stamp)
    }

    return out
  }
  const left = fold(before)
  const right = fold(after)
  const names = [...new Set([...left.keys(), ...right.keys()])].sort()

  return names.filter(name => (left.get(name) ?? []).join('\0') !== (right.get(name) ?? []).join('\0'))
}

/** One verdict per watched path, in the order you named them. */
export const verdicts = (watches: readonly string[], changed: readonly string[]): Verdict[] =>
  watches.map(path => ({ path, touched: changed.some(one => covers(path, one)) }))

const chars = (text: string): string[] => [...text]

/** Cut to `max` code points. The last one is an ellipsis when anything is cut. */
export const truncateColumns = (text: string, max: number): string => {
  const all = chars(text)
  if (all.length <= max) return text

  return all.slice(0, Math.max(0, max - 1)).join('') + ELLIPSIS
}

/**
 * The status line after a turn: each path, then `touched` or `untouched`.
 * Undefined when nothing is watched, so an empty list draws no line.
 */
export const statusLine = (rows: readonly Verdict[]): string | undefined => {
  if (rows.length === 0) return undefined

  return truncateColumns(
    rows.map(row => `${row.path} ${row.touched ? 'touched' : 'untouched'}`).join(' · '),
    STATUS_COLUMNS,
  )
}
