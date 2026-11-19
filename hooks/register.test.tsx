import { expect, test } from 'claude-code/testing'
import type { Args, On } from 'claude-code'

const FOOTER = { plugin: 'luke-voice', component: 'SessionMode', props: { modes: [] } } as const
const run = (args: string) => ({ command: 'luke-voice', args, origin: { kind: 'composer' } }) as Args<'command.run'>

type Call = { method: string; path: string; body: Record<string, unknown> }

// Stands for the engine and the hub: records each hub request and each submitted prompt.
function engine(on: On, inbox: Array<() => Promise<{ status: number; body: unknown }>> = [], after = { status: 410, body: {} as unknown }, envKey?: string, health?: Record<string, unknown>) {
  const launches: unknown[] = []
  const calls: Call[] = []
  const sent: string[] = []
  const stored: unknown[] = []
  let polls = 0

  on('command.register', (_, e) => ({ value: { command: e.name } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.cwd', () => ({ value: '/repos/api' }))
  on('session.id', () => ({ value: 'claude-session-1' }))
  on('env.get', (_, e) => ({ value: e.name === 'ELEVENLABS_API_KEY' ? envKey : undefined }))
  on('store.set', (_, e) => (stored.push(e.value), { value: undefined }))
  on('ui.close', () => ({ value: undefined }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('process.run', (_, e) => (launches.push(e), { value: { exitCode: 0, stdout: '{"ok":true,"serviceToken":"svc"}\n', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }))
  on('ui.status', () => ({ value: undefined }))
  on('ui.toast', () => ({ value: undefined }))
  on('clock.sleep', () => ({ value: undefined }))
  on('clock.now', () => ({ value: 1_700_000_000_000 }))
  on('clock.every', () => ({ value: undefined }))
  on('prompt.submit', (_, e) => (sent.push(e.text), { text: e.text }))
  on('http.fetch', async (_, e) => {
    const url = new URL(e.url)
    const raw = e.init?.body
    calls.push({ method: e.init?.method ?? 'GET', path: url.pathname, body: typeof raw === 'string' ? JSON.parse(raw) : {} })
    let status = 200
    let body: unknown = { ok: true }
    if (url.pathname === '/subscribe') body = { token: 'session-1', name: 'api', hasKey: true }
    if (url.pathname === '/health' && health) body = health
    if (url.pathname === '/inbox') {
      const answer = inbox[polls++]
      ;({ status, body } = answer ? await answer() : after)
    }
    return { value: { status, ok: status < 400, headers: {}, text: JSON.stringify(body) } }
  })

  return { calls, sent, stored, launches }
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
  on('store.get', () => ({ value: true }))
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
  on('store.get', () => ({ value: true }))
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
  expect((await ui.find({ type: 'Text', text: /procura o botão de ligar/ }))?.text).toContain('▶')
  expect(await ui.find({ type: 'Text', text: /Nada em andamento/ })).toBeUndefined()
  await ui.unmount()

  await $.turn.complete({ answer: 'Fica no **rodapé** do mod.', durationMs: 1, isAborted: false, turnId: 'x', agentId: 'agent-p', reason: 'answer' })
  ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /Nada em andamento/ })).toBeDefined()
  expect(await ui.find({ type: 'Markdown' })).toBeDefined()
  await ui.unmount()

  await $.command.run(run('off'))
  release()
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
