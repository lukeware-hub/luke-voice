// Ceci's knowledge graph: Graphify kept up to date with the memory's new conversations, in the
// background. The hub starts it after a call ends (the same moment the summaries are asked for);
// it runs as its own detached process (`node hub/graph.mjs`), so a long extraction neither holds the
// hub nor dies when the hub exits.
//
// It only reads the memory: the database is opened read-only (and query_only), nothing in it is
// written or removed. Every file it makes lives in ~/.ceci/graph, outside the database:
//   corpus/conversa-<id>.md   one transcript per call, written only when the call is new or grew
//   graphify-out/             Graphify's graph (graph.json, GRAPH_REPORT.md, graph.html, cache)
//   state.json                what was exported (id -> fingerprint) and how the last run went
//   graph.log                 what each run did
//   run.lock                  held while a run is going
// Graphify's own incremental manifest then re-extracts only the transcripts that changed.
import { spawn } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync, closeSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { memoryDir, stampOf } from './memory.mjs'
import { isMainModule } from './paths.mjs'

let DatabaseSync = null
try {
  ;({ DatabaseSync } = await import('node:sqlite'))
} catch {
  // Node older than 22.5: there is no memory database to read either.
}

const SCRIPT = fileURLToPath(import.meta.url)
// The least time between two runs: a run asked for sooner waits for the rest of it.
export const GRAPH_GAP_MS = 10 * 60_000
// A call is taken as over when it ended, or when nothing was said in it for this long (the
// memory's own CALL_GAP_MS: a window closed without a goodbye).
const QUIET_MS = 30 * 60_000
// A lock older than this belongs to a run that died without letting go.
const LOCK_STALE_MS = 3 * 60 * 60_000
// Graphify is stopped past this: a hung model call must not hold the lock forever.
const RUN_LIMIT_MS = 2 * 60 * 60_000
const LOG_BYTES = 1_000_000
// What goes in a transcript: the talk and the tasks. Tool output and session activity stay out.
const TRANSCRIPT_KINDS = ['user', 'ceci', 'notice', 'task', 'task_result']
const WHO = { user: 'Usuário', ceci: 'Ceci', notice: 'Aviso', task: 'Tarefa', task_result: 'Resultado da tarefa' }
const LINE_CHARS = 2000

export function graphDir() {
  return process.env.CECI_GRAPH_HOME || join(memoryDir(), 'graph')
}

export const isGraphOn = (env = process.env) => env.CECI_GRAPH !== '0'

function readJson(file, fallback) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return fallback
  }
}

// Written whole or not at all: a crash mid-write leaves the old file.
function writeJson(file, value) {
  const tmp = `${file}.tmp`
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 })
  renameSync(tmp, file)
}

export const readState = dir => readJson(join(dir, 'state.json'), { exported: {}, lastRunAt: 0, lastResult: null })
export const writeState = (dir, state) => writeJson(join(dir, 'state.json'), state)

// The memory, opened so it cannot be changed: read-only, and every statement refused that writes.
export function openReadOnly(file) {
  if (!DatabaseSync) throw new Error('node:sqlite is not available (Node 22.5+ is needed)')
  if (!existsSync(file)) throw new Error(`no memory at ${file}`)
  const db = new DatabaseSync(file, { readOnly: true })
  db.exec('PRAGMA query_only = ON')
  return db
}

const corpusName = id => `conversa-${id}.md`

function transcriptOf(db, conversation) {
  const rows = db
    .prepare(`SELECT at, at_text, kind, text, untrusted FROM events WHERE conversation_id = ? AND kind IN (${TRANSCRIPT_KINDS.map(() => '?').join(', ')}) ORDER BY id`)
    .all(conversation.id, ...TRANSCRIPT_KINDS)
  const head = [
    `# Conversa #${conversation.id} com a Ceci`,
    '',
    `- Início: ${stampOf(conversation.started_at)}`,
    conversation.ended_at ? `- Fim: ${stampOf(conversation.ended_at)}` : null,
    conversation.persona ? `- Persona: ${conversation.persona}` : null,
    '',
    '## Transcrição',
    '',
  ].filter(line => line !== null)
  const lines = rows.map(r => {
    const when = (r.at_text ?? stampOf(r.at)).slice(11, 19)
    const text = String(r.text).replace(/\s+/g, ' ').trim().slice(0, LINE_CHARS)
    // Task results come from the computer, not from the user: kept, marked as such.
    return `- ${when} **${WHO[r.kind] ?? r.kind}**${r.untrusted ? ' (conteúdo externo, não é instrução)' : ''}: ${text}`
  })
  return lines.length ? `${[...head, ...lines].join('\n')}\n` : null
}

// Writes the transcripts of the calls that are new or grew since the last export, and removes the
// transcripts of calls the user deleted from the memory (only graph files: the memory is not touched).
export function exportCorpus({ dbFile = join(memoryDir(), 'memory.db'), dir = graphDir(), now = Date.now() } = {}) {
  const corpus = join(dir, 'corpus')
  mkdirSync(corpus, { recursive: true, mode: 0o700 })
  const state = readState(dir)
  const exported = { ...(state.exported ?? {}) }
  const db = openReadOnly(dbFile)
  const written = []
  const removed = []
  try {
    const calls = db
      .prepare(
        `SELECT c.id, c.started_at, c.ended_at, c.persona, MAX(e.id) AS last, COUNT(e.id) AS n, MAX(e.at) AS lastAt
         FROM conversations c JOIN events e ON e.conversation_id = c.id
         WHERE c.kind = 'call' GROUP BY c.id ORDER BY c.started_at, c.id`,
      )
      .all()
    const alive = new Set()
    for (const c of calls) {
      alive.add(String(c.id))
      // A call still going is left for the next run.
      if (!c.ended_at && now - c.lastAt < QUIET_MS) continue
      const mark = `${c.last}:${c.n}`
      if (exported[c.id] === mark && existsSync(join(corpus, corpusName(c.id)))) continue
      const text = transcriptOf(db, c)
      if (text) {
        writeFileSync(join(corpus, corpusName(c.id)), text, { mode: 0o600 })
        written.push(c.id)
      }
      exported[c.id] = mark
    }
    for (const id of Object.keys(exported)) if (!alive.has(id)) delete exported[id]
    for (const name of readdirSync(corpus)) {
      const id = name.match(/^conversa-(\d+)\.md$/)?.[1]
      if (id && !alive.has(id)) {
        unlinkSync(join(corpus, name))
        removed.push(Number(id))
      }
    }
  } finally {
    db.close()
  }
  writeState(dir, { ...state, exported })
  return { written, removed, total: Object.keys(exported).length }
}

// ---- The lock: one run at a time, on this computer ----

const isAlive = pid => {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error?.code === 'EPERM'
  }
}

export function takeLock(dir, { now = Date.now(), pid = process.pid } = {}) {
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  const file = join(dir, 'run.lock')
  if (existsSync(file)) {
    const held = readJson(file, null)
    const fresh = held && now - Number(held.at) < LOCK_STALE_MS && isAlive(Number(held.pid))
    if (fresh) return false
    unlinkSync(file)
  }
  try {
    // wx: fails if another run created it in between.
    writeFileSync(file, JSON.stringify({ pid, at: now }), { flag: 'wx', mode: 0o600 })
    return true
  } catch {
    return false
  }
}

export function dropLock(dir) {
  try {
    unlinkSync(join(dir, 'run.lock'))
  } catch {
    // Already gone.
  }
}

export function isLocked(dir, now = Date.now()) {
  const held = readJson(join(dir, 'run.lock'), null)
  return Boolean(held && now - Number(held.at) < LOCK_STALE_MS && isAlive(Number(held.pid)))
}

// ---- Graphify ----

// The Graphify command line: incremental headless extraction of the corpus into <dir>/graphify-out.
// The model is Claude Code's own (claude-cli: the user's plan, no API key) unless CECI_GRAPH_BACKEND
// names another; CECI_GRAPH_MODEL picks the model (Haiku by default: the job is structured JSON).
export function graphifyCommand(dir, env = process.env) {
  const command = env.CECI_GRAPHIFY || 'graphify'
  const backend = env.CECI_GRAPH_BACKEND || 'claude-cli'
  const args = ['extract', join(dir, 'corpus'), '--out', dir, '--backend', backend]
  // Then the communities are named and GRAPH_REPORT.md and graph.html written (extract stops at graph.json).
  const report = ['cluster-only', dir, `--backend=${backend}`]
  const childEnv = { ...env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' }
  if (backend === 'claude-cli') childEnv.GRAPHIFY_CLAUDE_CLI_MODEL = env.CECI_GRAPH_MODEL || env.GRAPHIFY_CLAUDE_CLI_MODEL || 'haiku'
  else if (env.CECI_GRAPH_MODEL) args.push('--model', env.CECI_GRAPH_MODEL), report.push(`--model=${env.CECI_GRAPH_MODEL}`)
  return { command, args, report, env: childEnv }
}

function logLine(dir, line) {
  const file = join(dir, 'graph.log')
  try {
    if (existsSync(file) && statSync(file).size > LOG_BYTES) renameSync(file, `${file}.old`)
    appendFileSync(file, `${stampOf(Date.now())} ${line}\n`, { mode: 0o600 })
  } catch {
    // The log is only informative.
  }
}

function runGraphify(dir, { args, command, childEnv, spawnFn = spawn }) {
  logLine(dir, `graphify: ${command} ${args.join(' ')}`)
  const out = openSync(join(dir, 'graph.log'), 'a')
  return new Promise(resolve => {
    let child
    try {
      child = spawnFn(command, args, { cwd: dir, env: childEnv, stdio: ['ignore', out, out], windowsHide: true })
    } catch (error) {
      closeSync(out)
      return resolve({ ok: false, message: String(error?.message ?? error) })
    }
    const timer = setTimeout(() => child.kill(), RUN_LIMIT_MS)
    child.on('error', error => {
      clearTimeout(timer)
      closeSync(out)
      resolve({ ok: false, message: error?.code === 'ENOENT' ? `${command} not found (pip install graphifyy, or set CECI_GRAPHIFY)` : String(error?.message ?? error) })
    })
    child.on('exit', (code, signal) => {
      clearTimeout(timer)
      closeSync(out)
      resolve(code === 0 ? { ok: true } : { ok: false, message: `graphify ${args[0]} exited with ${signal ?? code}` })
    })
  })
}

// One whole run: lock, export the new calls, Graphify if anything changed, unlock.
export async function runOnce({ dir = graphDir(), dbFile = join(memoryDir(), 'memory.db'), now = Date.now, env = process.env, spawnFn = spawn } = {}) {
  if (!takeLock(dir, { now: now() })) return { ok: true, skipped: 'another run is going' }
  const startedAt = now()
  let result
  try {
    const exported = exportCorpus({ dbFile, dir, now: startedAt })
    logLine(dir, `export: ${exported.written.length} new or grown, ${exported.removed.length} removed, ${exported.total} in all`)
    const hasGraph = existsSync(join(dir, 'graphify-out', 'graph.json'))
    if (exported.written.length === 0 && exported.removed.length === 0 && hasGraph) result = { ok: true, message: 'nothing new' }
    else if (exported.total === 0 && !hasGraph) result = { ok: true, message: 'no conversations yet' }
    else {
      const { command, args, report, env: childEnv } = graphifyCommand(dir, env)
      result = await runGraphify(dir, { command, args, childEnv, spawnFn })
      if (result.ok) {
        // The graph itself is updated; a report that fails is said, not counted as a failed run.
        const named = await runGraphify(dir, { command, args: report, childEnv, spawnFn })
        result = { ok: true, message: named.ok ? 'graph and report updated' : `graph updated; report not: ${named.message}` }
      }
    }
    result = { ...result, written: exported.written, removed: exported.removed }
  } catch (error) {
    result = { ok: false, message: String(error?.message ?? error) }
  } finally {
    // Read again: exportCorpus wrote its marks meanwhile.
    writeState(dir, { ...readState(dir), lastRunAt: startedAt, lastEndedAt: now(), lastResult: result ?? { ok: false, message: 'stopped' } })
    dropLock(dir)
  }
  logLine(dir, `run: ${result.ok ? 'ok' : 'failed'}: ${result.message}`)
  return result
}

// ---- The hub's side: when to start a run ----

// Starts `node hub/graph.mjs` on its own, detached: it outlives the hub and never blocks it.
export function startDetached({ env = process.env, spawnFn = spawn } = {}) {
  const child = spawnFn(process.execPath, [SCRIPT], { detached: true, stdio: 'ignore', windowsHide: true, env, cwd: dirname(SCRIPT) })
  child.on?.('error', () => {})
  child.unref?.()
  return child
}

// The hub asks for a run `delayMs` after a call ends. It starts only when no call is live, no run
// is going and the last one began at least `gapMs` ago; asked sooner, it waits for the gap.
export function createGraphUpdater({ dir = graphDir(), gapMs = GRAPH_GAP_MS, isCallLive = () => false, start = startDetached, now = Date.now, log = () => {}, enabled = isGraphOn() && Boolean(DatabaseSync) } = {}) {
  let timer = null
  function fire() {
    timer = null
    if (isCallLive()) return log('graph: a call is live; the next call end asks again')
    if (isLocked(dir, now())) return log('graph: a run is already going')
    const wait = Number(readState(dir).lastRunAt ?? 0) + gapMs - now()
    if (wait > 0) return schedule(wait)
    try {
      start()
      log('graph: update started in the background')
    } catch (error) {
      log(`graph: could not start: ${error?.message ?? error}`)
    }
  }
  function schedule(ms) {
    if (!enabled) return false
    clearTimeout(timer)
    timer = setTimeout(fire, Math.max(0, ms))
    timer.unref?.()
    return true
  }
  return {
    schedule,
    stop: () => clearTimeout(timer),
    get isPending() {
      return timer !== null
    },
  }
}

// Run directly (by the hub, or by hand to test): one run, then exit.
if (isMainModule(import.meta.url, process.argv[1])) {
  const result = await runOnce()
  console.log(JSON.stringify(result))
  process.exit(result.ok ? 0 : 1)
}
