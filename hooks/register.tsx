import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { LastTool, Line, Link, Running } from '../types'

const NAME = 'luke-voice'
// The hub's address. LUKE_VOICE_PORT moves it, as it moves the hub itself (hub/paths.mjs).
let HUB = 'http://127.0.0.1:4848'
const PANE = 'luke-voice'
const POLL_WAIT_MS = 20_000
const RETRY_MS = 3_000

// Off until the user turns it on: while off, nothing about the session leaves the machine.
const isOn = atom({ plugin: 'luke-voice', key: 'isOn' } as const, false)
// Change a tag when that value's fields change: it declines what an earlier version stored.
const link = atom({ plugin: 'luke-voice', key: 'link' } as const, { state: 'off', name: null, reason: null } as Link, { shape: 'link-1' })
const lines = atom({ plugin: 'luke-voice', key: 'lines' } as const, [] as Line[], { shape: 'lines-2' })
const running = atom({ plugin: 'luke-voice', key: 'running' } as const, [] as Running[], { shape: 'running-1' })
const lastTool = atom({ plugin: 'luke-voice', key: 'lastTool' } as const, null as LastTool, { shape: 'last-tool-1' })
// The pane rows opened to their full text, by row id; the rest show one line.
const expanded = atom({ plugin: 'luke-voice', key: 'expanded' } as const, [] as string[], { shape: 'expanded-1' })
const MAX_LINES = 40
// Long enough that an opened row shows a whole answer, not a cut one.
const MAX_LINE_TEXT = 8000
const MAX_TOOL_TEXT = 2000

type Command =
  | { id: string; type: 'send'; prompt: string; when: 'now' | 'after_current' }
  | { id: string; type: 'stop' }
  | { id: string; type: 'task'; task: string }
  | { id: string; type: 'think'; request: BrainRequest }

export type BrainRequest = {
  kind: 'user' | 'notice' | 'tool_result'
  text: string
  context: string[]
  turns: Array<{ role: 'user' | 'luke'; text: string }>
  sessions: Array<{ name: string; isBusy: boolean }>
  focused: string | null
}

type BrainTool = { name: string; args: Record<string, unknown> }

// say: what Ceci says now. tool: what runs now. pending: what runs if the user's next words are a
// plain yes (Ceci asked "posso?"), so the confirmation needs no second model call.
export type BrainReply = { say: string; tool: BrainTool | null; pending: BrainTool | null }

export const BRAIN_MODEL = 'claude-haiku-5-5'
// Low effort: at max, Haiku thought for 6–28 s per spoken turn, far too slow for a voice.
export const BRAIN_EFFORT = 'low'
const BRAIN_MAX_TOKENS = 400
const BRAIN_TIMEOUT_MS = 15_000
// The hub waits 40 s for a think reply (BRAIN_WAIT_MS in hub/server.mjs): the direct call and the
// fallback together must fit in it, or the answer comes after the window gave up on it.
const BRAIN_BUDGET_MS = 38_000
const MIN_FALLBACK_MS = 8_000
const BRAIN_TOOLS = ['luke_run_task', 'luke_send_to_claude', 'luke_stop_claude', 'luke_session_activity']
// Tools that act on the computer: only these can wait for a "sim".
const PENDABLE_TOOLS = ['luke_run_task', 'luke_send_to_claude']

// The fallback brain, for an engine without $.model.complete: one short `claude -p` per turn.
// No tools, MCP servers, settings, skills or session history.
export function brainArgs(root: string): string[] {
  return [
    'claude', '-p',
    '--model', BRAIN_MODEL,
    '--effort', BRAIN_EFFORT,
    '--output-format', 'json',
    '--system-prompt-file', `${root}/agent/brain-prompt.md`,
    '--tools', '',
    '--strict-mcp-config',
    '--disable-slash-commands',
    '--setting-sources', '',
    '--no-session-persistence',
  ]
}

// What the brain reads for one turn. Context lines come quoted as untrusted from the window.
export function brainInput(request: BrainRequest): string {
  const sessions = request.sessions.length
    ? request.sessions.map(s => `${s.name} (${s.isBusy ? 'ocupada' : 'livre'}${s.name === request.focused ? ', em foco' : ''})`).join(', ')
    : 'nenhuma'
  const turns = request.turns.length ? request.turns.map(t => `${t.role === 'luke' ? 'ceci' : 'usuário'}: ${t.text}`).join('\n') : '(vazia)'
  const now =
    request.kind === 'notice' ? `aviso automático: ${request.text}` : request.kind === 'tool_result' ? `resultado da ferramenta: ${request.text}` : `usuário disse: ${request.text}`
  return [`[sessões] ${sessions}`, '[contexto]', request.context.join('\n') || '(nada)', '[conversa]', turns, `[agora] ${now}`].join('\n')
}

// A tool from the brain's JSON, only if it is one of the known tools (and, for pending, one that acts).
function toolOf(value: unknown, allowed: string[]): BrainTool | null {
  const tool = value as { name?: unknown; args?: unknown } | null | undefined
  if (typeof tool?.name !== 'string' || !allowed.includes(tool.name)) return null
  const args = tool.args && typeof tool.args === 'object' ? (tool.args as Record<string, unknown>) : {}
  return { name: tool.name, args }
}

// Reads the brain's reply text: JSON, maybe in a code fence, maybe with words around it.
export function parseBrainText(raw: string): BrainReply {
  const text = raw.trim()
  const json = text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1)
  let reply: { say?: unknown; tool?: unknown; pending?: unknown }
  try {
    reply = JSON.parse(json)
  } catch {
    // Plain words instead of JSON: say them, run nothing.
    return { say: text.slice(0, 500), tool: null, pending: null }
  }
  const tool = toolOf(reply.tool, BRAIN_TOOLS)
  // A pending action only makes sense when nothing runs now.
  const pending = tool ? null : toolOf(reply.pending, PENDABLE_TOOLS)
  return { say: typeof reply.say === 'string' ? reply.say : '', tool, pending }
}

// Reads `claude -p --output-format json` (the fallback brain).
export function parseBrain(stdout: string): BrainReply {
  const envelope = JSON.parse(stdout.trim().split('\n').pop() || '{}') as { result?: string; is_error?: boolean }
  if (envelope.is_error || typeof envelope.result !== 'string') throw new Error(`the brain failed: ${envelope.result ?? 'no result'}`)
  return parseBrainText(envelope.result)
}

// The brain prompt, read once per mod load.
let brainPrompt: string | null = null

// One brain turn. The engine's direct model call: no process to start, and the prompt is cached
// between turns. An engine that cannot make the call (an older Claude Code) throws, and the
// `claude -p` fallback answers instead, in the time left.
async function askBrain($: EngineInterface, request: BrainRequest): Promise<BrainReply> {
  brainPrompt ??= await $.fs.read(`${$.plugin.root}/agent/brain-prompt.md`)
  const startedAt = await $.clock.now()
  let reply: Awaited<ReturnType<EngineInterface['model']['complete']>> | null = null
  let failure = ''
  try {
    reply = await $.model.complete({
      model: BRAIN_MODEL,
      system: [{ text: brainPrompt, cache: true }],
      prompt: brainInput(request),
      effort: BRAIN_EFFORT,
      maxTokens: BRAIN_MAX_TOKENS,
      timeoutMs: BRAIN_TIMEOUT_MS,
    })
  } catch (error) {
    reply = null
    failure = error instanceof Error ? error.message : String(error)
  }
  if (reply) {
    if (!reply.isAnswered) throw new Error(`the brain failed: ${reply.reason}`)
    return parseBrainText(reply.text)
  }
  // A slow or failed direct call (a timeout, say) leaves too little time for a second, paid call.
  const left = BRAIN_BUDGET_MS - ((await $.clock.now()) - startedAt)
  if (left < MIN_FALLBACK_MS) throw new Error(`the brain did not answer in time: ${failure || 'no reply'}`)
  const out = await $.process.run(brainArgs($.plugin.root), { timeoutMs: left, stdin: brainInput(request) })
  if (out.exitCode !== 0 && !out.stdout.trim()) throw new Error(out.stderr.trim() || `claude exited with ${out.exitCode}`)
  return parseBrain(out.stdout)
}

async function think($: EngineInterface, command: { id: string; request: BrainRequest }) {
  try {
    return ack($, command.id, true, JSON.stringify(await askBrain($, command.request)))
  } catch (error) {
    return ack($, command.id, false, `The brain did not answer: ${error instanceof Error ? error.message : error}`)
  }
}

type Activity = { kind: 'prompt' | 'tool' | 'failure' | 'done' | 'attention' | 'info' | 'task_done'; text: string }

// The module's own state; a reload starts it over and the next poll subscribes again.
let generation = 0
let token: string | null = null
let subscribing: Promise<boolean> | null = null
let isBusy = false
let turnId: string | null = null
let queued: string[] = []
// Subagents started for voice tasks, by agent id: the task, to report with its result.
const tasks = new Map<string, string>()
// Spawned tasks whose agent id is not known yet, by the prompt their subagent starts with.
const pendingTasks = new Map<string, string>()
// The effort each voice-task subagent runs at, by agent id, or by its prompt until the id is known.
const taskEfforts = new Map<string, Effort>()

// The model and effort for a voice task, by how complex it is (see CLAUDE.md, "Task orchestration").
export type Complexity = 'complex' | 'medium' | 'simple'
type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max'
export const TIERS: Record<Complexity, { model: 'opus' | 'sonnet' | 'haiku'; effort: Effort }> = {
  complex: { model: 'opus', effort: 'high' },
  medium: { model: 'sonnet', effort: 'medium' },
  simple: { model: 'haiku', effort: 'low' },
}

// Architecture, multi-file changes, hard debugging. Stems, so Portuguese and English inflections match.
const COMPLEX =
  /arquitet|architect|refator|refactor|\bmigr[ae]|redesenh|redesign|reescrev|rewrite|v[aá]rios arquivos|multi-?file|projeto (inteiro|todo)|todo o (projeto|reposit)|orquestr|orchestrat|depur|\bdebug|investig|race condition|condi[cç][aã]o de corrida|vazamento de mem|memory leak|desempenho|performance|seguran[cç]a|security/i
// A focused feature or fix in a few files.
const MEDIUM =
  /implement|corrij|corrig|consert|\bfix|adicion|\badd\b|\bcri[ae]r?\b|\bcreate|feature|funcionalidade|\bbug|\btestes?\b|\btests?\b|atualiz|\bupdate|alter[ae]|\bmud[ae]|\bchange|escrev|\bwrite|integr|endpoint|componente|component/i
const LONG_TASK = 600
const SHORT_TASK = 300

/** Sorts a voice task into a complexity tier from its wording and length. */
export function classifyTask(task: string): Complexity {
  const text = task.trim()
  if (COMPLEX.test(text) || text.length > LONG_TASK) return 'complex'
  if (MEDIUM.test(text) || text.length > SHORT_TASK) return 'medium'
  // Lookups, small edits, mechanical changes.
  return 'simple'
}

const short = (text: string, max = 300) => (text.length > max ? `${text.slice(0, max - 1)}…` : text)

function frameTask(task: string) {
  return [
    'The user asked for this out loud, through luke-voice, their voice assistant, and confirmed it:',
    '',
    task,
    '',
    'Do it on this machine. End with a short answer in Brazilian Portuguese, two or three sentences that are easy to say out loud: what you found or changed, and anything that failed. No code blocks or long paths in that answer.',
  ].join('\n')
}

function frame(prompt: string) {
  return `The user asked luke-voice, their voice assistant, to pass this on:\n\n${prompt}`
}

async function setLink($: EngineInterface, patch: Partial<Link>) {
  await update($, link, current => ({ ...current, ...patch }))
  await refreshStatus($)
}

// The status line under the prompt only when something needs attention. Claude Code draws a
// plugin's status as a pinned notice (yellow, with the plugin's name in front), so a line on
// every healthy moment read as a warning; the footer button and the pane already show the state.
export function statusLine(l: Link): string | undefined {
  if (l.state === 'down') return `servidor local fora do ar${l.reason ? ` (${short(l.reason, 80)})` : ''} · /luke-voice help`
  if (l.state === 'up' && l.reason === 'no ElevenLabs key') return 'falta a chave da ElevenLabs · /luke-voice help'
  return undefined
}

async function refreshStatus($: EngineInterface) {
  $.ui.status(statusLine(await read($, link)))
}

async function addLine($: EngineInterface, line: Omit<Line, 'at'>) {
  const at = await $.clock.now()
  await update($, lines, list => [...list, { ...line, text: short(line.text, MAX_LINE_TEXT), at }].slice(-MAX_LINES))
}

async function startRunning($: EngineInterface, key: string, task: string) {
  const startedAt = await $.clock.now()
  await update($, running, list => [...list.filter(r => r.key !== key), { key, task, startedAt }])
}

async function stopRunning($: EngineInterface, key: string) {
  await update($, running, list => list.filter(r => r.key !== key))
}

// Seconds or minutes since a moment, for the pane.
function elapsed(from: number, now: number) {
  const s = Math.max(0, Math.round((now - from) / 1000))
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}min ${String(s % 60).padStart(2, '0')}s`
}

// The pane's markers: one glyph and one theme color per kind of entry.
const MARKS: Record<string, { glyph: string; color?: string }> = {
  task: { glyph: '▶', color: 'suggestion' },
  result: { glyph: '✓', color: 'success' },
  failure: { glyph: '✗', color: 'error' },
  sent: { glyph: '→', color: 'success' },
  note: { glyph: '+', color: 'success' },
  queued: { glyph: '⏳', color: 'warning' },
  stop: { glyph: '■', color: 'error' },
  info: { glyph: '·' },
}
const markOf = (kind: string) => MARKS[kind] ?? { glyph: '·' }

// A row's one-line preview: its first non-empty line, Markdown marks dropped.
export function preview(text: string) {
  const first = text.trim().split('\n').find(l => l.trim()) ?? ''
  return first.replace(/^#+\s+|^[-*>]\s+/, '').replace(/[*_`]/g, '').trim()
}

// Ids for the pane's rows, so an opened row stays open across redraws and new rows.
const historyId = (line: Line) => `h:${line.at}:${line.kind}`
const runningId = (r: Running) => `r:${r.key}`
const toolId = (tool: NonNullable<LastTool>) => `t:${tool.at}`

async function toggleRow($: EngineInterface, id: string) {
  await update($, expanded, ids => (ids.includes(id) ? ids.filter(x => x !== id) : [...ids, id].slice(-200)))
}

function hhmm(at: number) {
  const d = new Date(at)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

async function hubFetch($: EngineInterface, method: string, path: string, body?: unknown, auth = token) {
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  if (auth) headers.authorization = `Bearer ${auth}`
  const res = await $.http.fetch(`${HUB}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  let json: Record<string, unknown> = {}
  try {
    json = res.text ? JSON.parse(res.text) : {}
  } catch {
    // A body that is not JSON is not from the hub.
  }
  return { status: res.status, ok: res.ok, json }
}

export type VoiceProvider = 'local' | 'elevenlabs'
const PROVIDERS: VoiceProvider[] = ['local', 'elevenlabs']
// What people say for each voice in /luke-voice voz.
const VOICE_WORDS: Record<string, VoiceProvider> = {
  local: 'local',
  gratuita: 'local',
  gratis: 'local',
  'grátis': 'local',
  free: 'local',
  ceci: 'local',
  elevenlabs: 'elevenlabs',
  eleven: 'elevenlabs',
}
// The voice the hub uses, as it last answered; empty until the first subscribe.
let voice: VoiceProvider | '' = ''
// The voice chosen with /luke-voice voz, from the store (shared by every Claude session).
let storedVoice: VoiceProvider | '' = ''

// Read again before each subscribe: another session may have changed the voice since this one
// started, and an old choice sent on subscribe would undo it in the hub.
async function loadStoredVoice($: EngineInterface) {
  const saved = await $.store.get('voiceProvider')
  storedVoice = typeof saved === 'string' && PROVIDERS.includes(saved as VoiceProvider) ? (saved as VoiceProvider) : ''
}

// The voice chosen with /luke-voice voz, else the one saved in the plugin config, else none
// (the hub then picks: ElevenLabs while a key is set, else the free local voice).
function chosenProvider(options: Record<string, unknown>): VoiceProvider | '' {
  if (storedVoice) return storedVoice
  const configured = typeof options.voice_provider === 'string' ? options.voice_provider.trim().toLowerCase() : ''
  return PROVIDERS.includes(configured as VoiceProvider) ? (configured as VoiceProvider) : ''
}

const voiceName = (provider: string) => (provider === 'elevenlabs' ? 'ElevenLabs' : 'gratuita (Ceci, no seu computador)')

async function apiKey($: EngineInterface, options: Record<string, unknown>) {
  const configured = typeof options.api_key === 'string' ? options.api_key.trim() : ''
  return configured || (await $.env.get('ELEVENLABS_API_KEY')) || ''
}

// Starts the hub when it is down and subscribes this session to it.
async function subscribeOnce($: EngineInterface, options: Record<string, unknown>): Promise<boolean> {
  try {
    await loadStoredVoice($)
    // The key goes to the launcher on stdin, so a hub it starts has it from the first call.
    const launched = await $.process.run(['node', `${$.plugin.root}/hub/launch.mjs`], {
      timeoutMs: 20_000,
      stdin: JSON.stringify({ apiKey: await apiKey($, options), provider: chosenProvider(options) }),
    })
    const out = JSON.parse(launched.stdout.trim().split('\n').pop() || '{}') as { ok?: boolean; serviceToken?: string; error?: string }
    if (!out.ok || !out.serviceToken) {
      await setLink($, { state: 'down', reason: out.error || launched.stderr.trim() || 'the hub did not start' })
      return false
    }
    const res = await hubFetch(
      $,
      'POST',
      '/subscribe',
      { cwd: await $.session.cwd(), sessionId: await $.session.id(), apiKey: await apiKey($, options), provider: chosenProvider(options), version: await pluginVersion($) },
      out.serviceToken,
    )
    if (!res.ok || typeof res.json.token !== 'string') {
      await setLink($, { state: 'down', reason: `subscribe failed (${res.status})` })
      return false
    }
    token = res.json.token
    // A hub older than 0.8.0 does not answer with a voice: it only has ElevenLabs.
    voice = res.json.provider === 'local' ? 'local' : 'elevenlabs'
    // Only the ElevenLabs voice needs a key; the free voice runs without one.
    await setLink($, { state: 'up', name: String(res.json.name), reason: voice === 'elevenlabs' && !res.json.hasKey ? 'no ElevenLabs key' : null })
    return true
  } catch (error) {
    await setLink($, { state: 'down', reason: String(error instanceof Error ? error.message : error) })
    return false
  }
}

function subscribe($: EngineInterface, options: Record<string, unknown>): Promise<boolean> {
  if (token) return Promise.resolve(true)
  subscribing ??= subscribeOnce($, options).finally(() => {
    subscribing = null
  })
  return subscribing
}

// Long-polls this session's inbox until the mod is turned off or reloaded.
async function pollLoop($: EngineInterface, options: Record<string, unknown>, gen: number) {
  while (gen === generation) {
    if (!(await subscribe($, options))) {
      await $.clock.sleep(RETRY_MS)
      continue
    }
    try {
      const res = await hubFetch($, 'GET', `/inbox?wait=${POLL_WAIT_MS}`)
      if (gen !== generation) return
      // A reload of this mod subscribed again for the same session: this older loop ends.
      if (res.status === 409) return
      if (res.status === 401 || res.status === 410) {
        token = null
        await $.clock.sleep(250)
        continue
      }
      if (!res.ok) throw new Error(`inbox ${res.status}`)
      for (const command of (res.json.commands ?? []) as Command[]) await onCommand($, command)
    } catch (error) {
      if (gen !== generation) return
      token = null
      await setLink($, { state: 'down', reason: String(error instanceof Error ? error.message : error) })
      await $.clock.sleep(RETRY_MS)
    }
  }
}

async function ack($: EngineInterface, id: string, ok: boolean, message: string) {
  await hubFetch($, 'POST', '/ack', { id, ok, message }).catch(() => undefined)
}

async function onCommand($: EngineInterface, command: Command) {
  if (!(await read($, isOn))) return ack($, command.id, false, 'luke-voice is off in that session.')
  // A brain turn takes seconds: run it beside the inbox, so a tool call right after is not held up.
  if (command.type === 'think') return void think($, command)
  if (command.type === 'stop') {
    if (!isBusy || !turnId) return ack($, command.id, false, 'Claude is not working right now.')
    try {
      await $.turn.abort({ turnId })
      await addLine($, { kind: 'stop', text: 'Claude parado.' })
      return ack($, command.id, true, 'Stopped Claude.')
    } catch (error) {
      return ack($, command.id, false, `Could not stop Claude: ${error instanceof Error ? error.message : error}`)
    }
  }

  if (command.type === 'task') {
    try {
      const prompt = frameTask(command.task)
      const tier = TIERS[classifyTask(command.task)]
      pendingTasks.set(prompt, command.task)
      taskEfforts.set(prompt, tier.effort)
      const spawned = await $.agent.spawn({ prompt, description: 'luke-voice task', model: tier.model })
      if (spawned.deny) {
        pendingTasks.delete(prompt)
        taskEfforts.delete(prompt)
        return ack($, command.id, false, `Could not start the task: ${spawned.deny}`)
      }
      // The id comes with the spawn, or with the subagent's turn.start (matched by its prompt).
      if (spawned.agentId) {
        pendingTasks.delete(prompt)
        tasks.set(spawned.agentId, command.task)
        taskEfforts.delete(prompt)
        taskEfforts.set(spawned.agentId, tier.effort)
      }
      await startRunning($, spawned.agentId ?? prompt, command.task)
      await addLine($, { kind: 'task', text: command.task })
      return ack($, command.id, true, 'Started. A Claude Code subagent is working on it; the result comes in a [news] update.')
    } catch (error) {
      return ack($, command.id, false, `Could not start the task: ${error instanceof Error ? error.message : error}`)
    }
  }

  const text = frame(command.prompt)
  if (!isBusy) {
    isBusy = true
    void $.prompt.submit({ text })
    await addLine($, { kind: 'sent', text: command.prompt })
    return ack($, command.id, true, 'Claude started a new turn with it.')
  }
  if (command.when === 'now') {
    try {
      const appended = await $.session.append({ message: { type: 'user', content: [{ type: 'text', text }] } })
      if (!('deny' in appended && appended.deny)) {
        await addLine($, { kind: 'note', text: command.prompt })
        return ack($, command.id, true, "Added as a note to Claude's running turn.")
      }
    } catch {
      // Fall through to the queue.
    }
  }
  queued.push(text)
  await addLine($, { kind: 'queued', text: command.prompt })
  return ack($, command.id, true, 'Queued. Claude gets it when the current turn ends.')
}

function report($: EngineInterface, event: Activity) {
  if (!token) return
  void read($, isOn)
    .then(on => (on ? hubFetch($, 'POST', '/events', { events: [event], isBusy }) : undefined))
    .catch(() => undefined)
}

async function turnOn($: EngineInterface, options: Record<string, unknown>) {
  const gen = ++generation
  await setLink($, { state: 'connecting', reason: null })
  void pollLoop($, options, gen).catch(() => undefined)
}

// Off: leave the hub, stop polling, drop the queue and close the pane. The hub ends the call
// when no subscribed session is left.
async function turnOff($: EngineInterface) {
  generation++
  const leaving = token
  token = null
  queued = []
  if (leaving) await hubFetch($, 'POST', '/unsubscribe', {}, leaving).catch(() => undefined)
  await $.ui.close({ id: PANE }).catch(() => undefined)
  await setLink($, { state: 'off', name: null, reason: null })
}

// Turning it on also opens the window and starts the call, unless the caller does that itself.
async function toggle($: EngineInterface, options: Record<string, unknown>, to?: boolean, startCall = true) {
  await update($, isOn, v => to ?? !v)
  const active = await read($, isOn)
  await $.store.set('isOn', active)
  if (active) {
    await turnOn($, options)
    if (startCall) void show($, options, true).then(text => $.ui.toast(text)).catch(() => undefined)
  } else {
    await turnOff($)
  }
  $.ui.toast(active ? 'luke-voice: on, starting the call…' : 'luke-voice: off')
  return active
}

async function show($: EngineInterface, options: Record<string, unknown>, withCall: boolean) {
  if (!(await read($, isOn))) await toggle($, options, true, false)
  if (!(await subscribe($, options))) {
    const l = await read($, link)
    return `luke-voice could not reach its hub: ${l.reason ?? 'unknown reason'}.`
  }
  void $.ui.open({ id: PANE, title: 'luke-voice' })
  const res = await hubFetch($, 'POST', '/show', { call: withCall })
  const l = await read($, link)
  const keyNote = l.reason === 'no ElevenLabs key' ? ' No ElevenLabs key yet: set ELEVENLABS_API_KEY or run /plugin configure luke-voice@luke-voice.' : ''
  return `${withCall ? 'Calling' : 'Window shown'} as session "${l.name}".${res.json.isWindowOpen ? '' : ' The call window is opening.'}${keyNote}`
}

// /luke-voice voz [local|elevenlabs]: shows the voice, or switches it for the next call.
async function voiceCommand($: EngineInterface, options: Record<string, unknown>, arg: string) {
  const word = arg.trim().toLowerCase()
  if (!word) {
    const health = await hubFetch($, 'GET', '/health', undefined, null).catch(() => null)
    // The running hub says which voice it uses; with no hub yet, the choice saved in Claude Code.
    const current = health?.ok && health.json.app === 'luke-voice' ? String(health.json.provider ?? '') : voice || chosenProvider(options)
    return [
      `Voz atual: ${current ? voiceName(current) : 'automática (a gratuita, ou a ElevenLabs se houver chave salva)'}.`,
      'Para trocar: /luke-voice voz local (gratuita, no seu computador) ou /luke-voice voz elevenlabs.',
    ].join('\n')
  }
  const next = VOICE_WORDS[word]
  if (!next) return `Não conheço a voz "${short(word, 30)}". Use /luke-voice voz local ou /luke-voice voz elevenlabs.`
  await $.store.set('voiceProvider', next)
  storedVoice = next
  const res = token ? await hubFetch($, 'POST', '/provider', { provider: next }).catch(() => null) : null
  const isApplied = Boolean(res?.ok)
  const hasKey = Boolean(res?.json.hasKey)
  if (isApplied) {
    voice = next
    await setLink($, { reason: next === 'elevenlabs' && !hasKey ? 'no ElevenLabs key' : null })
  }
  return [
    `Voz trocada para ${voiceName(next)}. ${isApplied ? 'Vale a partir da próxima chamada.' : 'Vale quando o luke-voice ligar.'}`,
    next === 'elevenlabs' && isApplied && !hasKey ? 'Falta a chave da ElevenLabs: salve com /plugin configure luke-voice@luke-voice e reinicie o Claude Code.' : null,
  ]
    .filter(Boolean)
    .join('\n')
}

async function statusText($: EngineInterface) {
  const on = await read($, isOn)
  if (!on) return 'luke-voice: off. Nothing from this session is sent anywhere.'
  const l = await read($, link)
  const health = await hubFetch($, 'GET', '/health', undefined, null).catch(() => null)
  const h = health?.json ?? {}
  return [
    `luke-voice: on (${l.state}${l.name ? `, session "${l.name}"` : ''})`,
    health?.ok ? `hub: up, version ${h.version}, ${h.sessions} session(s), call ${h.call}, window ${h.isWindowOpen ? 'open' : 'closed'}` : 'hub: down',
    health?.ok ? `voz: ${voiceName(String(h.provider ?? 'elevenlabs'))}` : null,
    health?.ok && h.provider === 'local' ? `perfil: ${profileText(h)}` : null,
    health?.ok && (h.provider ?? 'elevenlabs') === 'elevenlabs' && !h.hasKey ? 'missing: ElevenLabs API key' : null,
    queued.length ? `queued prompts: ${queued.length}` : null,
  ]
    .filter(Boolean)
    .join('\n')
}

// The free voice's profile as the hub reports it: natural on the GPU, light in the browser, or
// still downloading.
type EngineHealth = { profile?: string | null; native?: Record<string, boolean>; download?: { loaded?: number; total?: number; error?: string } | null }
function profileText(h: EngineHealth) {
  const d = h.download
  if (d?.error) return `erro ao preparar a voz natural (${short(d.error, 80)}). Tente /luke-voice setup`
  if (d?.total) return `baixando a voz natural, ${Math.min(99, Math.round(((d.loaded ?? 0) / d.total) * 100))}%`
  if (h.profile === 'gpu') {
    const up = Object.entries(h.native ?? {}).filter(([, isUp]) => isUp).map(([name]) => name)
    return `voz natural na placa de vídeo${up.length ? ` (${up.join(', ')} rodando)` : ' (sobe na próxima chamada)'}`
  }
  if (h.profile === 'light') return 'voz leve no navegador (sem placa de vídeo com 6 GB)'
  return 'ainda não preparado: /luke-voice setup baixa a voz agora'
}

// /luke-voice setup: downloads and checks the free voice now (as the installer does), instead of
// on the first call. With luke-voice on, the hub does it in the background (up to 3 GB with a GPU)
// and /luke-voice status shows the progress; with it off, hub/setup.mjs runs here, for at most ten
// minutes, and a cut download resumes on the next run.
async function setupCommand($: EngineInterface) {
  if (token) {
    const res = await hubFetch($, 'POST', '/setup', {}).catch(() => null)
    const answer = (res?.json ?? {}) as { started?: boolean; reason?: string }
    if (res?.ok && answer.started) return 'Preparando a voz da Ceci no hub: ele baixa o que falta e escolhe o perfil. Acompanhe com /luke-voice status.'
    if (res?.ok && answer.reason === 'running') return 'A voz já está sendo preparada. Acompanhe com /luke-voice status.'
  }
  let out: { stdout: string; stderr: string } | null = null
  try {
    out = await $.process.run(['node', `${$.plugin.root}/hub/setup.mjs`, '--json'], { timeoutMs: 10 * 60_000 })
  } catch {
    return 'O download ainda não terminou. Rode /luke-voice setup de novo: ele continua de onde parou.'
  }
  let result: { ok?: boolean; profile?: string; reason?: string; heard?: string; problems?: string[]; error?: string } = {}
  try {
    result = JSON.parse(out.stdout.trim().split('\n').pop() || '{}')
  } catch {
    result = { ok: false, error: out.stderr.trim() || 'setup did not answer' }
  }
  if (result.error) return `Não consegui preparar a voz: ${short(result.error, 200)}. Veja a internet e tente de novo.`
  if (result.profile === 'gpu' && result.ok) {
    return [
      `Voz natural pronta, na placa de vídeo (${result.reason}).`,
      result.heard ? `No teste, a Ceci disse: "${result.heard}".` : 'Ela já estava rodando no hub.',
      'Na próxima chamada, é ela que fala.',
    ].join('\n')
  }
  if (result.profile === 'gpu') return `A voz natural baixou, mas o teste falhou: ${(result.problems ?? []).join('; ')}. Por enquanto as chamadas usam a voz leve.`
  return `Voz leve pronta, no navegador (${result.reason || 'sem placa de vídeo com 6 GB'}). Nada mais para baixar.`
}

// The installed plugin's version, to tell when the running hub is an older one.
async function pluginVersion($: EngineInterface) {
  try {
    const text = await $.fs.read(`${$.plugin.root}/.claude-plugin/plugin.json`)
    return String(JSON.parse(text).version ?? '')
  } catch {
    return ''
  }
}

// /luke-voice help: everything a person needs, starting with what is missing right now.
async function helpText($: EngineInterface) {
  const on = await read($, isOn)
  const health = await hubFetch($, 'GET', '/health', undefined, null).catch(() => null)
  const h = (health?.ok && health.json.app === 'luke-voice' ? health.json : null) as ({
    version?: string
    hasKey?: boolean
    keyStatus?: string
    provider?: string
  } & EngineHealth) | null
  const version = await pluginVersion($)
  const mark = (ok: boolean) => (ok ? '✓' : '✗')
  // A hub older than 0.8.0 does not report a voice: it only has ElevenLabs.
  const provider = h ? (h.provider ?? 'elevenlabs') : ''
  const isEleven = provider === 'elevenlabs'
  const checks = [
    `${mark(on)} luke-voice ligado${on ? '' : ': clique no botão "✦ luke-voice: off" acima do prompt, ou digite /luke-voice'}`,
    `${mark(Boolean(h))} Servidor local (hub)${h ? ` rodando, versão ${h.version}` : ': não está rodando. Ele sobe sozinho quando você liga o luke-voice'}`,
    h ? `✓ Voz: ${voiceName(provider)}. Para trocar: /luke-voice voz` : null,
    h && provider === 'local' ? `${mark(Boolean(h.profile) && !h.download?.error)} Perfil: ${profileText(h)}` : null,
    // Only the ElevenLabs voice needs a key.
    h && isEleven
      ? h.keyStatus === 'rejected'
        ? '✗ Chave da ElevenLabs: a ElevenLabs recusou a chave salva. Crie uma nova (veja "Voz ElevenLabs" abaixo) e reinicie o Claude Code'
        : `${mark(Boolean(h.hasKey))} Chave da ElevenLabs${h.hasKey ? ' configurada' : ': falta. Veja "Voz ElevenLabs" abaixo'}`
      : null,
    h && version && h.version !== version
      ? `✗ O hub é da versão ${h.version}, mas a instalada é ${version}: feche o Claude Code e abra de novo`
      : null,
  ].filter(Boolean)

  return [
    'luke-voice: ajuda',
    '',
    'Seu status agora:',
    ...checks.map(line => `  ${line}`),
    '',
    'O que é: a Ceci, uma assistente de voz em português ao lado do Claude Code. Você fala o que quer, ela repete e pergunta "posso?", e depois do seu "sim" um subagente do Claude faz a tarefa no seu computador. Quando termina, ela conta o resultado.',
    '',
    'Antes de usar (uma vez só):',
    '  1. Tenha o Node.js 20 ou mais novo (nodejs.org, versão LTS) e o Google Chrome.',
    '  2. Depois de instalar, atualizar ou trocar a configuração: feche o Claude Code e abra de novo.',
    '     O /reload-plugins não basta para trocar de versão.',
    '',
    'As vozes (troque com /luke-voice voz):',
    '  - Gratuita (padrão): roda no seu computador e é baixada na instalação, uma vez só.',
    '    Com placa de vídeo de 6 GB ou mais: a voz natural da Ceci (2,8 GB). Sem ela: a voz leve, no navegador (cerca de 320 MB).',
    '    O áudio não sai do seu computador; só o texto do que você falou vai para o Claude (Claude Haiku 5.5, da sua conta).',
    '  - ElevenLabs (opcional, paga por uso): crie uma conta em elevenlabs.io e copie uma chave em elevenlabs.io/app/settings/api-keys.',
    '    Salve a chave com: /plugin configure luke-voice@luke-voice e escolha /luke-voice voz elevenlabs.',
    '    O plano grátis da ElevenLabs dá cerca de 15 minutos de chamada por mês.',
    '  - A chave fica guardada pelo Claude Code (no Mac, no Keychain). Uma chave exportada no ~/.zshrc não chega a um Claude Code aberto pelo Dock.',
    '',
    'Como usar:',
    '  1. Clique em "✦ luke-voice: off" acima do prompt. Ele vira "on", a janela abre e a chamada começa.',
    '  2. Fale normalmente. Exemplo: "Verifica no repositório luke-voice onde o botão de ligar é desenhado."',
    '  3. Ela repete o pedido e pergunta "posso?". Diga "sim".',
    '  4. O pedido aparece em Histórico, na janela. Quando terminar, ela fala o resultado.',
    '',
    'Comandos:',
    '  /luke-voice          liga ou desliga (ligar já começa a chamada)',
    '  /luke-voice call     abre a janela e começa a chamada',
    '  /luke-voice end      encerra a chamada',
    '  /luke-voice window   traz a janela para a frente',
    '  /luke-voice voz      mostra ou troca a voz (local ou elevenlabs)',
    '  /luke-voice setup    baixa e testa a voz gratuita agora (se a instalação não baixou)',
    '  /luke-voice status   mostra o estado técnico',
    '  /luke-voice help     mostra esta ajuda',
    '',
    'Bom saber:',
    '  - A janela usa um Chrome só dela, com o microfone e o som já liberados. O seu Chrome normal não muda.',
    '  - Voz gratuita: enquanto está ligado, o texto do que você fala e o resumo do que acontece nesta sessão vão para o Claude Haiku. Diga "pare" para parar o Claude na hora.',
    '  - Voz ElevenLabs: na primeira chamada, o luke-voice cria um agente chamado "luke-voice" e adiciona a voz "Roberta" na sua conta. O que acontece nesta sessão (seus pedidos e as ferramentas do Claude) é enviado a esse agente.',
    '  - Desligado, nada sai do seu computador.',
    '',
    'Se algo não funcionar:',
    '  - Não ouço nada: veja se o som do computador está ligado e se a janela mostra "Em chamada".',
    '  - Voz gratuita demora para falar: veja o Perfil acima. Se ainda está baixando, espere ou rode /luke-voice setup. Sem placa de vídeo, cada resposta leva 1 a 2 segundos a mais.',
    '  - "No ElevenLabs API key" ou "Chave faltando": salve a chave (veja "As vozes") e reinicie o Claude Code, ou volte para a voz gratuita com /luke-voice voz local.',
    '  - "Hub offline" na janela: ligue o luke-voice no Claude Code; a janela volta sozinha.',
    '  - ElevenLabs: a chamada não conecta mais: os minutos grátis do mês podem ter acabado. Veja em elevenlabs.io.',
    '  - A janela está com o visual antigo: feche o Claude Code e abra de novo.',
    '  - Outro erro: digite /luke-voice status e mande o resultado para quem cuida do luke-voice.',
  ]
    .filter(line => line !== null)
    .join('\n')
}

export const register: Register = (on, options) => {
  const opts = options as Record<string, unknown>

  on('session.start', async ($, e, next) => {
    const saved = await $.store.get('isOn')
    if (typeof saved === 'boolean') await update($, isOn, () => saved)
    await loadStoredVoice($)
    // The hub's port follows LUKE_VOICE_PORT, like the hub (hub/paths.mjs).
    const port = Number(await $.env.get('LUKE_VOICE_PORT'))
    if (Number.isInteger(port) && port > 0 && port < 65536) HUB = `http://127.0.0.1:${port}`
    await $.command.register({ name: NAME, description: 'Ceci, voice assistant: on/off, call, end, window, voz, setup, status, help' })
    // Redraw the pane while a task runs, so its elapsed time moves.
    $.clock.every(15_000, () => {
      void read($, running)
        .then(list => (list.length > 0 ? update($, running, l => [...l]) : undefined))
        .catch(() => undefined)
    })
    const started = await next(e)
    if (await read($, isOn)) await turnOn($, opts)
    return started
  })

  on('command.run', { command: NAME }, async ($, e) => {
    const arg = e.args.trim().toLowerCase()
    const voiceArg = arg.match(/^(voz|voice)(\s+(.*))?$/)
    if (voiceArg) return { text: await voiceCommand($, opts, voiceArg[3] ?? '') }
    switch (arg) {
      case '':
        return { text: (await toggle($, opts)) ? 'luke-voice: on. Starting the call.' : 'luke-voice: off' }
      case 'on':
      case 'off':
        return { text: (await toggle($, opts, arg === 'on')) ? 'luke-voice: on. Starting the call.' : 'luke-voice: off' }
      case 'call':
        return { text: await show($, opts, true) }
      case 'window':
        return { text: await show($, opts, false) }
      case 'end':
        if (token) await hubFetch($, 'POST', '/end', {})
        return { text: 'Call ended.' }
      case 'status':
        return { text: await statusText($) }
      case 'setup':
        return { text: await setupCommand($) }
      case 'help':
      case 'ajuda':
        return { text: await helpText($) }
      default:
        return { text: `Não conheço "${short(arg, 40)}". Use /luke-voice help para ver tudo que dá para fazer.` }
    }
  }).catch((_$, error) => ({ text: `luke-voice: ${error instanceof Error ? error.message : String(error)}` }))

  on('prompt.submit', async ($, e, next) => {
    if (e.origin.kind === 'composer' && !e.isMeta && e.text.trim()) report($, { kind: 'prompt', text: short(e.text, 600) })
    return next(e)
  }).catch(($, e, next) => next(e))

  on('turn.start', async ($, e, next) => {
    const pending = e.agentId !== undefined ? pendingTasks.get(e.text) : undefined
    if (e.agentId !== undefined && pending !== undefined) {
      pendingTasks.delete(e.text)
      tasks.set(e.agentId, pending)
      const effort = taskEfforts.get(e.text)
      taskEfforts.delete(e.text)
      if (effort) taskEfforts.set(e.agentId, effort)
      await stopRunning($, e.text)
      await startRunning($, e.agentId, pending)
    } else if (e.agentId !== undefined && tasks.has(e.agentId)) {
      // A stopped task its subagent picked up again.
      const resumed = tasks.get(e.agentId) ?? ''
      if (!(await read($, running)).some(r => r.key === e.agentId)) await startRunning($, e.agentId, resumed)
    }
    if (e.agentId === undefined) {
      isBusy = true
      turnId = e.turnId
      void refreshStatus($)
    }
    return next(e)
  })

  // Each request of a voice-task subagent asks for its tier's effort (a rewrite lasts one step).
  on('turn.step', async function* ($, e, next) {
    const effort = e.agentId !== undefined ? taskEfforts.get(e.agentId) : undefined
    return yield* next(effort ? { ...e, effort } : e)
  })

  on('tool.call', async ($, e, next) => {
    const result = await next(e)
    // Reporting never changes the tool's result, and never runs the tool twice.
    try {
      if (e.agentId === undefined) {
        const args = e as unknown as Record<string, unknown>
        const detail = [args.command, args.file_path, args.pattern, args.url].find(v => typeof v === 'string') as string | undefined
        const failed = 'deny' in result ? Boolean(result.deny) : Boolean(result.isError)
        const full = `${e.tool}${detail ? ` ${detail}` : ''}`
        report($, { kind: failed ? 'failure' : 'tool', text: short(full, 200) })
        // The pane keeps more: an opened row shows the whole command.
        const text = short(full, MAX_TOOL_TEXT)
        // The pane shows the last tool call; only failures go into its history.
        void $.clock
          .now()
          .then(at => update($, lastTool, () => ({ text, isFailed: failed, at })))
          .then(() => (failed ? addLine($, { kind: 'failure', text }) : undefined))
          .catch(() => undefined)
      }
    } catch {
      // Activity is best effort.
    }
    return result
  })

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    const task = e.agentId !== undefined ? tasks.get(e.agentId) : undefined
    if (e.agentId !== undefined && task !== undefined) {
      await stopRunning($, e.agentId)
      if (e.isAborted) {
        // Stopped, not finished: keep tracking it, so a resumed run still reports its answer.
        await addLine($, { kind: 'stop', text: `Tarefa parada: ${task}` })
      } else {
        tasks.delete(e.agentId)
        taskEfforts.delete(e.agentId)
        const answer = e.answer || 'Done, with no answer.'
        report($, { kind: 'task_done', text: short(`Task: ${task}\nResult: ${answer}`, 1500) })
        await addLine($, { kind: 'result', text: answer })
      }
    }
    if (e.agentId === undefined) {
      isBusy = false
      turnId = null
      report($, { kind: 'done', text: e.isAborted ? 'Claude stopped.' : short(e.answer || 'Claude finished.', 1200) })
      void refreshStatus($)
      const nextPrompt = queued.shift()
      if (nextPrompt) {
        $.clock.after(300, () => {
          isBusy = true
          void $.prompt.submit({ text: nextPrompt })
        })
      }
    }
    return result
  })

  on('classic.Notification', async ($, e, next) => {
    const message = (e as unknown as { message?: string }).message
    if (message) report($, { kind: 'attention', text: short(message, 300) })
    return next(e)
  }).catch(($, e, next) => next(e))

  on('session.end', async ($, e, next) => {
    generation++
    const leaving = token
    token = null
    if (leaving) await hubFetch($, 'POST', '/unsubscribe', {}, leaving).catch(() => undefined)
    return next(e)
  })

  // Footer row: what the engine and other mods draw there, then the toggle.
  on('ui.render', { component: 'SessionMode' }, async ($, e, next) => {
    const { Box, Button } = $.ui.resolve(e)
    const active = await read($, isOn)

    return (
      <Box>
        {await next(e)}
        <Button
          key="luke-voice-toggle"
          label={active ? '✦ luke-voice: on' : '✦ luke-voice: off'}
          variant={active ? 'primary' : 'secondary'}
          onPress={() => toggle($, opts)}
        />
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Markdown, Button } = $.ui.resolve(e)
    const l = await read($, link)
    const list = await read($, lines)
    const now = await $.clock.now()
    const tasksNow = await read($, running)
    const tool = await read($, lastTool)
    const open = new Set(await read($, expanded))
    const status =
      l.state === 'up'
        ? { color: 'success', text: `● conectado · ${l.name}` }
        : l.state === 'connecting'
          ? { color: 'warning', text: '● conectando' }
          : l.state === 'down'
            ? { color: 'error', text: '● hub offline' }
            : { color: 'inactive', text: '○ desligado' }
    // Every kept row is drawn, newest first; the pane scrolls when they do not fit.
    const history = [...list].reverse()
    const allIds = [...tasksNow.map(runningId), ...(tool ? [toolId(tool)] : []), ...history.map(historyId)]

    // One row: a Button with the chevron, its mark and a one-line preview; opened, the full text under it.
    type Row = { id: string; mark: { glyph: string; color?: string }; time?: string; side?: string; text: string; isMarkdown?: boolean; color?: string; dim?: boolean }
    const row = (o: Row) => {
      const isOpen = open.has(o.id)
      return (
        <Box key={o.id} flexDirection="column" marginBottom={isOpen ? 1 : 0}>
          <Box justifyContent="space-between" gap={1}>
            <Box flexShrink={1}>
              <Button key={`row-${o.id}`} label={isOpen ? 'Recolher' : 'Expandir'} plain onPress={() => void toggleRow($, o.id)}>
                <Text dimColor>{isOpen ? '▾ ' : '▸ '}</Text>
                <Text color={o.mark.color} dimColor={o.mark.color === undefined}>
                  {o.mark.glyph}
                </Text>
                <Text dimColor tabular>
                  {o.time ? ` ${o.time}` : ''}
                </Text>
                <Text color={o.color} dimColor={o.dim} wrap="truncate-end">
                  {isOpen ? '' : ` ${preview(o.text)}`}
                </Text>
              </Button>
            </Box>
            {o.side ? (
              <Text dimColor tabular>
                {o.side}
              </Text>
            ) : null}
          </Box>
          {isOpen ? (
            <Box paddingLeft={2} flexDirection="column">
              {o.isMarkdown ? <Markdown text={o.text.trim()} /> : <Text color={o.color} wrap="wrap">{o.text.trim()}</Text>}
            </Box>
          ) : null}
        </Box>
      )
    }

    return (
      <Box flexDirection="column" paddingX={1}>
        <Box justifyContent="space-between">
          <Text bold color="success">
            ◉ luke-voice
          </Text>
          <Text color={status.color}>{status.text}</Text>
        </Box>
        <Text dimColor>{isBusy ? 'Claude trabalhando' : 'Claude ocioso'}{l.reason ? ` · ${l.reason}` : ''}</Text>
        {allIds.length > 0 && (
          <Box gap={2}>
            <Button key="expand-all" label="▾ Expandir tudo" plain dimColor onPress={() => void update($, expanded, () => allIds)} />
            <Button key="collapse-all" label="▸ Recolher tudo" plain dimColor onPress={() => void update($, expanded, () => [])} />
          </Box>
        )}

        <Box flexDirection="column" marginTop={1}>
          <Text bold>Agora</Text>
          {tasksNow.length === 0 && <Text dimColor>Nada em andamento</Text>}
          {tasksNow.map(r => row({ id: runningId(r), mark: markOf('task'), side: elapsed(r.startedAt, now), text: r.task, color: 'suggestion' }))}
          {tool && row({ id: toolId(tool), mark: markOf(tool.isFailed ? 'failure' : 'info'), text: tool.text, dim: !tool.isFailed, color: tool.isFailed ? 'error' : undefined })}
        </Box>

        <Box flexDirection="column" marginTop={1}>
          <Text bold>Histórico</Text>
          {history.length === 0 && <Text dimColor>Nada enviado ao Claude ainda.</Text>}
          {history.map(line => row({ id: historyId(line), mark: markOf(line.kind), time: hhmm(line.at), text: line.text, isMarkdown: line.kind === 'result' }))}
        </Box>
      </Box>
    )
  })
}
