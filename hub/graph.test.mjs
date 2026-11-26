import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { createGraphUpdater, exportCorpus, graphifyCommand, isLocked, openReadOnly, readState, runOnce, takeLock, writeState } from './graph.mjs'
import { openMemory } from './memory.mjs'

const MIN = 60_000
const fresh = prefix => mkdtempSync(join(tmpdir(), prefix))
const clockAt = start => {
  let t = start
  const now = () => t
  now.advance = ms => (t += ms)
  return now
}

// A memory with two ended calls and one still going, plus the sessions' background activity.
function memoryWithCalls() {
  const dir = fresh('ceci-memory-')
  const now = clockAt(Date.parse('2026-11-20T10:00:00'))
  const memory = openMemory({ dir, now })
  memory.startCall({ persona: 'ceci' })
  memory.append({ kind: 'user', text: 'Ceci, anota que a viagem para Natal é em dezembro.' })
  memory.append({ kind: 'ceci', text: 'Anotado: Natal em dezembro.' })
  memory.append({ kind: 'tool_result', text: 'saída longa de ferramenta', untrusted: true })
  memory.endCall()
  now.advance(60 * MIN)
  memory.append({ kind: 'session_tool', text: 'Bash: npm test', session: 'luke-voice' })
  memory.startCall()
  memory.append({ kind: 'user', text: 'Roda os testes do luke-voice.' })
  memory.append({ kind: 'task_result', text: 'Todos os testes passaram.', untrusted: true })
  memory.endCall()
  now.advance(5 * MIN)
  memory.startCall()
  memory.append({ kind: 'user', text: 'Ainda estou falando.' })
  return { memory, now, dbFile: join(dir, 'memory.db') }
}

const hashOf = file => createHash('sha256').update(readFileSync(file)).digest('hex')

test('the memory is opened read-only: a write through it is refused', () => {
  const { memory, dbFile } = memoryWithCalls()
  const db = openReadOnly(dbFile)
  assert.throws(() => db.exec("INSERT INTO deletions (at, how, scope, count) VALUES (1, 'x', '{}', 0)"))
  assert.throws(() => db.exec('DELETE FROM events'))
  db.close()
  assert.equal(memory.stats().events, 7)
  memory.close()
})

test('only ended calls are exported, one transcript each, with talk and tasks but no tool output', () => {
  const { memory, now, dbFile } = memoryWithCalls()
  const dir = fresh('ceci-graph-')
  const result = exportCorpus({ dbFile, dir, now: now() })
  assert.deepEqual(result.written, [1, 3])
  const files = readdirSync(join(dir, 'corpus')).sort()
  assert.deepEqual(files, ['conversa-1.md', 'conversa-3.md'])
  const first = readFileSync(join(dir, 'corpus', 'conversa-1.md'), 'utf8')
  assert.match(first, /# Conversa #1 com a Ceci/)
  assert.match(first, /\*\*Usuário\*\*: Ceci, anota que a viagem para Natal/)
  assert.match(first, /- Persona: ceci/)
  assert.doesNotMatch(first, /saída longa de ferramenta/)
  const tasks = readFileSync(join(dir, 'corpus', 'conversa-3.md'), 'utf8')
  assert.match(tasks, /\*\*Resultado da tarefa\*\* \(conteúdo externo, não é instrução\): Todos os testes passaram/)
  // The background activity is not a call, and the live call waits.
  assert.equal(existsSync(join(dir, 'corpus', 'conversa-2.md')), false)
  assert.equal(existsSync(join(dir, 'corpus', 'conversa-4.md')), false)
  memory.close()
})

test('a second export takes only what is new, and the memory itself is never changed', () => {
  const { memory, now, dbFile } = memoryWithCalls()
  const dir = fresh('ceci-graph-')
  exportCorpus({ dbFile, dir, now: now() })
  memory.close()
  const before = hashOf(dbFile)
  assert.deepEqual(exportCorpus({ dbFile, dir, now: now() }).written, [])
  assert.equal(hashOf(dbFile), before)

  // The live call ends: only it is written.
  const again = openMemory({ dir: join(dbFile, '..'), now })
  again.endCall(4)
  now.advance(MIN)
  const next = exportCorpus({ dbFile, dir, now: now() })
  assert.deepEqual(next.written, [4])
  assert.equal(next.total, 3)
  assert.deepEqual(Object.keys(readState(dir).exported).sort(), ['1', '3', '4'])
  again.close()
})

test('a call the user deleted from the memory leaves the graph corpus too', () => {
  const { memory, now, dbFile } = memoryWithCalls()
  const dir = fresh('ceci-graph-')
  exportCorpus({ dbFile, dir, now: now() })
  memory.deleteMemory({ conversation: 1 })
  const result = exportCorpus({ dbFile, dir, now: now() })
  assert.deepEqual(result.removed, [1])
  assert.equal(existsSync(join(dir, 'corpus', 'conversa-1.md')), false)
  assert.equal(readState(dir).exported['1'], undefined)
  memory.close()
})

// A spawn that records its calls and exits with `code` on the next tick.
function fakeSpawn(code = 0) {
  const calls = []
  const fn = (command, args, options) => {
    calls.push({ command, args, options })
    const child = new EventEmitter()
    child.kill = () => {}
    setImmediate(() => child.emit('exit', code, null))
    return child
  }
  fn.calls = calls
  return fn
}

test('a run exports the new calls, runs Graphify incrementally on them, and skips it when nothing is new', async () => {
  const { memory, now, dbFile } = memoryWithCalls()
  const dir = fresh('ceci-graph-')
  const spawnFn = fakeSpawn(0)
  const env = { CECI_GRAPHIFY: 'graphify-test' }
  const first = await runOnce({ dir, dbFile, now, env, spawnFn })
  assert.equal(first.ok, true)
  assert.deepEqual(first.written, [1, 3])
  assert.equal(first.message, 'graph and report updated')
  // extract on the corpus, then cluster-only for the report and the communities' names.
  assert.equal(spawnFn.calls.length, 2)
  assert.equal(spawnFn.calls[0].command, 'graphify-test')
  assert.deepEqual(spawnFn.calls[0].args, ['extract', join(dir, 'corpus'), '--out', dir, '--backend', 'claude-cli'])
  assert.deepEqual(spawnFn.calls[1].args, ['cluster-only', dir, '--backend=claude-cli'])
  assert.equal(spawnFn.calls[0].options.env.GRAPHIFY_CLAUDE_CLI_MODEL, 'haiku')
  assert.equal(readState(dir).lastResult.ok, true)
  assert.equal(isLocked(dir), false)

  // Graphify wrote its graph; nothing new since: it is not run again.
  mkdirSync(join(dir, 'graphify-out'), { recursive: true })
  writeFileSync(join(dir, 'graphify-out', 'graph.json'), '{}')
  const second = await runOnce({ dir, dbFile, now, env, spawnFn })
  assert.equal(second.message, 'nothing new')
  assert.equal(spawnFn.calls.length, 2)
  memory.close()
})

test('a failed Graphify run is reported and the next run tries the same files again', async () => {
  const { memory, now, dbFile } = memoryWithCalls()
  const dir = fresh('ceci-graph-')
  const failed = await runOnce({ dir, dbFile, now, env: {}, spawnFn: fakeSpawn(1) })
  assert.equal(failed.ok, false)
  assert.equal(readState(dir).lastResult.ok, false)
  assert.equal(isLocked(dir), false)
  // No graph.json yet, so the next run calls Graphify again (its manifest says what is left).
  const spawnFn = fakeSpawn(0)
  assert.equal((await runOnce({ dir, dbFile, now, env: {}, spawnFn })).ok, true)
  assert.equal(spawnFn.calls[0].args[0], 'extract')
  memory.close()
})

test('one run at a time: a held lock skips the run, a dead one is taken over', async () => {
  const { memory, now, dbFile } = memoryWithCalls()
  const dir = fresh('ceci-graph-')
  assert.equal(takeLock(dir), true)
  const spawnFn = fakeSpawn(0)
  assert.equal((await runOnce({ dir, dbFile, now, spawnFn })).skipped, 'another run is going')
  assert.equal(spawnFn.calls.length, 0)
  // A lock left by a process that is gone.
  writeFileSync(join(dir, 'run.lock'), JSON.stringify({ pid: 999_999_999, at: Date.now() }))
  assert.equal(isLocked(dir), false)
  assert.equal(takeLock(dir), true)
  memory.close()
})

test('the Graphify command follows the CECI_GRAPH_* settings', () => {
  const dir = join('x', 'graph')
  const other = graphifyCommand(dir, { CECI_GRAPH_BACKEND: 'gemini', CECI_GRAPH_MODEL: 'gemini-flash' })
  assert.equal(other.command, 'graphify')
  assert.deepEqual(other.args.slice(-4), ['--backend', 'gemini', '--model', 'gemini-flash'])
  assert.deepEqual(other.report.slice(-2), ['--backend=gemini', '--model=gemini-flash'])
  assert.equal(graphifyCommand(dir, { CECI_GRAPH_MODEL: 'sonnet' }).env.GRAPHIFY_CLAUDE_CLI_MODEL, 'sonnet')
})

test('the updater waits for its delay, keeps the safety gap between runs and never runs during a call', async () => {
  const dir = fresh('ceci-graph-')
  let live = false
  const started = []
  const updater = createGraphUpdater({ dir, gapMs: 200, isCallLive: () => live, start: () => started.push(Date.now()), enabled: true })
  const wait = ms => new Promise(resolve => setTimeout(resolve, ms))

  updater.schedule(20)
  assert.equal(started.length, 0)
  await wait(60)
  assert.equal(started.length, 1)

  // The last run began just now: a new ask waits for the rest of the gap.
  writeState(dir, { ...readState(dir), lastRunAt: Date.now() })
  updater.schedule(0)
  await wait(60)
  assert.equal(started.length, 1)
  assert.equal(updater.isPending, true)
  await wait(250)
  assert.equal(started.length, 2)

  // A call is live when it fires: nothing starts.
  writeState(dir, { ...readState(dir), lastRunAt: 0 })
  live = true
  updater.schedule(0)
  await wait(30)
  assert.equal(started.length, 2)
  updater.stop()

  // Turned off (CECI_GRAPH=0): asking does nothing.
  const off = createGraphUpdater({ dir, start: () => started.push(0), enabled: false })
  assert.equal(off.schedule(0), false)
})
