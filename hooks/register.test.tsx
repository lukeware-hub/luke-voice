import { expect, test } from 'claude-code/testing'
import type { Args, On } from 'claude-code'

import { asPersona, brainArgs, brainInput, classifyTask, NO_NODE, parseBrain, parseBrainText, preview, TIERS } from './register'
import type { BrainRequest } from './register'

const FOOTER = { plugin: 'luke-voice', component: 'SessionMode', props: { modes: [] } } as const
const run = (args: string) => ({ command: 'luke-voice', args, origin: { kind: 'composer' } }) as Args<'command.run'>

type Call = { method: string; path: string; port: string; body: Record<string, unknown> }

// What `claude -p` prints in the brain tests; the launcher answer is used for every other process.
let brainStdout = ''
// What $.model.complete answers in the brain tests.
let brainComplete: Record<string, unknown> = { isAnswered: true, text: '{"say":"","tool":null}' }
// What hub/setup.mjs prints in the /luke-voice setup tests.
let setupStdout = ''
// LUKE_VOICE_PORT as the engine reports it; unset in every test but the port one.
let envPort: string | undefined
// What store.get answers for the next engine(), given the event (the key is in it).
let storeGet: (e: unknown) => unknown = () => undefined
// The installer's first-call marker: its text, or null when there is none. Reset by engine().
let firstCall: string | null = null
const markerWrites: Array<{ path: string; text: string }> = []
// The engine's clock; a test may move it, from inside a handler, to stand for time passing.
let clockNow = 1_700_000_000_000
// When set, the direct model call throws this, after the clock moved by `brainThrowsAfterMs`.
let brainThrows: string | null = null
let brainThrowsAfterMs = 0
// What hub/launch.mjs prints, and an error starting it throws instead (no Node.js). Reset by engine().
let launchStdout = '{"ok":true,"serviceToken":"svc"}\n'
let launchThrows: string | null = null
// The paths fs.exists finds besides the first-call marker (the installer's Node.js). Reset by engine().
let existing: RegExp | null = null
// What the hub answers to /show. Reset by engine().
let showBody: Record<string, unknown> | null = null

// Stands for the engine and the hub: records each hub request and each submitted prompt.
function engine(on: On, inbox: Array<() => Promise<{ status: number; body: unknown }>> = [], after = { status: 410, body: {} as unknown }, envKey?: string, health?: Record<string, unknown>) {
  const launches: unknown[] = []
  const completes: unknown[] = []
  const statuses: unknown[] = []
  const calls: Call[] = []
  const sent: string[] = []
  const stored: unknown[] = []
  let polls = 0

  on('command.register', (_, e) => ({ value: { command: e.name } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.cwd', () => ({ value: '/repos/api' }))
  on('session.id', () => ({ value: 'claude-session-1' }))
  on('env.get', (_, e) => ({ value: e.name === 'ELEVENLABS_API_KEY' ? envKey : e.name === 'LUKE_VOICE_PORT' ? envPort : undefined }))
  on('store.set', (_, e) => (stored.push(e.value), { value: undefined }))
  // What the store holds: set by the test before engine(), nothing otherwise.
  const get = storeGet
  storeGet = () => undefined
  on('store.get', (_, e) => ({ value: get(e) }))
  const marker = firstCall
  firstCall = null
  const found = existing
  existing = null
  const launch = { stdout: launchStdout, throws: launchThrows }
  launchStdout = '{"ok":true,"serviceToken":"svc"}\n'
  launchThrows = null
  const show = showBody
  showBody = null
  on('fs.exists', (_, e) => ({ value: (marker !== null && /[\\/]first-call$/.test(String(e.path))) || (found !== null && found.test(String(e.path))) }))
  on('fs.write', (_, e) => (markerWrites.push({ path: String(e.path), text: String(e.text) }), { value: undefined }))
  on('ui.close', () => ({ value: undefined }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('model.complete', (_, e) => {
    completes.push(e)
    if (brainThrows) {
      clockNow += brainThrowsAfterMs
      throw new Error(brainThrows)
    }
    return { value: brainComplete }
  })
  on('process.run', (_, e) => {
    launches.push(e)
    if (launch.throws && e.argv[0] !== 'claude') return { deny: launch.throws }
    return { value: { exitCode: 0, stdout: e.argv[0] === 'claude' ? brainStdout : String(e.argv[1]).endsWith('setup.mjs') ? setupStdout : launch.stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('ui.status', (_, e) => (statuses.push(e.text), { value: undefined }))
  on('ui.toast', () => ({ value: undefined }))
  on('clock.sleep', () => ({ value: undefined }))
  on('clock.now', () => ({ value: clockNow }))
  on('clock.every', () => ({ value: undefined }))
  on('prompt.submit', (_, e) => (sent.push(e.text), { text: e.text }))
  on('http.fetch', async (_, e) => {
    const url = new URL(e.url)
    const raw = e.init?.body
    calls.push({ method: e.init?.method ?? 'GET', path: url.pathname, port: url.port, body: typeof raw === 'string' ? JSON.parse(raw) : {} })
    let status = 200
    let body: unknown = { ok: true }
    if (url.pathname === '/subscribe') body = { token: 'session-1', name: 'api', hasKey: true }
    if (url.pathname === '/health' && health) body = health
    if (url.pathname === '/setup') body = { started: true }
    if (url.pathname === '/show' && show) body = show
    if (url.pathname === '/inbox') {
      const answer = inbox[polls++]
      ;({ status, body } = answer ? await answer() : after)
    }
    return { value: { status, ok: status < 400, headers: {}, text: JSON.stringify(body) } }
  })

  return { calls, sent, stored, launches, statuses, completes }
}

// The hooks answer in promise turns: yield until the check holds.
async function until(check: () => boolean) {
  for (let i = 0; i < 20_000 && !check(); i++) await Promise.resolve()
}

test('it starts off and the footer button shows it', async ($, on) => {
  engine(on)
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>engine</Text>
  })

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...FOOTER, surface })
    expect((await ui.find({ type: 'Text', text: /engine/ }))?.text).toBe('engine')
    const button = await ui.find({ type: 'Button', key: 'luke-voice-toggle' })
    expect(button?.props.label).toBe('✦ luke-voice: off')
    await ui.unmount()
  }
})

test('while off, nothing about the session is sent', async ($, on) => {
  const { calls } = engine(on)

  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.prompt.submit({ text: 'fix the login bug', origin: { kind: 'composer' } } as Args<'prompt.submit'>)

  expect(calls).toEqual([])
})

test('turning it on is stored, subscribes, and turning it off leaves the hub', async ($, on) => {
  const { calls, stored } = engine(on)

  await $.command.run(run(''))
  await until(() => calls.some(c => c.path === '/subscribe'))
  await $.command.run(run(''))

  expect(stored).toEqual([true, false])
  expect(calls.find(c => c.path === '/subscribe')?.body.cwd).toBe('/repos/api')
  expect(calls.some(c => c.path === '/unsubscribe')).toBe(true)
})

test('a prompt sent from the call starts a turn, framed as relayed, and is acked', async ($, on) => {
  let release: () => void = () => undefined
  const held = new Promise<void>(resolve => (release = resolve))
  const { calls, sent } = engine(on, [
    async () => ({ status: 200, body: { commands: [{ id: 'c1', type: 'send', prompt: 'add tests for auth', when: 'now' }] } }),
    async () => (await held, { status: 410, body: {} }),
  ])

  await $.command.run(run('on'))
  await until(() => calls.some(c => c.path === '/ack'))
  await $.command.run(run('off'))
  release()

  expect(sent).toEqual(['The user asked luke-voice, their voice assistant, to pass this on:\n\nadd tests for auth'])
  expect(calls.find(c => c.path === '/ack')?.body).toEqual({ id: 'c1', ok: true, message: 'Claude started a new turn with it.' })
})

test('a stored on reconnects at session start', async ($, on) => {
  storeGet = () => true
  const { calls } = engine(on)

  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await until(() => calls.some(c => c.path === '/subscribe'))
  await $.command.run(run('off'))

  expect(calls.some(c => c.path === '/subscribe')).toBe(true)
})

test('turning it on starts the call; a stored on at session start only connects', async ($, on) => {
  const { calls } = engine(on)

  await $.command.run(run(''))
  await until(() => calls.some(c => c.path === '/show'))
  await $.command.run(run('off'))

  expect(calls.find(c => c.path === '/subscribe')?.body.sessionId).toBe('claude-session-1')
  expect(calls.find(c => c.path === '/show')?.body).toEqual({ call: true })
})

test('a stored on at session start does not start a call', async ($, on) => {
  storeGet = () => true
  const { calls } = engine(on)

  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await until(() => calls.some(c => c.path === '/subscribe'))
  await until(() => false)
  await $.command.run(run('off'))

  expect(calls.some(c => c.path === '/show')).toBe(false)
})

test('a poll answered 409 (a reload took over) ends the loop without subscribing again', async ($, on) => {
  const { calls } = engine(on, [async () => ({ status: 409, body: { error: 'replaced' } })], { status: 200, body: { commands: [] } })

  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.command.run(run('window'))
  await until(() => calls.filter(c => c.path === '/inbox').length >= 1)
  await until(() => false)

  expect(calls.filter(c => c.path === '/subscribe').length).toBe(1)
  expect(calls.filter(c => c.path === '/inbox').length).toBe(1)
})

test('a voice task runs in a Claude Code subagent, and its answer is reported as task_done', async ($, on) => {
  const spawned: string[] = []
  on('agent.spawn', (_, e) => (spawned.push(e.prompt), { model: 'test', agentId: 'agent-7' }))
  on('turn.complete', (_, e) => ({ text: e.answer }))
  on('turn.start', (_, e) => ({ turnId: e.turnId }))
  let release: () => void = () => undefined
  const held = new Promise<void>(resolve => (release = resolve))
  const { calls } = engine(on, [
    async () => ({ status: 200, body: { commands: [{ id: 't1', type: 'task', task: 'verifica o login no repo xpto' }] } }),
    async () => (await held, { status: 410, body: {} }),
  ])

  await $.command.run(run('on'))
  await until(() => calls.some(c => c.path === '/ack'))
  // The engine names the subagent when its loop starts.
  await $.turn.start({ text: spawned[0] ?? '', turnId: 'x', agentId: 'agent-7' })
  await $.turn.complete({ answer: 'Achei o login em auth.ts.', durationMs: 1, isAborted: false, turnId: 'x', agentId: 'agent-7', reason: 'answer' })
  await until(() => calls.some(c => c.path === '/events' && JSON.stringify(c.body).includes('task_done')))
  await $.turn.complete({ answer: 'other', durationMs: 1, isAborted: false, turnId: 'y', agentId: 'agent-unknown', reason: 'answer' })
  await $.command.run(run('off'))
  release()

  expect(spawned[0]).toContain('verifica o login no repo xpto')
  expect(calls.find(c => c.path === '/ack')?.body).toEqual({ id: 't1', ok: true, message: 'Started. A Claude Code subagent is working on it; the result comes in a [news] update.' })
  const events = calls.filter(c => c.path === '/events').map(c => JSON.stringify(c.body))
  expect(events.filter(e => e.includes('task_done')).length).toBe(1)
  expect(events.find(e => e.includes('task_done'))).toContain('Achei o login em auth.ts.')
})

test('"pare" with no main turn running stops the voice tasks, which run as subagents', async ($, on) => {
  const spawned: string[] = []
  const stops: Array<{ tool: string; input: Record<string, unknown> }> = []
  on('agent.spawn', (_, e) => (spawned.push(e.prompt), { model: 'test', agentId: 'agent-9' }))
  on('agent.call', (_, e) => (stops.push({ tool: e.tool, input: e.input }), { value: { result: 'stopped', text: 'stopped' } }))
  on('turn.start', (_, e) => ({ turnId: e.turnId }))
  let go: () => void = () => undefined
  const stopNow = new Promise<void>(resolve => (go = resolve))
  let release: () => void = () => undefined
  const held = new Promise<void>(resolve => (release = resolve))
  const { calls } = engine(on, [
    async () => ({ status: 200, body: { commands: [{ id: 't9', type: 'task', task: 'analisa o repo inteiro' }] } }),
    async () => (await stopNow, { status: 200, body: { commands: [{ id: 's9', type: 'stop' }] } }),
    async () => (await held, { status: 410, body: {} }),
  ])

  await $.command.run(run('on'))
  await until(() => calls.some(c => c.path === '/ack'))
  await $.turn.start({ text: spawned[0] ?? '', turnId: 'x', agentId: 'agent-9' })
  go()
  await until(() => calls.filter(c => c.path === '/ack').length === 2)
  await $.command.run(run('off'))
  release()

  expect(stops).toEqual([{ tool: 'TaskStop', input: { task_id: 'agent-9' } }])
  expect(calls.filter(c => c.path === '/ack')[1]?.body).toEqual({ id: 's9', ok: true, message: 'Stopped 1 voice task.' })
})

test('"pare" with nothing running says Claude is not working', async ($, on) => {
  const stops: unknown[] = []
  on('agent.call', (_, e) => (stops.push(e), { value: { result: 'stopped', text: 'stopped' } }))
  let release: () => void = () => undefined
  const held = new Promise<void>(resolve => (release = resolve))
  const { calls } = engine(on, [
    async () => ({ status: 200, body: { commands: [{ id: 's0', type: 'stop' }] } }),
    async () => (await held, { status: 410, body: {} }),
  ])

  await $.command.run(run('on'))
  await until(() => calls.some(c => c.path === '/ack'))
  await $.command.run(run('off'))
  release()

  expect(stops).toEqual([])
  expect(calls.find(c => c.path === '/ack')?.body).toEqual({ id: 's0', ok: false, message: 'Claude is not working right now.' })
})

test('a refused subagent spawn acks the task as failed', async ($, on) => {
  on('agent.spawn', () => ({ deny: 'agent limit' }))
  let release: () => void = () => undefined
  const held = new Promise<void>(resolve => (release = resolve))
  const { calls } = engine(on, [
    async () => ({ status: 200, body: { commands: [{ id: 't2', type: 'task', task: 'roda os testes' }] } }),
    async () => (await held, { status: 410, body: {} }),
  ])

  await $.command.run(run('on'))
  await until(() => calls.some(c => c.path === '/ack'))
  await $.command.run(run('off'))
  release()

  const ack = calls.find(c => c.path === '/ack')?.body
  expect(ack?.ok).toBe(false)
  expect(String(ack?.message)).toContain('agent limit')
})

test('a voice task is sorted by complexity into its model and effort', async () => {
  expect(classifyTask('Refatore a arquitetura do orquestrador em vários arquivos')).toBe('complex')
  expect(classifyTask('Investigue por que o login falha às vezes')).toBe('complex')
  expect(classifyTask('Corrija o bug do botão de salvar no formulário')).toBe('medium')
  expect(classifyTask('Adicione um teste para a função de login')).toBe('medium')
  expect(classifyTask('Qual é a versão do plugin?')).toBe('simple')
  expect(classifyTask('Liste os arquivos da pasta hub')).toBe('simple')
  expect(classifyTask('x'.repeat(700))).toBe('complex')
  expect(TIERS.complex).toEqual({ model: 'opus', effort: 'high' })
  expect(TIERS.medium).toEqual({ model: 'sonnet', effort: 'medium' })
  expect(TIERS.simple).toEqual({ model: 'haiku', effort: 'low' })
})

test('a voice task subagent runs on its tier model, and each of its steps asks for its tier effort', async ($, on) => {
  const models: Array<string | undefined> = []
  const prompts: string[] = []
  const efforts: Array<string | number | undefined> = []
  on('agent.spawn', (_, e) => (models.push(e.model), prompts.push(e.prompt), { model: e.model ?? 'test', agentId: 'agent-h' }))
  on('turn.start', (_, e) => ({ turnId: e.turnId }))
  on('turn.step', async function* (_, e) {
    efforts.push(e.effort)
    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'end_turn', usage: null }
  })
  let release: () => void = () => undefined
  const held = new Promise<void>(resolve => (release = resolve))
  const { calls } = engine(on, [
    async () => ({ status: 200, body: { commands: [{ id: 't3', type: 'task', task: 'Liste os arquivos da pasta hub' }] } }),
    async () => (await held, { status: 410, body: {} }),
  ])

  await $.command.run(run('on'))
  await until(() => calls.some(c => c.path === '/ack'))
  // The engine names the subagent when its loop starts.
  await $.turn.start({ text: prompts[0] ?? '', turnId: 'x', agentId: 'agent-h' })
  // Reading each stream to its end sends the step.
  for (const step of [
    $.turn.step({ turnId: 'x', index: 0, model: 'haiku', effort: 'high', messageCount: 1, agentId: 'agent-h' }),
    $.turn.step({ turnId: 'm', index: 0, model: 'opus', effort: 'high', messageCount: 1 }),
  ]) {
    for await (const _ of step);
  }
  await $.command.run(run('off'))
  release()

  expect(models).toEqual(['haiku'])
  expect(efforts).toEqual(['low', 'high'])
})

test('the launcher gets the API key on stdin, so a hub it starts has it from the first call', async ($, on) => {
  const { calls, launches } = engine(on, [], { status: 410, body: {} }, 'key-from-env')

  await $.command.run(run('on'))
  await until(() => calls.some(c => c.path === '/subscribe'))
  await $.command.run(run('off'))

  expect(JSON.stringify(launches[0])).toContain('key-from-env')
  expect(JSON.stringify(launches[0])).not.toContain('"argv":["node","key')
})

const PANE = { plugin: 'luke-voice', component: 'Pane', requestId: 'luke-voice', props: { title: 'luke-voice', isFocused: false, bodyColumns: 60, placement: 'dock', scroll: { offset: 0, bodyRows: 30 }, view: {} } } as const

test('a running task shows in "Agora" and moves to "Histórico" with its answer when it finishes', async ($, on) => {
  const spawned: string[] = []
  on('turn.start', (_, e) => ({ turnId: e.turnId }))
  on('turn.complete', (_, e) => ({ text: e.answer }))
  on('agent.spawn', (_, e) => (spawned.push(e.prompt), { model: 'test' }))
  let release: () => void = () => undefined
  const held = new Promise<void>(resolve => (release = resolve))
  const { calls } = engine(on, [
    async () => ({ status: 200, body: { commands: [{ id: 'p1', type: 'task', task: 'procura o botão de ligar' }] } }),
    async () => (await held, { status: 410, body: {} }),
  ])

  await $.command.run(run('on'))
  await until(() => calls.some(c => c.path === '/ack'))
  await $.turn.start({ text: spawned[0] ?? '', turnId: 'x', agentId: 'agent-p' })

  let ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /procura o botão de ligar/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: '▶' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /Nada em andamento/ })).toBeUndefined()
  await ui.unmount()

  await $.turn.complete({ answer: 'Fica no **rodapé** do mod.', durationMs: 1, isAborted: false, turnId: 'x', agentId: 'agent-p', reason: 'answer' })
  ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /Nada em andamento/ })).toBeDefined()
  // The answer starts collapsed: its first line, without Markdown marks.
  expect(await ui.find({ type: 'Text', text: /Fica no rodapé do mod\./ })).toBeDefined()
  await ui.unmount()

  await $.command.run(run('off'))
  release()
})

test('pane rows start collapsed to one line and open to their full text', async ($, on) => {
  const spawned: string[] = []
  on('turn.start', (_, e) => ({ turnId: e.turnId }))
  on('turn.complete', (_, e) => ({ text: e.answer }))
  on('agent.spawn', (_, e) => (spawned.push(e.prompt), { model: 'test' }))
  let release: () => void = () => undefined
  const held = new Promise<void>(resolve => (release = resolve))
  const { calls } = engine(on, [
    async () => ({ status: 200, body: { commands: [{ id: 'p2', type: 'task', task: 'lista os repositórios' }] } }),
    async () => (await held, { status: 410, body: {} }),
  ])
  const answer = `**Sete** repositórios.

- prompt-master
- luke-voice

${'linha longa '.repeat(200)}fim-da-resposta`

  await $.command.run(run('on'))
  await until(() => calls.some(c => c.path === '/ack'))
  await $.turn.start({ text: spawned[0] ?? '', turnId: 'y', agentId: 'agent-q' })
  await $.turn.complete({ answer, durationMs: 1, isAborted: false, turnId: 'y', agentId: 'agent-q', reason: 'answer' })

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  // Collapsed: a one-line preview with the Markdown marks dropped, no full body.
  expect(await ui.find({ type: 'Markdown' })).toBeUndefined()
  expect((await ui.find({ type: 'Text', text: /Sete repositórios\./ }))?.text).toContain('Sete repositórios.')

  const rows = (await ui.findAll({ type: 'Button' })).filter(b => String(b.props.key ?? '').startsWith('row-h:'))
  expect(rows.length).toBe(2)
  const resultRow = rows[0]!
  await ui.press({ key: String(resultRow.props.key) })
  // Opened: the whole answer, formatted, nothing cut.
  const body = await ui.find({ type: 'Markdown' })
  expect(String(body?.props.text)).toContain('fim-da-resposta')
  expect(String(body?.props.text)).toContain('- luke-voice')

  await ui.press({ key: String(resultRow.props.key) })
  expect(await ui.find({ type: 'Markdown' })).toBeUndefined()

  await ui.press({ key: 'expand-all' })
  expect(await ui.find({ type: 'Markdown' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^lista os repositórios$/ })).toBeDefined()
  await ui.press({ key: 'collapse-all' })
  expect(await ui.find({ type: 'Markdown' })).toBeUndefined()
  await ui.unmount()

  await $.command.run(run('off'))
  release()
})

test('preview keeps the first line of a Markdown text, without its marks', () => {
  expect(preview('\n## **Achei** o `bug`\nsegunda linha')).toBe('Achei o bug')
  expect(preview('- item um\n- item dois')).toBe('item um')
})

test('a stopped task is not reported; its later, finished run is reported once', async ($, on) => {
  const spawned: string[] = []
  on('agent.spawn', (_, e) => (spawned.push(e.prompt), { model: 'test' }))
  on('turn.start', (_, e) => ({ turnId: e.turnId }))
  on('turn.complete', (_, e) => ({ text: e.answer }))
  let release: () => void = () => undefined
  const held = new Promise<void>(resolve => (release = resolve))
  const { calls } = engine(on, [
    async () => ({ status: 200, body: { commands: [{ id: 's1', type: 'task', task: 'analisa o repo' }] } }),
    async () => (await held, { status: 410, body: {} }),
  ])

  await $.command.run(run('on'))
  await until(() => calls.some(c => c.path === '/ack'))
  await $.turn.start({ text: spawned[0] ?? '', turnId: 'a', agentId: 'agent-s' })
  await $.turn.complete({ answer: '', durationMs: 1, isAborted: true, turnId: 'a', agentId: 'agent-s', reason: 'aborted' })
  await $.turn.start({ text: 'continua', turnId: 'b', agentId: 'agent-s' })
  await $.turn.complete({ answer: 'Achei dois pontos.', durationMs: 1, isAborted: false, turnId: 'b', agentId: 'agent-s', reason: 'answer' })
  await until(() => calls.some(c => c.path === '/events' && JSON.stringify(c.body).includes('task_done')))
  await $.command.run(run('off'))
  release()

  const done = calls.filter(c => c.path === '/events').map(c => JSON.stringify(c.body)).filter(b => b.includes('task_done'))
  expect(done.length).toBe(1)
  expect(done[0]).toContain('Achei dois pontos.')
})

test('the first Claude Code opened after installing turns luke-voice on and starts the call, once', async ($, on) => {
  firstCall = 'pending'
  markerWrites.length = 0
  const { calls, stored } = engine(on)
  on('fs.read', (_, e) => ({ value: /[\\/]first-call$/.test(String(e.path)) ? 'pending\n' : '{"version":"0.9.7"}' }))

  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await until(() => calls.some(c => c.path === '/show'))

  expect(stored).toContain(true)
  expect(calls.find(c => c.path === '/show')?.body.call).toBe(true)
  expect(markerWrites).toEqual([{ path: expect.stringMatching(/\.luke-voice[\\/]first-call$/), text: 'done' }])
  await $.command.run(run('off'))
})

test('a hub that does not start leaves the first call for the next Claude Code opened', async ($, on) => {
  firstCall = 'pending'
  markerWrites.length = 0
  launchStdout = '{"ok":false,"error":"o servidor local não iniciou"}\n'
  const { launches } = engine(on)
  on('fs.read', (_, e) => ({ value: /[\\/]first-call$/.test(String(e.path)) ? 'pending\n' : '{"version":"0.10.2"}' }))

  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await until(() => launches.length > 0)
  for (let i = 0; i < 2000; i++) await Promise.resolve()

  expect(markerWrites).toEqual([])
  await $.command.run(run('off'))
})

test('without Node.js on the PATH, the mod says so in Portuguese instead of a bare ENOENT', async ($, on) => {
  launchThrows = 'spawn node ENOENT'
  engine(on)
  on('fs.read', () => ({ value: '{"version":"0.10.2"}' }))

  const text = (await $.command.run(run('call'))).text

  expect(text).toBe(NO_NODE)
  expect(text).not.toContain('ENOENT')
  await $.command.run(run('off'))
  // /luke-voice setup, which runs hub/setup.mjs here, says the same.
  expect((await $.command.run(run('setup'))).text).toBe(NO_NODE)
})

test("the installer's own Node.js on Windows (node.exe) is found too", async ($, on) => {
  existing = /[\\/]\.luke-voice[\\/]node[\\/]node\.exe$/
  const { launches, calls } = engine(on)

  await $.command.run(run(''))
  await until(() => calls.some(c => c.path === '/subscribe'))

  expect(String(launches[0] && (launches[0] as { argv: string[] }).argv[0])).toMatch(/\.luke-voice[\\/]node[\\/]node\.exe$/)
  await $.command.run(run(''))
})

test("the installer's own Node.js runs the hub when it is there, so a Claude Code opened from the Dock finds it", async ($, on) => {
  existing = /[\\/]\.luke-voice[\\/]node[\\/]bin[\\/]node$/
  const { launches, calls } = engine(on)

  await $.command.run(run(''))
  await until(() => calls.some(c => c.path === '/subscribe'))

  expect(String(launches[0] && (launches[0] as { argv: string[] }).argv[0])).toMatch(/\.luke-voice[\\/]node[\\/]bin[\\/]node$/)
  await $.command.run(run(''))
})

test('the Node.js on the PATH runs the hub when the installer brought none', async ($, on) => {
  const { launches, calls } = engine(on)

  await $.command.run(run(''))
  await until(() => calls.some(c => c.path === '/subscribe'))

  expect((launches[0] as { argv: string[] }).argv[0]).toBe('node')
  await $.command.run(run(''))
})

test('when no browser could open the call window, the mod gives the address instead of "opening"', async ($, on) => {
  showBody = { ok: true, isWindowOpen: false, isOpened: false, url: 'http://127.0.0.1:4848/?n=abc&call=1' }
  engine(on)

  const text = (await $.command.run(run('call'))).text

  expect(text).toContain('Não consegui abrir a janela da chamada')
  expect(text).toContain('http://127.0.0.1:4848/?n=abc&call=1')
  expect(text).not.toContain('está abrindo')
  await $.command.run(run('off'))
})

test('the call and its toggles answer in Portuguese', async ($, on) => {
  engine(on)

  const call = (await $.command.run(run('call'))).text
  expect(call).toContain('Chamando a Ceci na sessão "api"')
  expect(call).toContain('A janela da chamada está abrindo.')
  expect((await $.command.run(run('end'))).text).toBe('Chamada encerrada.')
  expect((await $.command.run(run('off'))).text).toBe('luke-voice: desligado')
  expect((await $.command.run(run('status'))).text).toContain('Nada desta sessão sai do seu computador')
})

test('a claude -p run never takes the first call, and with no marker nothing starts', async ($, on) => {
  firstCall = 'pending'
  markerWrites.length = 0
  const { calls } = engine(on)
  on('fs.read', () => ({ value: 'pending' }))

  await $.session.start({ cwd: '/', surface: null, isInteractive: false })
  for (let i = 0; i < 2000; i++) await Promise.resolve()

  expect(calls.some(c => c.path === '/show' || c.path === '/subscribe')).toBe(false)
  expect(markerWrites).toEqual([])
})

test('subscribe says which luke-voice this session runs, so the hub never asks an older one to think', async ($, on) => {
  const { calls } = engine(on)
  on('fs.read', () => ({ value: '{"version":"0.9.6"}' }))

  await $.command.run(run(''))
  await until(() => calls.some(c => c.path === '/subscribe'))

  expect(calls.find(c => c.path === '/subscribe')?.body.version).toBe('0.9.6')
  await $.command.run(run(''))
})

test('/luke-voice help says what is missing and teaches every step, in Portuguese', async ($, on) => {
  engine(on)
  on('fs.read', () => ({ value: '{"version":"9.9.9"}' }))

  const help = (await $.command.run(run('help'))).text

  expect(help).toContain('✗ luke-voice ligado')
  expect(help).toContain('/plugin configure luke-voice@luke-voice')
  expect(help).toContain('feche o Claude Code e abra de novo')
  expect(help).toContain('/luke-voice help')
  expect(help).toContain('Se algo não funcionar')
  expect((await $.command.run(run('ajuda'))).text).toBe(help)
})

test('a running hub of another version is called out in help', async ($, on) => {
  engine(on, [], undefined, undefined, { app: 'luke-voice', version: '0.4.2', hasKey: true })
  on('fs.read', () => ({ value: '{"version":"0.7.0"}' }))

  const help = (await $.command.run(run('help'))).text

  expect(help).toContain('O hub é da versão 0.4.2, mas a instalada é 0.7.0')
  expect(help).toContain('✓ Chave da ElevenLabs configurada')
})

test('an unknown argument points to help instead of a bare usage line', async ($, on) => {
  engine(on)
  expect((await $.command.run(run('xyz'))).text).toContain('/luke-voice help')
})

test('the status line under the prompt shows only when something needs attention', async ($, on) => {
  const { statuses: shown, calls } = engine(on, [], { status: 200, body: { commands: [] } })

  await $.command.run(run('on'))
  await until(() => calls.some(c => c.path === '/subscribe'))
  await until(() => false)
  await $.command.run(run('off'))

  expect(shown.length).toBeGreaterThan(0)

  // Connected and healthy: the line is cleared, never filled.
  expect(JSON.stringify(shown)).not.toContain('Claude is')
  expect(JSON.stringify(shown)).not.toContain('working')
})

test('only a permission prompt or a question for the user marks the session "Precisa de você"; an idle reminder does not', async ($, on) => {
  const { calls } = engine(on, [], { status: 200, body: { commands: [] } })
  on('classic.Notification', () => ({}))

  await $.command.run(run('on'))
  await until(() => calls.some(c => c.path === '/subscribe'))
  // After a finished turn, Claude Code reminds the user it is waiting: nothing needs them.
  await $.classic.Notification({ message: 'Claude is waiting for your input', notification_type: 'idle_prompt' })
  await $.classic.Notification({ message: 'luke-voice: chamada encerrada', notification_type: 'plugin_notification' })
  await $.classic.Notification({ message: 'Claude needs your permission to use Bash', notification_type: 'permission_prompt' })
  await $.classic.Notification({ message: 'The MCP server asks for your answer', notification_type: 'elicitation_dialog' })
  await until(() => calls.some(c => c.path === '/events' && JSON.stringify(c.body).includes('MCP server')))
  await $.command.run(run('off'))

  const attention = calls.filter(c => c.path === '/events').map(c => JSON.stringify(c.body)).filter(b => b.includes('"attention"'))
  expect(attention.length).toBe(2)
  expect(attention[0]).toContain('needs your permission')
  expect(attention[1]).toContain('MCP server')
})

const REQUEST: BrainRequest = {
  kind: 'user',
  text: 'verifica os testes de login',
  context: ['[news]\n<<<untrusted>>>\ntask done: ok\n<<</untrusted>>>'],
  turns: [{ role: 'user', text: 'oi' }, { role: 'luke', text: 'Oi! Em que posso ajudar?' }],
  sessions: [{ name: 'api', isBusy: true }, { name: 'site', isBusy: false }],
  focused: 'api',
}

test('the fallback brain call is one lean Claude Sonnet 5.5 run at medium effort: no tools, MCP servers, settings or saved session', () => {
  const argv = brainArgs('/plugin')
  expect(argv.slice(0, 2)).toEqual(['claude', '-p'])
  expect(argv[argv.indexOf('--model') + 1]).toBe('claude-sonnet-5-5')
  expect(argv[argv.indexOf('--effort') + 1]).toBe('medium')
  expect(argv).toContain('--strict-mcp-config')
  expect(argv).toContain('--no-session-persistence')
  expect(argv[argv.indexOf('--tools') + 1]).toBe('')
  expect(argv[argv.indexOf('--setting-sources') + 1]).toBe('')
  expect(argv[argv.indexOf('--system-prompt-file') + 1]).toBe('/plugin/agent/brain-prompt.md')
})

test("Luke's fallback brain call passes his prompt as text; Ceci's still reads the file", () => {
  const argv = brainArgs('/plugin', 'Você é o Luke.')
  expect(argv[argv.indexOf('--system-prompt') + 1]).toBe('Você é o Luke.')
  expect(argv).not.toContain('--system-prompt-file')
  expect(brainArgs('/plugin')).not.toContain('--system-prompt')
})

test("asPersona turns Ceci's words into Luke's, in order, and leaves Ceci's as they are", () => {
  const personas = { ceci: { name: 'Ceci', gender: 'female' }, luke: { name: 'Luke', gender: 'male', replace: [['Eu sou a Ceci!', 'Eu sou o Luke!'], ['a Ceci', 'o Luke'], ['Ceci', 'Luke']] as Array<[string, string]> } }
  expect(asPersona('Eu sou a Ceci! Fale com a Ceci. Ceci.', 'luke', personas)).toBe('Eu sou o Luke! Fale com o Luke. Luke.')
  expect(asPersona('Eu sou a Ceci!', 'ceci', personas)).toBe('Eu sou a Ceci!')
  expect(asPersona('Eu sou a Ceci!', undefined, personas)).toBe('Eu sou a Ceci!')
})

test('the brain reads the sessions, the quoted context, the conversation and what the user just said', () => {
  const input = brainInput(REQUEST)
  expect(input).toContain('[sessões] api (ocupada, em foco), site (livre)')
  expect(input).toContain('<<<untrusted>>>')
  expect(input).toContain('ceci: Oi! Em que posso ajudar?')
  expect(input.split('\n').pop()).toBe('[agora] usuário disse: verifica os testes de login')
  expect(brainInput({ ...REQUEST, kind: 'notice', text: 'conte' }).split('\n').pop()).toBe('[agora] aviso automático: conte')
})

test('a brain reply in a code fence is read, an unknown tool is dropped, and plain words are only said', () => {
  const envelope = (result: string) => JSON.stringify({ type: 'result', is_error: false, result })
  expect(parseBrain(envelope('```json\n{"say":"Comecei.","tool":{"name":"luke_run_task","args":{"task":"x"}}}\n```'))).toEqual({
    say: 'Comecei.',
    tool: { name: 'luke_run_task', args: { task: 'x' } },
    pending: null,
  })
  expect(parseBrain(envelope('{"say":"Ok.","tool":{"name":"rm_rf","args":{}}}'))).toEqual({ say: 'Ok.', tool: null, pending: null })
  expect(parseBrain(envelope('Oi, tudo bem?'))).toEqual({ say: 'Oi, tudo bem?', tool: null, pending: null })
  expect(() => parseBrain(JSON.stringify({ is_error: true, result: 'rate limited' }))).toThrow('rate limited')
})

test('a pending action is kept only for a tool that acts, and never next to a tool that runs now', () => {
  const ask = '{"say":"Posso?","tool":null,"pending":{"name":"luke_run_task","args":{"task":"rodar testes"}}}'
  expect(parseBrainText(ask).pending).toEqual({ name: 'luke_run_task', args: { task: 'rodar testes' } })
  expect(parseBrainText('{"say":"Posso?","pending":{"name":"luke_stop_claude","args":{}}}').pending).toBeNull()
  expect(parseBrainText('{"say":"Posso?","pending":{"name":"rm_rf"}}').pending).toBeNull()
  const both = parseBrainText('{"say":"Comecei.","tool":{"name":"luke_run_task","args":{"task":"a"}},"pending":{"name":"luke_run_task","args":{"task":"b"}}}')
  expect(both.tool?.args).toEqual({ task: 'a' })
  expect(both.pending).toBeNull()
})

test('a think command runs the brain as one direct Sonnet call at medium effort, with the prompt cached, and acks its reply', async ($, on) => {
  brainComplete = { isAnswered: true, text: '{"say":"Posso verificar os testes de login?","tool":null,"pending":{"name":"luke_run_task","args":{"task":"verificar os testes de login"}}}' }
  let release: () => void = () => undefined
  const held = new Promise<void>(resolve => (release = resolve))
  on('fs.read', () => ({ value: 'BRAIN PROMPT' }))
  const { calls, launches, completes } = engine(on, [
    async () => ({ status: 200, body: { commands: [{ id: 'b1', type: 'think', request: REQUEST }] } }),
    async () => (await held, { status: 410, body: {} }),
  ])

  await $.command.run(run('on'))
  await until(() => calls.some(c => c.path === '/ack'))
  await $.command.run(run('off'))
  release()

  // No `claude -p` process: the engine's model call.
  expect(launches.some(l => (l as { argv: string[] }).argv[0] === 'claude')).toBe(false)
  const sent = completes[0] as { model: string; effort: string; prompt: string; systemBlocks?: Array<{ text: string; cache?: boolean }> }
  expect(sent.model).toBe('claude-sonnet-5-5')
  expect(sent.effort).toBe('medium')
  expect(sent.prompt).toContain('[agora] usuário disse: verifica os testes de login')
  expect(sent.systemBlocks?.[0]?.cache).toBe(true)
  const ack = calls.find(c => c.path === '/ack')?.body
  expect(ack?.ok).toBe(true)
  expect(JSON.parse(String(ack?.message))).toEqual({
    say: 'Posso verificar os testes de login?',
    tool: null,
    pending: { name: 'luke_run_task', args: { task: 'verificar os testes de login' } },
  })
})

test("a think command for Luke sends Luke's prompt, made from Ceci's with agent/persona.json", async ($, on) => {
  brainComplete = { isAnswered: true, text: '{"say":"Oi!","tool":null}' }
  let release: () => void = () => undefined
  const held = new Promise<void>(resolve => (release = resolve))
  const personas = { ceci: { name: 'Ceci', gender: 'female' }, luke: { name: 'Luke', gender: 'male', replace: [['Você é a Ceci.', 'Você é o Luke.']] } }
  on('fs.read', (_, e) => ({ value: /persona\.json$/.test(String(e.path)) ? JSON.stringify(personas) : 'Você é a Ceci.' }))
  const { calls, completes } = engine(on, [
    async () => ({ status: 200, body: { commands: [{ id: 'l1', type: 'think', request: { ...REQUEST, persona: 'luke' } }] } }),
    async () => (await held, { status: 410, body: {} }),
  ])

  await $.command.run(run('on'))
  await until(() => calls.some(c => c.path === '/ack'))
  await $.command.run(run('off'))
  release()

  const sent = completes[0] as { systemBlocks?: Array<{ text: string }> }
  expect(sent.systemBlocks?.[0]?.text).toBe('Você é o Luke.')
})

test("a think command for Nara sends Nara's prompt", async ($, on) => {
  brainComplete = { isAnswered: true, text: '{"say":"Oi!","tool":null}' }
  let release: () => void = () => undefined
  const held = new Promise<void>(resolve => (release = resolve))
  const personas = { ceci: { name: 'Ceci', gender: 'female' }, nara: { name: 'Nara', gender: 'female', replace: [['Ceci', 'Nara']] } }
  on('fs.read', (_, e) => ({ value: /persona\.json$/.test(String(e.path)) ? JSON.stringify(personas) : 'Você é a Ceci.' }))
  const { calls, completes } = engine(on, [
    async () => ({ status: 200, body: { commands: [{ id: 'n1', type: 'think', request: { ...REQUEST, persona: 'nara' } }] } }),
    async () => (await held, { status: 410, body: {} }),
  ])

  await $.command.run(run('on'))
  await until(() => calls.some(c => c.path === '/ack'))
  await $.command.run(run('off'))
  release()

  const sent = completes[0] as { systemBlocks?: Array<{ text: string }> }
  expect(sent.systemBlocks?.[0]?.text).toBe('Você é a Nara.')
})

test('a brain that fails acks the think command as failed, with the reason', async ($, on) => {
  brainComplete = { isAnswered: false, reason: 'api-error', status: 529, error: 'overloaded' }
  let release: () => void = () => undefined
  const held = new Promise<void>(resolve => (release = resolve))
  on('fs.read', () => ({ value: 'BRAIN PROMPT' }))
  const { calls } = engine(on, [
    async () => ({ status: 200, body: { commands: [{ id: 'b2', type: 'think', request: REQUEST }] } }),
    async () => (await held, { status: 410, body: {} }),
  ])

  await $.command.run(run('on'))
  await until(() => calls.some(c => c.path === '/ack'))
  await $.command.run(run('off'))
  release()

  const ack = calls.find(c => c.path === '/ack')?.body
  expect(ack?.ok).toBe(false)
  expect(String(ack?.message)).toContain('api-error')
})

for (const [name, afterMs, isFallback] of [
  ['a direct model call the engine cannot make falls back to claude -p, in the time left', 0, true],
  ['a direct model call that timed out is not followed by a second, paid call past the hub wait', 36_000, false],
] as const) {
  test(name, async ($, on) => {
    brainThrows = 'model call failed'
    brainThrowsAfterMs = afterMs
    brainStdout = JSON.stringify({ result: '{"say":"Oi!","tool":null}' })
    let release: () => void = () => undefined
    const held = new Promise<void>(resolve => (release = resolve))
    on('fs.read', () => ({ value: 'BRAIN PROMPT' }))
    const { calls, launches } = engine(on, [
      async () => ({ status: 200, body: { commands: [{ id: 'b3', type: 'think', request: REQUEST }] } }),
      async () => (await held, { status: 410, body: {} }),
    ])

    await $.command.run(run('on'))
    await until(() => calls.some(c => c.path === '/ack'))
    await $.command.run(run('off'))
    release()
    brainThrows = null
    brainStdout = ''

    const fallback = launches.find(l => (l as { argv: string[] }).argv[0] === 'claude')
    const ack = calls.find(c => c.path === '/ack')?.body
    expect(Boolean(fallback)).toBe(isFallback)
    expect(ack?.ok).toBe(isFallback)
    // Nothing else took time here, so the fallback gets the whole budget under the hub's 40 s.
    if (fallback) expect(JSON.stringify(fallback)).toContain('"timeoutMs":38000')
    else expect(String(ack?.message)).toContain('did not answer in time')
  })
}

test('/luke-voice voz shows the voice the hub uses, and an unknown voice points to the two choices', async ($, on) => {
  engine(on, [], undefined, undefined, { app: 'luke-voice', version: '0.8.0', provider: 'local', hasKey: false })

  expect((await $.command.run(run('voz'))).text).toContain('Voz atual: gratuita (Ceci, no seu computador)')
  expect((await $.command.run(run('voz banana'))).text).toContain('/luke-voice voz local ou /luke-voice voz elevenlabs')
})

test('in help, the free voice needs no key, and ElevenLabs without a key is called out', async ($, on) => {
  engine(on, [], undefined, undefined, { app: 'luke-voice', version: '0.8.0', provider: 'local', hasKey: false })
  on('fs.read', () => ({ value: '{"version":"0.8.0"}' }))
  const free = (await $.command.run(run('help'))).text
  expect(free).toContain('✓ Voz: gratuita')
  expect(free).not.toContain('✗ Chave da ElevenLabs')
})

test('in help, the ElevenLabs voice without a key is called out', async ($, on) => {
  engine(on, [], undefined, undefined, { app: 'luke-voice', version: '0.8.0', provider: 'elevenlabs', hasKey: false })
  on('fs.read', () => ({ value: '{"version":"0.8.0"}' }))
  const paid = (await $.command.run(run('help'))).text
  expect(paid).toContain('✓ Voz: ElevenLabs')
  expect(paid).toContain('✗ Chave da ElevenLabs: falta')
})

// The tests below change module state (the stored voice, the hub port), so they run last.

test('/luke-voice voz elevenlabs stores the choice, tells the hub, and says the key is missing', async ($, on) => {
  let release: () => void = () => undefined
  const held = new Promise<void>(resolve => (release = resolve))
  const { calls, stored } = engine(on, [async () => (await held, { status: 410, body: {} })])

  await $.command.run(run('on'))
  await until(() => calls.some(c => c.path === '/subscribe'))
  const answer = (await $.command.run(run('voz elevenlabs'))).text
  await $.command.run(run('off'))
  release()

  expect(stored).toContain('elevenlabs')
  expect(calls.find(c => c.path === '/provider')?.body).toEqual({ provider: 'elevenlabs' })
  expect(answer).toContain('Voz trocada para ElevenLabs')
  expect(answer).toContain('Falta a chave da ElevenLabs')
})

test('the stored voice goes to the launcher on stdin and to the hub on subscribe', async ($, on) => {
  storeGet = e => (JSON.stringify(e).includes('voiceProvider') ? 'local' : true)
  const { calls, launches } = engine(on)

  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await until(() => calls.some(c => c.path === '/subscribe'))
  await $.command.run(run('off'))

  expect(JSON.stringify(launches[0])).toContain('\\"provider\\":\\"local\\"')
  expect(calls.find(c => c.path === '/subscribe')?.body.provider).toBe('local')
})

test('a voice changed in another session since this one started is the one sent on subscribe', async ($, on) => {
  let saved = 'local'
  storeGet = e => (JSON.stringify(e).includes('voiceProvider') ? saved : true)
  const { calls } = engine(on)

  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await until(() => calls.some(c => c.path === '/subscribe'))
  await $.command.run(run('off'))
  // Another Claude session runs /luke-voice voz elevenlabs; this one reconnects later.
  saved = 'elevenlabs'
  await $.command.run(run('on'))
  await until(() => calls.filter(c => c.path === '/subscribe').length === 2)
  await $.command.run(run('off'))

  expect(calls.filter(c => c.path === '/subscribe').map(c => c.body.provider)).toEqual(['local', 'elevenlabs'])
})

test('LUKE_VOICE_PORT moves the hub address the mod calls', async ($, on) => {
  envPort = '4861'
  storeGet = () => true
  const { calls } = engine(on)

  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await until(() => calls.some(c => c.path === '/subscribe'))
  await $.command.run(run('off'))
  envPort = undefined

  expect(calls.find(c => c.path === '/subscribe')?.port).toBe('4861')
})

test('in help, the free voice shows its profile: natural on the GPU, light, or downloading', async ($, on) => {
  engine(on, [], undefined, undefined, { app: 'luke-voice', version: '0.9.0', provider: 'local', hasKey: false, profile: 'gpu', native: { tts: true, asr: true, router: true }, download: null })
  on('fs.read', () => ({ value: '{"version":"0.9.0"}' }))
  const help = (await $.command.run(run('help'))).text
  expect(help).toContain('✓ Perfil: voz natural na placa de vídeo (tts, asr, router rodando)')
  expect(help).toContain('/luke-voice setup')
})

test('/luke-voice setup with luke-voice on asks the hub to prepare the voice in the background', async ($, on) => {
  let release: () => void = () => undefined
  const held = new Promise<void>(resolve => (release = resolve))
  // The inbox stays open, so the session keeps its token.
  const { calls } = engine(on, [async () => (await held, { status: 410, body: {} })])
  await $.command.run(run('on'))
  await until(() => calls.some(c => c.path === '/inbox'))
  const text = (await $.command.run(run('setup'))).text
  await $.command.run(run('off'))
  release()
  expect(calls.some(c => c.path === '/setup' && c.method === 'POST')).toBe(true)
  expect(text).toContain('Acompanhe com /luke-voice status')
})

test('/luke-voice setup with luke-voice off runs the setup here and says how it went', async ($, on) => {
  const { launches } = engine(on)
  setupStdout = 'Voice models: 100%\n{"ok":true,"profile":"gpu","reason":"RTX 3060 Ti, 8238 MiB","heard":"Oi, eu sou a Ceci.","problems":[]}\n'
  const text = (await $.command.run(run('setup'))).text
  expect(text).toContain('Voz natural pronta, na placa de vídeo (RTX 3060 Ti, 8238 MiB)')
  expect(text).toContain('a Ceci disse: "Oi, eu sou a Ceci."')
  const argv = (launches.at(-1) as { argv: string[] }).argv
  expect(String(argv[1]).endsWith('hub/setup.mjs')).toBe(true)
  expect(argv.slice(2)).toEqual(['--json'])
  setupStdout = '{"ok":true,"profile":"light","reason":"nenhuma placa de vídeo encontrada","problems":[]}\n'
  expect((await $.command.run(run('setup'))).text).toContain('Voz leve pronta, no navegador (nenhuma placa de vídeo encontrada)')
  setupStdout = '{"ok":false,"error":"Download failed (404)"}\n'
  expect((await $.command.run(run('setup'))).text).toContain('Não consegui preparar a voz: Download failed (404)')
  setupStdout = '{"ok":false,"error":"sem conexão com a internet (fetch failed)","help":"Confira a internet. Atrás de um proxy, defina HTTPS_PROXY."}\n'
  expect((await $.command.run(run('setup'))).text).toContain('Atrás de um proxy, defina HTTPS_PROXY.')
  setupStdout = '{"ok":false,"error":"Falta espaço: a voz precisa de 3,6 GB livres em /home/ana/.luke-voice/models; libere espaço e rode de novo.","help":""}\n'
  expect((await $.command.run(run('setup'))).text).toBe('Falta espaço: a voz precisa de 3,6 GB livres em /home/ana/.luke-voice/models; libere espaço e rode de novo.')
})
