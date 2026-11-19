import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { LastTool, Line, Link, Running } from '../types'

const NAME = 'luke-voice'
const HUB = 'http://127.0.0.1:4848'
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
const MAX_LINES = 40

type Command =
  | { id: string; type: 'send'; prompt: string; when: 'now' | 'after_current' }
  | { id: string; type: 'stop' }
  | { id: string; type: 'task'; task: string }

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

async function refreshStatus($: EngineInterface) {
  const l = await read($, link)
  if (l.state === 'off') return $.ui.status(undefined)
  if (l.state === 'connecting') return $.ui.status('✦ luke-voice: connecting…')
  if (l.state === 'down') return $.ui.status(`✦ luke-voice: hub down${l.reason ? ` (${short(l.reason, 80)})` : ''}`)
  $.ui.status(`✦ luke-voice: ${l.name} · ${isBusy ? 'Claude is working' : 'Claude is idle'} · /luke-voice call`)
}

async function addLine($: EngineInterface, line: Omit<Line, 'at'>) {
  const at = await $.clock.now()
  await update($, lines, list => [...list, { ...line, text: short(line.text, 1500), at }].slice(-MAX_LINES))
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

// Keeps the first lines of a Markdown answer, so a long result does not fill the pane.
function clampLines(text: string, max: number) {
  const all = text.trim().split('\n')
  return all.length <= max ? text.trim() : `${all.slice(0, max).join('\n')}\n…`
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

async function apiKey($: EngineInterface, options: Record<string, unknown>) {
  const configured = typeof options.api_key === 'string' ? options.api_key.trim() : ''
  return configured || (await $.env.get('ELEVENLABS_API_KEY')) || ''
}

// Starts the hub when it is down and subscribes this session to it.
async function subscribeOnce($: EngineInterface, options: Record<string, unknown>): Promise<boolean> {
  try {
    // The key goes to the launcher on stdin, so a hub it starts has it from the first call.
    const launched = await $.process.run(['node', `${$.plugin.root}/hub/launch.mjs`], {
      timeoutMs: 20_000,
      stdin: JSON.stringify({ apiKey: await apiKey($, options) }),
    })
    const out = JSON.parse(launched.stdout.trim().split('\n').pop() || '{}') as { ok?: boolean; serviceToken?: string; error?: string }
    if (!out.ok || !out.serviceToken) {
      await setLink($, { state: 'down', reason: out.error || launched.stderr.trim() || 'the hub did not start' })
      return false
    }
    const res = await hubFetch($, 'POST', '/subscribe', { cwd: await $.session.cwd(), sessionId: await $.session.id(), apiKey: await apiKey($, options) }, out.serviceToken)
    if (!res.ok || typeof res.json.token !== 'string') {
      await setLink($, { state: 'down', reason: `subscribe failed (${res.status})` })
      return false
    }
    token = res.json.token
    await setLink($, { state: 'up', name: String(res.json.name), reason: res.json.hasKey ? null : 'no ElevenLabs key' })
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
      pendingTasks.set(prompt, command.task)
      const spawned = await $.agent.spawn({ prompt, description: 'luke-voice task' })
      if (spawned.deny) {
        pendingTasks.delete(prompt)
        return ack($, command.id, false, `Could not start the task: ${spawned.deny}`)
      }
      // The id comes with the spawn, or with the subagent's turn.start (matched by its prompt).
      if (spawned.agentId) {
        pendingTasks.delete(prompt)
        tasks.set(spawned.agentId, command.task)
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

async function statusText($: EngineInterface) {
  const on = await read($, isOn)
  if (!on) return 'luke-voice: off. Nothing from this session is sent anywhere.'
  const l = await read($, link)
  const health = await hubFetch($, 'GET', '/health', undefined, null).catch(() => null)
  const h = health?.json ?? {}
  return [
    `luke-voice: on (${l.state}${l.name ? `, session "${l.name}"` : ''})`,
    health?.ok ? `hub: up, version ${h.version}, ${h.sessions} session(s), call ${h.call}, window ${h.isWindowOpen ? 'open' : 'closed'}` : 'hub: down',
    health?.ok && !h.hasKey ? 'missing: ElevenLabs API key' : null,
    queued.length ? `queued prompts: ${queued.length}` : null,
  ]
    .filter(Boolean)
    .join('\n')
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
  const h = (health?.ok && health.json.app === 'luke-voice' ? health.json : null) as { version?: string; hasKey?: boolean } | null
  const version = await pluginVersion($)
  const mark = (ok: boolean) => (ok ? '✓' : '✗')
  const checks = [
    `${mark(on)} luke-voice ligado${on ? '' : ': clique no botão "✦ luke-voice: off" acima do prompt, ou digite /luke-voice'}`,
    `${mark(Boolean(h))} Servidor local (hub)${h ? ` rodando, versão ${h.version}` : ': não está rodando. Ele sobe sozinho quando você liga o luke-voice'}`,
    h ? `${mark(Boolean(h.hasKey))} Chave da ElevenLabs${h.hasKey ? ' configurada' : ': falta. Veja o passo 2 abaixo'}` : null,
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
    'O que é: uma assistente de voz, em português, ao lado do Claude Code. Você fala o que quer, ela repete e pergunta "posso?", e depois do seu "sim" um subagente do Claude faz a tarefa no seu computador. Quando termina, ela conta o resultado.',
    '',
    'Antes de usar (uma vez só):',
    '  1. Tenha o Node.js 20 ou mais novo (nodejs.org, versão LTS) e o Google Chrome.',
    '  2. Crie uma conta grátis em elevenlabs.io e copie uma chave em elevenlabs.io/app/settings/api-keys.',
    '     Salve a chave com: /plugin configure luke-voice@luke-voice',
    '     O plano grátis dá cerca de 15 minutos de chamada por mês.',
    '  3. Depois de instalar, atualizar ou salvar a chave: feche o Claude Code e abra de novo.',
    '     O /reload-plugins não basta para trocar de versão.',
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
    '  /luke-voice status   mostra o estado técnico',
    '  /luke-voice help     mostra esta ajuda',
    '',
    'Bom saber:',
    '  - Na primeira chamada, o luke-voice cria um agente chamado "luke-voice" e adiciona a voz "Roberta" na sua conta da ElevenLabs. Leva alguns segundos.',
    '  - A janela usa um Chrome só dela, com o microfone e o som já liberados. O seu Chrome normal não muda.',
    '  - Enquanto está ligado, o que acontece nesta sessão (seus pedidos e as ferramentas do Claude) é enviado ao agente na ElevenLabs. Desligado, nada sai do seu computador.',
    '',
    'Se algo não funcionar:',
    '  - Não ouço nada: veja se o som do Windows está ligado e se a janela mostra "Em chamada".',
    '  - "No ElevenLabs API key" ou "Chave faltando": salve a chave (passo 2) e reinicie o Claude Code.',
    '  - "Hub offline" na janela: ligue o luke-voice no Claude Code; a janela volta sozinha.',
    '  - A chamada não conecta mais: os minutos grátis do mês podem ter acabado. Veja em elevenlabs.io.',
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
    await $.command.register({ name: NAME, description: 'Voice coworker: on/off, call, end, window, status, help' })
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

  on('tool.call', async ($, e, next) => {
    const result = await next(e)
    // Reporting never changes the tool's result, and never runs the tool twice.
    try {
      if (e.agentId === undefined) {
        const args = e as unknown as Record<string, unknown>
        const detail = [args.command, args.file_path, args.pattern, args.url].find(v => typeof v === 'string') as string | undefined
        const failed = 'deny' in result ? Boolean(result.deny) : Boolean(result.isError)
        const text = short(`${e.tool}${detail ? ` ${detail}` : ''}`, 200)
        report($, { kind: failed ? 'failure' : 'tool', text })
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
    const { Box, Text, Markdown } = $.ui.resolve(e)
    const l = await read($, link)
    const list = await read($, lines)
    const now = await $.clock.now()
    const tasksNow = await read($, running)
    const tool = await read($, lastTool)
    const status =
      l.state === 'up'
        ? { color: 'success', text: `● conectado · ${l.name}` }
        : l.state === 'connecting'
          ? { color: 'warning', text: '● conectando' }
          : l.state === 'down'
            ? { color: 'error', text: '● hub offline' }
            : { color: 'inactive', text: '○ desligado' }
    // Rows left for history: header 3, "Agora" title + its rows + spacing, "Histórico" title.
    const nowRows = Math.max(1, tasksNow.length) + (tool ? 1 : 0)
    const room = Math.max(4, (e.viewport?.rows ?? 24) - 7 - nowRows)
    const history: Line[] = []
    let used = 0
    for (const line of [...list].reverse()) {
      const cost = line.kind === 'result' ? 7 : 3
      if (used + cost > room && history.length > 0) break
      history.push(line)
      used += cost
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

        <Box flexDirection="column" marginTop={1}>
          <Text bold>Agora</Text>
          {tasksNow.length === 0 && <Text dimColor>Nada em andamento</Text>}
          {tasksNow.map(r => (
            <Box key={r.key} justifyContent="space-between" gap={1}>
              <Box flexShrink={1}>
                <Text color="suggestion" wrap="truncate-end">
                  ▶ {r.task}
                </Text>
              </Box>
              <Text dimColor tabular>
                {elapsed(r.startedAt, now)}
              </Text>
            </Box>
          ))}
          {tool && (
            <Text dimColor wrap="truncate-end" color={tool.isFailed ? 'error' : undefined}>
              {tool.isFailed ? '✗' : '·'} {tool.text}
            </Text>
          )}
        </Box>

        <Box flexDirection="column" marginTop={1}>
          <Text bold>Histórico</Text>
          {history.length === 0 && <Text dimColor>Nada enviado ao Claude ainda.</Text>}
          {history.map((line, i) => {
            const mark = MARKS[line.kind] ?? { glyph: '·' }
            return (
              <Box key={`${line.at}-${i}`} marginBottom={1}>
                <Box width={9} flexShrink={0}>
                  <Text color={mark.color} dimColor={mark.color === undefined}>
                    {mark.glyph}
                  </Text>
                  <Text dimColor tabular>
                    {' '}
                    {hhmm(line.at)}
                  </Text>
                </Box>
                <Box flexGrow={1} flexShrink={1}>
                  {line.kind === 'result' ? (
                    <Markdown text={clampLines(line.text, 6)} />
                  ) : (
                    <Text wrap="truncate-end">{line.text}</Text>
                  )}
                </Box>
              </Box>
            )
          })}
        </Box>
      </Box>
    )
  })
}
