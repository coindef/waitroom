/**
 * The note you leave for yourself: a goal, and what to check when you come back.
 *
 * No engine and no `$`, so the tests exercise it directly. It does not read a
 * transcript, call a model, or open a connection. The text of a note is data.
 * It is cleaned and stored, and it is never treated as an instruction.
 */

/** What `/anchor` prints when there is no note, or the text was not the two-part form. */
export const HELP = "/anchor what you're doing · check: what to verify"

/** Columns the status line may use. One column past this becomes an ellipsis. */
export const STATUS_COLUMNS = 48

/** The most a goal or a check keeps, in graphemes. A paste is not a note. */
const MAX_NOTE = 500

const SEPARATOR = ' · check: '

const ELLIPSIS = '…'

export type Note = {
  goal: string
  check: string
  /** Stop has ended a main-loop turn, and the next prompt has not been reminded yet. */
  awaitingReturn: boolean
}

export type StoredNote = {
  v: 1
  goal: string
  check: string
  awaitingReturn: boolean
}

export type IdentityGap = 'session' | 'project' | 'both'

export type Command =
  | { type: 'show' }
  | { type: 'clear' }
  | { type: 'set'; goal: string; check: string }
  | { type: 'invalid' }

export type Outcome = {
  text: string
  note: Note | null
  /** `undefined` means the status line is absent. */
  status: string | undefined
  /** When false, the store is left untouched. A missing identity never writes. */
  persist: boolean
}

type SegmenterCtor = new (
  locales?: string,
  options?: { granularity: 'grapheme' },
) => { segment: (input: string) => Iterable<{ segment: string }> }

const segmenterOf = (): SegmenterCtor | undefined =>
  (Intl as unknown as { Segmenter?: SegmenterCtor }).Segmenter

const graphemes = (text: string): string[] => {
  const Segmenter = segmenterOf()
  if (Segmenter === undefined) return [...text]

  return [...new Segmenter(undefined, { granularity: 'grapheme' }).segment(text)].map(part => part.segment)
}

/**
 * CSI, OSC, and a lone ESC-Fe sequence. Stripped before control characters,
 * so a color code does not leave its letters behind as part of the note.
 */
const ANSI =
  /\u001B(?:\][^\u0007]*(?:\u0007|\u001B\\)|\[[0-?]*[ -/]*[@-~]|[@-Z\\-_])/g

/** C0, DEL, and C1. Newlines included: a note is one line. */
const CONTROLS = /[\u0000-\u001F\u007F-\u009F]/g

/** Invisible format characters that are not the joiner inside an emoji. */
const INVISIBLE = /[\u200B\u200C\uFEFF]/g

/**
 * The note as text, nothing else.
 *
 * ANSI sequences and control characters are removed, so they cannot repaint
 * the terminal or start a new line. What remains is trimmed, collapsed, and
 * capped. An empty result is not a note.
 */
export const sanitize = (value: unknown): string => {
  if (typeof value !== 'string') return ''
  const plain = value.replace(ANSI, '').replace(CONTROLS, ' ').replace(INVISIBLE, '').normalize('NFC')
  const collapsed = plain.replace(/\s+/g, ' ').trim()

  return graphemes(collapsed).slice(0, MAX_NOTE).join('')
}

const isZeroWidth = (code: number): boolean =>
  (code >= 0x0300 && code <= 0x036f) ||
  (code >= 0x20d0 && code <= 0x20ff) ||
  (code >= 0xfe00 && code <= 0xfe0f) ||
  code === 0x200b ||
  code === 0x200c ||
  code === 0x200d ||
  code === 0xfeff

/** Wide or emoji code points take two columns. The anchor and the arrow take one. */
const isWide = (code: number): boolean =>
  (code >= 0x1100 && code <= 0x115f) ||
  code === 0x2329 ||
  code === 0x232a ||
  (code >= 0x2e80 && code <= 0xa4cf) ||
  (code >= 0xac00 && code <= 0xd7a3) ||
  (code >= 0xf900 && code <= 0xfaff) ||
  (code >= 0xfe10 && code <= 0xfe19) ||
  (code >= 0xfe30 && code <= 0xfe6f) ||
  (code >= 0xff00 && code <= 0xff60) ||
  (code >= 0xffe0 && code <= 0xffe6) ||
  (code >= 0x1f300 && code <= 0x1f64f) ||
  (code >= 0x1f680 && code <= 0x1faff) ||
  (code >= 0x20000 && code <= 0x3fffd)

const graphemeWidth = (grapheme: string): number => {
  let width = 0
  for (const char of grapheme) {
    const code = char.codePointAt(0) ?? 0
    if (isZeroWidth(code)) continue
    width = Math.max(width, isWide(code) ? 2 : 1)
  }

  return width
}

/** Visible columns, one grapheme at a time, so a joiner is not a column of its own. */
export const columnWidth = (text: string): number =>
  graphemes(text).reduce((width, grapheme) => width + graphemeWidth(grapheme), 0)

/**
 * Cut to `max` columns. The last column is an ellipsis when anything is cut,
 * and a grapheme that would not fit is left off whole.
 */
export const truncateColumns = (text: string, max: number): string => {
  if (columnWidth(text) <= max) return text
  const mark = columnWidth(ELLIPSIS)
  const budget = Math.max(0, max - mark)
  let width = 0
  let kept = ''
  for (const grapheme of graphemes(text)) {
    const next = graphemeWidth(grapheme)
    if (width + next > budget) break
    kept += grapheme
    width += next
  }

  return kept + ELLIPSIS
}

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

/**
 * The project root the host reported, with slashes and `.` / `..` collapsed.
 *
 * A relative path is refused. A basename such as `app` would be the same for
 * two directories, and this function will not invent a root from one.
 */
export const canonicalRoot = (root: string): string | undefined => {
  if (typeof root !== 'string') return undefined
  const slashed = root.replace(/\\/g, '/').trim()
  if (slashed === '') return undefined
  const drive = /^[A-Za-z]:\//.test(slashed)
  if (!slashed.startsWith('/') && !drive) return undefined
  const letter = slashed[0]
  if (drive && letter === undefined) return undefined
  const collapsed = collapse(drive && letter !== undefined ? letter.toUpperCase() + slashed.slice(1) : slashed).replace(
    /\/+$/,
    '',
  )

  return collapsed === '' ? '/' : collapsed
}

const rotr = (value: number, bits: number): number => (value >>> bits) | (value << (32 - bits))

/** UTF-8 bytes. The key is a hash of the path, and a path may hold any character. */
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

/**
 * SHA-256 of a string, hex. Web `crypto` is not in this mod's type lib, and the
 * hooks module has no Node crypto. The hash only separates store keys.
 */
const digest = (text: string): string => {
  const bytes = utf8(text)
  const bitLength = bytes.length * 8
  bytes.push(0x80)
  while ((bytes.length % 64) !== 56) bytes.push(0)
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
 * One store key for this project and this host session.
 *
 * The key is undefined unless both are present. There is no project-only key
 * and no session-only key, so a missing id cannot fall through onto a note
 * another session can read. The process id is not an input.
 */
export const noteKey = (root: string, sessionId: string): string | undefined => {
  const canonical = canonicalRoot(root)
  const id = typeof sessionId === 'string' ? sessionId.trim() : ''
  if (canonical === undefined || id === '') return undefined

  return `note/${digest(`root\0${canonical}`)}/${digest(`session\0${id}`)}`
}

/** Which half of the identity the host did not give. Undefined when both are usable. */
export const identityGap = (root: unknown, sessionId: unknown): IdentityGap | undefined => {
  const rootOk = typeof root === 'string' && canonicalRoot(root) !== undefined
  const idOk = typeof sessionId === 'string' && sessionId.trim() !== ''
  if (rootOk && idOk) return undefined
  if (!rootOk && !idOk) return 'both'
  if (!idOk) return 'session'

  return 'project'
}

/** Why nothing was saved. It names the missing half, and it does not show another session's note. */
export const missingLine = (gap: IdentityGap): string => {
  if (gap === 'session') {
    return 'no note kept · no stable session id · a note here would be shared across sessions, so nothing was saved'
  }
  if (gap === 'project') {
    return 'no note kept · no project root · a note here would be shared across projects, so nothing was saved'
  }

  return 'no note kept · no project root and no stable session id · a note here would be shared, so nothing was saved'
}

export const showLine = (note: Note): string => `${note.goal} · check: ${note.check}`

export const backLine = (check: string): string => `Back? You said: ${check}.`

/** The status sentence. Undefined only when there is no note, so an empty note draws no line. */
export const statusFor = (note: Note | null): string | undefined => {
  if (note === null) return undefined

  return truncateColumns(`⚓ ${note.goal} → ${note.check}`, STATUS_COLUMNS)
}

export const parseAnchorCommand = (args: string): Command => {
  const trimmed = args.trim()
  if (trimmed === '') return { type: 'show' }
  if (trimmed === 'clear') return { type: 'clear' }
  const at = trimmed.indexOf(SEPARATOR)
  if (at === -1) return { type: 'invalid' }
  const goal = sanitize(trimmed.slice(0, at))
  const check = sanitize(trimmed.slice(at + SEPARATOR.length))
  if (goal === '' || check === '') return { type: 'invalid' }

  return { type: 'set', goal, check }
}

export const replaceNote = (previous: Note | null, goal: string, check: string): Note => ({
  goal,
  check,
  awaitingReturn: previous?.awaitingReturn === true,
})

/**
 * What `/anchor` does to the note.
 *
 * A missing identity persists nothing and clears nothing: the caller has no
 * safe key, and this does not offer a shorter one.
 */
export const onCommand = (args: string, current: Note | null, gap: IdentityGap | undefined): Outcome => {
  if (gap !== undefined) {
    return { text: missingLine(gap), note: null, status: undefined, persist: false }
  }
  const parsed = parseAnchorCommand(args)
  if (parsed.type === 'show') {
    return current === null
      ? { text: HELP, note: null, status: undefined, persist: false }
      : { text: showLine(current), note: current, status: statusFor(current), persist: false }
  }
  if (parsed.type === 'invalid') {
    return { text: HELP, note: current, status: statusFor(current), persist: false }
  }
  if (parsed.type === 'clear') {
    return { text: 'cleared', note: null, status: undefined, persist: true }
  }
  const note = replaceNote(current, parsed.goal, parsed.check)

  return { text: showLine(note), note, status: statusFor(note), persist: true }
}

/** A main-loop turn ended. The note stays. The next prompt is the one that gets the reminder. */
export const onStop = (note: Note | null, isSubagent: boolean): Note | null => {
  if (note === null || isSubagent) return note
  if (note.awaitingReturn) return note

  return { ...note, awaitingReturn: true }
}

/**
 * The first prompt after Stop. A prompt that is not the person's leaves the
 * reminder for the one that is. A second prompt finds the flag already down.
 */
export const onPrompt = (note: Note | null, isPerson: boolean): { note: Note | null; line?: string } => {
  if (note === null || !isPerson || !note.awaitingReturn) return { note }

  return { note: { ...note, awaitingReturn: false }, line: backLine(note.check) }
}

/** One JSON value. The store writes this whole object, not a shared map of every session. */
export const toStored = (note: Note): StoredNote => ({
  v: 1,
  goal: note.goal,
  check: note.check,
  awaitingReturn: note.awaitingReturn,
})

/** A value this mod did not write, or can no longer read, is no note. */
export const noteFromStore = (raw: unknown): Note | null => {
  if (typeof raw !== 'object' || raw === null) return null
  const row = raw as { v?: unknown; goal?: unknown; check?: unknown; awaitingReturn?: unknown }
  if (row.v !== 1) return null
  const goal = sanitize(row.goal)
  const check = sanitize(row.check)
  if (goal === '' || check === '') return null

  return { goal, check, awaitingReturn: row.awaitingReturn === true }
}

/** Where a prompt the person typed comes from. A task notice or a slash command is not one. */
const PERSON_ORIGINS = new Set(['composer', 'bridge'])

export const isPersonsPrompt = (prompt: {
  origin?: { kind?: string }
  command?: unknown
  isMeta?: boolean
}): boolean => prompt.command === undefined && prompt.isMeta !== true && PERSON_ORIGINS.has(prompt.origin?.kind ?? '')
