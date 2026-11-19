import { expect, test } from 'claude-code/testing'
import type { Args, On } from 'claude-code'

const FOOTER = { plugin: 'luke-voice', component: 'SessionMode', props: { modes: [] } } as const
const run = (args: string) => ({ command: 'luke-voice', args, origin: { kind: 'composer' } }) as Args<'command.run'>

type Call = { method: string; path: string; body: Record<string, unknown> }

// Stands for the engine and the hub: records each hub request and each submitted prompt.
function engine(on: On, inbox: Array<() => Promise<{ status: number; body: unknown }>> = [], after = { status: 410, body: {} as unknown }) {
  const calls: Call[] = []
  const sent: string[] = []
  const stored: unknown[] = []
  let polls = 0

  on('command.register', (_, e) => ({ value: { command: e.name } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.cwd', () => ({ value: '/repos/api' }))
  on('session.id', () => ({ value: 'claude-session-1' }))
  on('env.get', () => ({ value: undefined }))
  on('store.set', (_, e) => (stored.push(e.value), { value: undefined }))
  on('ui.close', () => ({ value: undefined }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('process.run', () => ({ value: { exitCode: 0, stdout: '{"ok":true,"serviceToken":"svc"}\n', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }))
  on('ui.status', () => ({ value: undefined }))
  on('ui.toast', () => ({ value: undefined }))
  on('clock.sleep', () => ({ value: undefined }))
  on('prompt.submit', (_, e) => (sent.push(e.text), { text: e.text }))
  on('http.fetch', async (_, e) => {
    const url = new URL(e.url)
    const raw = e.init?.body
    calls.push({ method: e.init?.method ?? 'GET', path: url.pathname, body: typeof raw === 'string' ? JSON.parse(raw) : {} })
    let status = 200
    let body: unknown = { ok: true }
    if (url.pathname === '/subscribe') body = { token: 'session-1', name: 'api', hasKey: true }
    if (url.pathname === '/inbox') {
      const answer = inbox[polls++]
      ;({ status, body } = answer ? await answer() : after)
    }
    return { value: { status, ok: status < 400, headers: {}, text: JSON.stringify(body) } }
  })

  return { calls, sent, stored }
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
  expect(calls.find(c => c.path === '/ack')?.body).toEqual({ id: 't1', ok: true, message: 'Started. A Claude Code subagent is working on it; the result comes as [task done].' })
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
