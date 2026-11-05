import { expect, test } from 'claude-code/testing'

import {
  baselineOf,
  BAND_PRECEDENCE,
  cardFor,
  DISABLE_LABEL,
  DISMISS_LABEL,
  enabledRowKey,
  entropyOf,
  hitsIn,
  isEnvFile,
  looksRandom,
  mask,
  splitNul,
  MAX_ROWS,
  overflowLine,
  parseAddedLines,
  rowLine,
  RULES,
  scanLine,
  statusLine,
  SUBTITLE,
  TITLE,
  turnAdds,
  yieldsBand,
} from '../hooks/secret'
import { ANTHROPIC, AWS, GENERIC, GITHUB, GITHUB_PAT, OPENAI, PRIVATE_KEY, SLACK } from './fake'

const added = (path: string, lines: readonly string[]) =>
  [`diff --git ${path} ${path}`, '--- /dev/null', `+++ ${path}`, `@@ -0,0 +1,${lines.length} @@`, ...lines.map(l => `+${l}`)].join('\n') + '\n'

test('the copy is the spec copy, and the status line never names a kind', () => {
  expect(TITLE).toBe('Possible secrets in what this turn wrote')
  expect(SUBTITLE).toBe('Local pattern match, masked — nothing blocked, edited or uploaded')
  expect(DISMISS_LABEL).toBe('Close')
  expect(DISABLE_LABEL).toBe("Don't show again")
  expect(MAX_ROWS).toBe(8)
  expect(statusLine(0)).toBeUndefined()
  expect(statusLine(1)).toBe('1 possible secret')
  expect(statusLine(3)).toBe('3 possible secrets')
  expect(overflowLine(2)).toBe('2 more…')
  expect(rowLine({ path: 'src/a.ts', line: 12, masked: 'sk-…3f9a', kind: 'OpenAI key?' })).toBe(
    'src/a.ts:12  sk-…3f9a  (OpenAI key?)',
  )
})

test('ten rules at most', () => {
  expect(RULES.length).toBeLessThanOrEqual(10)
})

// (1) hit

test('each known prefix is flagged, masked to its prefix and last four, with a guessed kind', () => {
  expect(scanLine(`const key = "${OPENAI}"`)).toEqual({ masked: 'sk-…3f9a', kind: 'OpenAI key?' })
  expect(scanLine(`ANTHROPIC=${ANTHROPIC}`)).toEqual({ masked: 'sk-ant-…7c1d', kind: 'Anthropic key?' })
  expect(scanLine(`aws_access_key_id = ${AWS}`)).toEqual({ masked: 'AKIA…9Q2Z', kind: 'AWS key?' })
  expect(scanLine(`token: ${GITHUB}`)).toEqual({ masked: 'ghp_…b4e1', kind: 'GitHub token?' })
  expect(scanLine(`t=${GITHUB_PAT}`)).toEqual({ masked: 'github_pat_…aa01', kind: 'GitHub token?' })
  expect(scanLine(`SLACK=${SLACK}`)).toEqual({ masked: 'xoxb-…9z9z', kind: 'Slack token?' })
  expect(scanLine(PRIVATE_KEY)).toEqual({ masked: '-----BEGIN … PRIVATE KEY-----', kind: 'private key?' })
  expect(scanLine(`const apiKey = '${GENERIC}'`)).toEqual({ masked: 'apiKey=…x8Lw', kind: 'API key?' })
  expect(scanLine(`"client_secret": "${GENERIC}"`)?.kind).toBe('API key?')
})

test('the full value never reaches a hit', () => {
  for (const value of [OPENAI, ANTHROPIC, AWS, GITHUB, GITHUB_PAT, SLACK, GENERIC]) {
    const found = scanLine(`x = "${value}" api_key=${value}`)
    expect(found).toBeDefined()
    expect(found?.masked).not.toContain(value)
    expect(found?.masked.length ?? 0).toBeLessThan(value.length)
  }
  expect(mask('sk-', 'sk-abcdef')).toBe('sk-…cdef')
})

// (2) no hit

test('ordinary code, prose and references are not secrets', () => {
  for (const line of [
    'const token = await getToken()',
    'api_key = os.environ["OPENAI_API_KEY"]',
    'const apiKey = process.env.OPENAI_API_KEY',
    'password = "changeme"',
    'API_KEY=${API_KEY}',
    'secret: your-secret-key-here-0000',
    'const sk = "sk-" + suffix',
    'sk-xxxxxxxxxxxxxxxxxxxxxxxx',
    'import tokenizer from "./lib/token_utils_v2"',
    'token_path = src/auth/tokens/refresh_v2.ts',
    'the task-list skill is done',
    '-----BEGIN PUBLIC KEY-----',
  ]) {
    expect(scanLine(line)).toBeUndefined()
  }
})

test('entropy reads a random value as random and a word as a word', () => {
  expect(entropyOf('')).toBe(0)
  expect(entropyOf('aaaa')).toBe(0)
  expect(looksRandom(GENERIC)).toBe(true)
  expect(looksRandom('aaaaaaaaaaaaaaaaaaaa1')).toBe(false)
  expect(looksRandom('short1')).toBe(false)
  expect(looksRandom('nodigitsinthisvalueatall')).toBe(false)
})

// (3) .env

test('a .env line with a random value is flagged by name; a template file and a plain value are not', () => {
  expect(isEnvFile('.env')).toBe(true)
  expect(isEnvFile('apps/web/.env.local')).toBe(true)
  expect(isEnvFile('prod.env')).toBe(true)
  expect(isEnvFile('.env.example')).toBe(false)
  expect(isEnvFile('src/env.ts')).toBe(false)

  expect(scanLine(`DATABASE_PASS=${GENERIC}`, true)).toEqual({ masked: 'DATABASE_PASS=…x8Lw', kind: 'env value?' })
  expect(scanLine(`export STRIPE_LIVE=${GENERIC}`, true)?.masked).toBe('STRIPE_LIVE=…x8Lw')
  expect(scanLine(`STRIPE_LIVE=${GENERIC}`, false)).toBeUndefined()
  expect(scanLine('NODE_ENV=production', true)).toBeUndefined()
  expect(scanLine('PORT=3000', true)).toBeUndefined()
  expect(scanLine('# a comment', true)).toBeUndefined()
  // A known prefix in a .env file is named by its own rule first.
  expect(scanLine(`OPENAI_API_KEY=${OPENAI}`, true)?.kind).toBe('OpenAI key?')

  const hits = hitsIn(parseAddedLines(added('.env', ['PORT=3000', `DB_PASS=${GENERIC}`])))
  expect(hits).toEqual([{ path: '.env', line: 2, masked: 'DB_PASS=…x8Lw', kind: 'env value?' }])
})

// (4) false positive, ignored

test('a line marked wait-secret: ignore, after # or //, is skipped', () => {
  expect(scanLine(`const key = "${OPENAI}" // wait-secret: ignore`)).toBeUndefined()
  expect(scanLine(`KEY=${OPENAI} # wait-secret: ignore`, true)).toBeUndefined()
  expect(scanLine(`fixture = "${AWS}"  #wait-secret:ignore`)).toBeUndefined()
  // The mark is a comment, not any mention of the words.
  expect(scanLine(`const key = "${OPENAI}" /* wait-secret ignore */`)).toBeDefined()
})

// Diff reading and this turn's lines

test('added lines carry their line number in the file as it is now; deleted files add nothing', () => {
  const diff = [
    'diff --git src/a.ts src/a.ts',
    '--- src/a.ts',
    '+++ src/a.ts',
    '@@ -1,3 +1,4 @@',
    ' one',
    '-two',
    '+TWO',
    '+three',
    ' four',
    '@@ -10,2 +11,2 @@',
    ' ten',
    '+eleven',
    'diff --git gone.ts gone.ts',
    '--- gone.ts',
    '+++ /dev/null',
    '@@ -1 +0,0 @@',
    '-bye',
    'Binary files /dev/null and logo.png differ',
  ].join('\n')

  expect(parseAddedLines(diff)).toEqual([
    {
      path: 'src/a.ts',
      lines: [
        { line: 2, text: 'TWO' },
        { line: 3, text: 'three' },
        { line: 12, text: 'eleven' },
      ],
    },
  ])
})

test('a key already uncommitted before the turn is not this turn', () => {
  const before = parseAddedLines(added('src/a.ts', [`k = "${OPENAI}"`]))
  const after = parseAddedLines(added('src/a.ts', [`k = "${OPENAI}"`, `t = "${GITHUB}"`]))
  const start = baselineOf('turn-1', { ok: true, files: before })

  // The baseline keeps digests, never a line.
  expect(JSON.stringify(start)).not.toContain(OPENAI)
  expect(turnAdds(start, { ok: true, files: after })).toEqual([{ path: 'src/a.ts', lines: [{ line: 2, text: `t = "${GITHUB}"` }] }])
  expect(cardFor(start, { ok: true, files: after })?.hits.map(hit => hit.kind)).toEqual(['GitHub token?'])
  expect(cardFor(start, { ok: true, files: before })).toBeNull()
  expect(cardFor(baselineOf('t', { ok: false }), { ok: true, files: after })).toBeNull()
  expect(cardFor(null, { ok: true, files: after })).toBeNull()
})

test('eight rows at most, then an overflow count', () => {
  const lines = Array.from({ length: 11 }, (_, at) => `k${at} = "${OPENAI}"`)
  const card = cardFor(baselineOf('t', { ok: true, files: [] }), { ok: true, files: parseAddedLines(added('a.ts', lines)) })
  expect(card?.hits).toHaveLength(8)
  expect(card?.overflow).toBe(3)
})

test('the settings row, and its place in the shared row: last', () => {
  expect(enabledRowKey([{ key: 'wait-secret@inline.enabled' }])).toBe('wait-secret@inline.enabled')
  expect(enabledRowKey([])).toBe('wait-secret.enabled')
  expect(BAND_PRECEDENCE.at(-1)).toBe('wait-secret')
  expect(yieldsBand('wait-secret', 'wait-scope')).toBe(true)
  expect(yieldsBand('wait-secret', 'wait-ship')).toBe(true)
  expect(yieldsBand('wait-secret', undefined)).toBe(false)
  expect(yieldsBand('wait-secret', 'someone-else')).toBe(false)
})

test('splitNul keeps names with spaces, quotes and non-ASCII exactly as git wrote them', () => {
  expect(splitNul('a.ts\0notes/café key ☕.ts\0 lead and trail \0say "hi".ts\0')).toEqual([
    'a.ts',
    'notes/café key ☕.ts',
    ' lead and trail ',
    'say "hi".ts',
  ])
  expect(splitNul('')).toEqual([])
})
