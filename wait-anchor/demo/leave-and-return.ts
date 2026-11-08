/**
 * SIMULATED HOST FIXTURE.
 *
 * Claude Code is not running. This process loads the real wait-anchor `register`
 * module and dispatches the events a session would. The store between processes
 * is a file standing in for `$.store`. Nothing here is a terminal recording of
 * Claude Code, and nothing here calls a model.
 */

import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { install, storeFromJson, storeToJson } from './host'

const here = fileURLToPath(new URL('.', import.meta.url))
const phase = process.argv[2]
const storePath = process.argv[3] ?? ''

const save = (path: string, store: Map<string, unknown>) => {
  const next = `${path}.${process.pid}.tmp`
  writeFileSync(next, storeToJson(store))
  renameSync(next, path)
}

const load = (path: string): Map<string, unknown> => storeFromJson(readFileSync(path, 'utf8'))

const say = (line: string) => {
  console.log(line)
}

const awaitStart = async (host: ReturnType<typeof install>) => {
  await host.dispatch('session.start', { cwd: '/work/app', surface: 'terminal', isInteractive: true })
}

const runPhase = async (): Promise<void> => {
  if (phase === 'leave') {
    const host = install({ root: '/work/app', sessionId: 'sess-leave' })
    await awaitStart(host)
    const set = (await host.dispatch('command.run', {
      command: 'anchor',
      args: 'ship login fix · check: redirect works',
    })) as { text: string }
    say(`set ${set.text}`)
    say(`status ${host.status.at(-1)}`)
    await host.dispatch('turn.complete', { turnId: 'turn-1', isAborted: true })
    say('stop armed, no reminder yet')
    say(`logs ${host.logs.length}`)
    save(storePath, host.store)
    return
  }

  if (phase === 'return') {
    const host = install({ root: '/work/app', sessionId: 'sess-leave', store: load(storePath) })
    await awaitStart(host)
    say(`status after restart ${host.status.at(-1)}`)
    say(`logs before prompt ${host.logs.length}`)
    await host.dispatch('prompt.submit', { text: 'where was I', origin: { kind: 'composer' } })
    say(`first prompt ${host.logs[0] ?? ''}`)
    await host.dispatch('prompt.submit', { text: 'keep going', origin: { kind: 'composer' } })
    say(`log count after second prompt ${host.logs.length}`)
    if (host.logs.length !== 1 || host.logs[0] !== 'Back? You said: redirect works.') {
      throw new Error(`reminder was not exactly once: ${JSON.stringify(host.logs)}`)
    }
    if (host.status.at(-1) !== '⚓ ship login fix → redirect works') {
      throw new Error(`status missing after restart: ${String(host.status.at(-1))}`)
    }
    if (host.calls.http !== 0 || host.calls.model !== 0 || host.calls.messages !== 0) {
      throw new Error('the return read a transcript, a model, or the network')
    }
    save(storePath, host.store)
    return
  }

  if (phase === 'other') {
    const store = load(storePath)
    const before = store.size
    const host = install({ root: '/other/app', sessionId: 'sess-other', store })
    await awaitStart(host)
    const shown = (await host.dispatch('command.run', { command: 'anchor', args: '' })) as { text: string }
    say(`other session show ${shown.text}`)
    if (shown.text.includes('redirect works') || shown.text.includes('ship login fix')) {
      throw new Error('the other session saw the first note')
    }
    await host.dispatch('command.run', { command: 'anchor', args: 'other goal · check: other check' })
    const again = (await host.dispatch('command.run', { command: 'anchor', args: '' })) as { text: string }
    say(`other session note ${again.text}`)
    say(`store keys ${store.size} was ${before}`)
    if (again.text !== 'other goal · check: other check') throw new Error('other note was not kept')
    if (store.size !== before + 1) throw new Error('sessions shared one key')
    save(storePath, store)
    return
  }

  if (phase === 'missing') {
    const store = load(storePath)
    const before = storeToJson(store)
    const host = install({ root: '/work/app', store })
    await awaitStart(host)
    const reply = (await host.dispatch('command.run', {
      command: 'anchor',
      args: 'ship login fix · check: redirect works',
    })) as { text: string }
    say(`missing id ${reply.text}`)
    if (!reply.text.includes('no stable session id') || !reply.text.includes('nothing was saved')) {
      throw new Error('missing id did not explain the limit')
    }
    if (storeToJson(store) !== before) throw new Error('missing id wrote a note')
    if (reply.text.includes('other goal') || reply.text.includes('redirect works')) {
      throw new Error('missing id showed a stored note')
    }
    return
  }

  throw new Error(`unknown phase ${phase}`)
}

const child = (name: string, path: string) => {
  const result = spawnSync(
    process.execPath,
    ['--experimental-strip-types', '--import', fileURLToPath(new URL('./register-loader.mjs', import.meta.url)), fileURLToPath(new URL('./leave-and-return.ts', import.meta.url)), name, path],
    { cwd: here, encoding: 'utf8' },
  )
  process.stdout.write(result.stdout)
  process.stderr.write(result.stderr)
  if (result.status !== 0) {
    throw new Error(`${name} exited ${String(result.status)}`)
  }
}

const main = async () => {
  if (phase !== undefined && phase !== '') {
    await runPhase()
    return
  }

  say('SIMULATED HOST FIXTURE')
  say('Claude Code is not in this run. Each block is a separate node process loading wait-anchor register.')
  say('The file between them stands in for $.store. The note text is the plugin code, not a mock reply.')
  const dir = mkdtempSync(join(tmpdir(), 'wait-anchor-'))
  const path = join(dir, 'store.json')
  writeFileSync(path, '[]')
  try {
    say('--- leave, then stop ---')
    child('leave', path)
    say('--- process restart, first prompt, second prompt ---')
    child('return', path)
    say('--- second session, directory also named app ---')
    child('other', path)
    say('--- missing session id ---')
    child('missing', path)
    say('--- done ---')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : error)
  process.exitCode = 1
})
