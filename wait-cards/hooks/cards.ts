/**
 * Your deck, the boxes, and the lines this mod draws.
 *
 * No engine and no `$`, so the tests exercise it directly. It does not read a
 * transcript, call a model, or open a connection. Deck text is data: it is
 * cleaned and shown to you, and never treated as an instruction.
 */

/** The one line logged when there is no deck. */
export const HINT = 'Add cards to ~/.waitroom/cards.md'

/** Where the deck lives, under the home directory. */
const DECK_FILE = '.waitroom/cards.md'

/** Columns the status line may use. One column past this becomes an ellipsis. */
export const STATUS_COLUMNS = 48

/** The most a question or an answer keeps, in graphemes. */
const MAX_TEXT = 500

/** Characters of the deck file that are parsed. The rest is ignored. */
export const MAX_DECK_CHARS = 256 * 1024

/** Cards kept from one deck. A deck past this is cut, in deck order. */
export const MAX_CARDS = 1000

/** Waits until a card in box 1..5 is due again. */
export const INTERVALS = [1, 2, 4, 8, 16] as const

const TOP_BOX = INTERVALS.length

/** What follows the answer, so you know how to mark it. */
export const ANSWER_SUFFIX = ' · /card got or /card miss'

const CARD_MARK = 'Q: '

const ELLIPSIS = '…'

export type Card = { id: string; question: string; answer: string }

export type Deck = { cards: Card[]; skipped: number }

/**
 * One card's place in the boxes. `due` and `shown` count waits, not time:
 * `due` is the wait it is next due on, `shown` the wait it was last on screen
 * (-1 for never).
 */
export type CardRecord = { box: number; due: number; shown: number }

export type StoredRecord = { v: 1 } & CardRecord

export type Mark = 'got' | 'miss'

export type CardCommand = Mark | 'show' | 'invalid'

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

/** C0, DEL, C1, and the line and paragraph separators. Each becomes a space, so a card stays on one line. */
const CONTROLS = /[\u0000-\u001F\u007F-\u009F\u2028\u2029]/g

/**
 * Zero-width and byte-order marks, and the bidi marks, embeddings, overrides
 * and isolates that can reorder a line. The joiner inside an emoji stays.
 * Together with CONTROLS this is the set wait-notify drops.
 */
const INVISIBLE = /[\u200B\u200C\u200E\u200F\u202A-\u202E\u2066-\u2069\uFEFF]/g

/**
 * Deck text as text, nothing else.
 *
 * ANSI sequences and control characters are removed, so they cannot repaint
 * the terminal or start a new line. What remains is trimmed, collapsed, and
 * capped. An empty result is no question or no answer.
 */
export const sanitize = (value: unknown): string => {
  if (typeof value !== 'string') return ''
  const plain = value.replace(ANSI, '').replace(CONTROLS, ' ').replace(INVISIBLE, '').normalize('NFC')
  const collapsed = plain.replace(/\s+/g, ' ').trim()

  return graphemes(collapsed).slice(0, MAX_TEXT).join('')
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

const rotr = (value: number, bits: number): number => (value >>> bits) | (value << (32 - bits))

/** UTF-8 bytes. The id is a hash of the question, and a question may hold any character. */
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
 * hooks module has no Node crypto. The hash only names a card's store key.
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

/** A card is its question: editing the answer keeps the box, a new question is a new card. */
export const cardId = (question: string): string => digest(question).slice(0, 16)

export const deckPathOf = (home: string): string => `${home.replace(/\/+$/, '')}/${DECK_FILE}`

const Q_LINE = /^\s*(?:[-*]\s+)?q:(.*)$/i
const A_LINE = /^\s*(?:[-*]\s+)?a:(.*)$/i
const FENCE = /^\s*(?:```|~~~)/
const HEADING = /^\s*#/

/**
 * Q/A pairs, in deck order.
 *
 * A card is a `Q:` line and the `A:` line after it. Lines after the `A:` line
 * join the answer until a blank line, a heading, or the next `Q:`. A `Q:` with
 * no answer, an `A:` with no question, an empty side, and a repeated question
 * are skipped and counted, never guessed. Fenced code and HTML comments are
 * not read.
 */
export const parseDeck = (text: unknown): Deck => {
  const cards: Card[] = []
  const seen = new Set<string>()
  let skipped = 0
  if (typeof text !== 'string') return { cards, skipped }
  const body = text.slice(0, MAX_DECK_CHARS).replace(/<!--[\s\S]*?(?:-->|$)/g, '')

  let question: string[] | undefined
  let answer: string[] | undefined

  const close = (): void => {
    if (question === undefined) return
    const q = sanitize(question.join(' '))
    const a = sanitize((answer ?? []).join(' '))
    question = undefined
    answer = undefined
    if (q === '' || a === '') {
      skipped += 1
      return
    }
    const id = cardId(q)
    if (seen.has(id)) {
      skipped += 1
      return
    }
    seen.add(id)
    if (cards.length < MAX_CARDS) cards.push({ id, question: q, answer: a })
  }

  let fenced = false
  for (const line of body.split(/\r\n|\r|\n/)) {
    if (FENCE.test(line)) {
      close()
      fenced = !fenced
      continue
    }
    if (fenced) continue
    const isQ = Q_LINE.exec(line)
    if (isQ !== null) {
      close()
      question = [isQ[1] ?? '']
      continue
    }
    const isA = A_LINE.exec(line)
    if (isA !== null) {
      if (question !== undefined && answer === undefined) {
        answer = [isA[1] ?? '']
      } else {
        close()
        skipped += 1
      }
      continue
    }
    if (HEADING.test(line)) {
      close()
      continue
    }
    if (line.trim() === '') {
      if (answer !== undefined) close()
      continue
    }
    if (answer !== undefined) answer.push(line)
  }
  close()

  return { cards, skipped }
}

export const newRecord = (): CardRecord => ({ box: 1, due: 0, shown: -1 })

const intervalOf = (box: number): number => INTERVALS[Math.min(TOP_BOX, Math.max(1, box)) - 1] ?? 1

/** `got` moves up one box, to the top at most. `miss` goes back to box 1. Both count from wait `tick`. */
export const markCard = (record: CardRecord, mark: Mark, tick: number): CardRecord => {
  const box = mark === 'got' ? Math.min(TOP_BOX, record.box + 1) : 1

  return { box, due: tick + intervalOf(box), shown: record.shown }
}

/** On screen at wait `tick`. The box does not move until you mark it. */
export const shownRecord = (record: CardRecord, tick: number): CardRecord => ({ ...record, shown: tick })

const isWait = (value: unknown): value is number => typeof value === 'number' && Number.isInteger(value)

/** A value this mod did not write, or can no longer read, is a new card. */
export const recordFromStore = (raw: unknown): CardRecord | undefined => {
  if (typeof raw !== 'object' || raw === null) return undefined
  const row = raw as { v?: unknown; box?: unknown; due?: unknown; shown?: unknown }
  if (row.v !== 1 || !isWait(row.box) || !isWait(row.due) || !isWait(row.shown)) return undefined
  if (row.box < 1 || row.box > TOP_BOX) return undefined

  return { box: row.box, due: row.due, shown: row.shown }
}

export const toStored = (record: CardRecord): StoredRecord => ({ v: 1, ...record })

const less = (a: readonly number[], b: readonly number[]): boolean => {
  for (let i = 0; i < a.length; i += 1) {
    if (a[i]! !== b[i]!) return a[i]! < b[i]!
  }

  return false
}

const recordOf = (records: ReadonlyMap<string, CardRecord>, id: string): CardRecord => records.get(id) ?? newRecord()

/**
 * The sort key for wait `tick`. The lowest key shows. A mark sets `due` past
 * `shown`, and showing a due card sets `shown` to `due` or later. So a due
 * card with `shown < due` was marked after it last showed, or last showed
 * early, when nothing was due.
 */
const rankOf = (record: CardRecord, tick: number): [number, number, number, number] => {
  if (record.due > tick) return [1, record.due, record.box, record.shown]
  if (record.shown < 0) return [0, 1, 0, 0]
  if (record.shown < record.due) return [0, 0, record.box, record.shown]

  return [0, 2, record.shown, 0]
}

/**
 * The card for wait `tick`. A due card comes before one that is not.
 *
 * Among due cards, the ones you marked since they last showed go first, lower
 * box first, so a card you missed is back on the next wait. Two you missed
 * come back in the order they showed. Next come cards that have never shown,
 * in deck order. Last come cards you left unmarked, the one shown longest ago
 * first, so an unmarked card does not hold the front. Deck order breaks a tie.
 *
 * With nothing due, the card due soonest shows, so every wait has a card.
 */
export const pickNext = (
  cards: readonly Card[],
  records: ReadonlyMap<string, CardRecord>,
  tick: number,
): Card | undefined => {
  let best: { card: Card; key: number[] } | undefined
  cards.forEach((card, index) => {
    const key = [...rankOf(recordOf(records, card.id), tick), index]
    if (best === undefined || less(key, best.key)) best = { card, key }
  })

  return best?.card
}

/** Cards due on wait `tick` or before it. */
export const dueCount = (cards: readonly Card[], records: ReadonlyMap<string, CardRecord>, tick: number): number =>
  cards.filter(card => recordOf(records, card.id).due <= tick).length

/** The status line while Claude works: the question, as the deck writes it, 48 columns at most. */
export const statusFor = (question: string): string => truncateColumns(`${CARD_MARK}${question}`, STATUS_COLUMNS)

/** The return line when the turn ends. */
export const answerLine = (answer: string): string => `A: ${answer}${ANSWER_SUFFIX}`

export const parseCardCommand = (args: unknown): CardCommand => {
  const word = typeof args === 'string' ? args.trim().toLowerCase() : ''
  if (word === '') return 'show'
  if (word === 'got' || word === 'miss') return word

  return 'invalid'
}

export const USAGE = '/card got · /card miss'

export const NOTHING_TO_MARK = 'no card to mark yet · the answer shows when a turn ends'

export const NO_DECK = `no deck yet · ${HINT}`

export const NO_CARDS = 'no cards in ~/.waitroom/cards.md yet · write a Q: line, then an A: line'

/** The `/card` reply when the deck file is there but can't be read. */
export const CANT_READ = "can't read ~/.waitroom/cards.md"

/** The `/card` reply to a mark. */
export const markedLine = (mark: Mark, record: CardRecord): string => {
  const wait = intervalOf(record.box)
  const back = wait === 1 ? 'back next wait' : `back in ${wait} waits`

  return mark === 'got' ? `got it · box ${record.box} · ${back}` : `missed · box ${record.box} · ${back}`
}

/** The `/card` reply with no args. */
export const deckLine = (deck: Deck, due: number): string => {
  const parts = [`${deck.cards.length} ${deck.cards.length === 1 ? 'card' : 'cards'}`, `${due} due`]
  if (deck.skipped > 0) parts.push(`${deck.skipped} skipped`)

  return `${parts.join(' · ')} · mark an answer with /card got or /card miss`
}
