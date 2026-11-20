import { expect, test } from 'claude-code/testing'
import type { Args, On } from 'claude-code'

import { brainArgs, brainInput, classifyTask, parseBrain, preview, TIERS } from './register'
import type { BrainRequest } from './register'

const FOOTER = { plugin: 'luke-voice', component: 'SessionMode', props: { modes: [] } } as const
const run = (args: string) => ({ command: 'luke-voice', args, origin: { kind: 'composer' } }) as Args<'command.run'>

type Call = { method: string; path: string; port: string; body: Record<string, unknown> }

// What `claude -p` prints in the brain tests; the launcher answer is used for every other process.
let brainStdout = ''
// LUKE_VOICE_PORT as the engine reports it; unset in every test but the port one.
let envPort: string | undefined

// Stands for the engine and the hub: records each hub request and each submitted prompt.
function engine(on: On, inbox: Array<() => Promise<{ status: number; body: unknown }>> = [], after = { status: 410, body: {} as unknown }, envKey?: string, health?: Record<string, unknown>) {
  const launches: unknown[] = []
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
  on('ui.close', () => ({ value: undefined }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('process.run', (_, e) => (
    launches.push(e),
    { value: { exitCode: 0, stdout: e.argv[0] === 'claude' ? brainStdout : '{"ok":true,"serviceToken":"svc"}\n', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  ))
  on('ui.status', (_, e) => (statuses.push(e.text), { value: undefined }))
  on('ui.toast', () => ({ value: undefined }))
  on('clock.sleep', () => ({ value: undefined }))
  on('clock.now', () => ({ value: 1_700_000_000_000 }))
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
    if (url.pathname === '/inbox') {
      const answer = inbox[polls++]
      ;({ status, body } = answer ? await answer() : after)
    }
    return { value: { status, ok: status < 400, headers: {}, text: JSON.stringify(body) } }
  })

  return { calls, sent, stored, launches, statuses }
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

const REQUEST: BrainRequest = {
  kind: 'user',
  text: 'verifica os testes de login',
  context: ['[news]\n<<<untrusted>>>\ntask done: ok\n<<</untrusted>>>'],
  turns: [{ role: 'user', text: 'oi' }, { role: 'luke', text: 'Oi! Em que posso ajudar?' }],
  sessions: [{ name: 'api', isBusy: true }, { name: 'site', isBusy: false }],
  focused: 'api',
}

test('the brain call is one lean Claude Haiku 5.5 run at max effort: no tools, MCP servers, settings or saved session', () => {
  const argv = brainArgs('/plugin')
  expect(argv.slice(0, 2)).toEqual(['claude', '-p'])
  expect(argv[argv.indexOf('--model') + 1]).toBe('claude-haiku-5-5')
  expect(argv[argv.indexOf('--effort') + 1]).toBe('max')
  expect(argv).toContain('--strict-mcp-config')
  expect(argv).toContain('--no-session-persistence')
  expect(argv[argv.indexOf('--tools') + 1]).toBe('')
  expect(argv[argv.indexOf('--setting-sources') + 1]).toBe('')
  expect(argv[argv.indexOf('--system-prompt-file') + 1]).toBe('/plugin/agent/brain-prompt.md')
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
  })
  expect(parseBrain(envelope('{"say":"Ok.","tool":{"name":"rm_rf","args":{}}}'))).toEqual({ say: 'Ok.', tool: null })
  expect(parseBrain(envelope('Oi, tudo bem?'))).toEqual({ say: 'Oi, tudo bem?', tool: null })
  expect(() => parseBrain(JSON.stringify({ is_error: true, result: 'rate limited' }))).toThrow('rate limited')
})

test('a think command from the hub runs the brain with the turn on stdin and acks its reply', async ($, on) => {
  brainStdout = JSON.stringify({ type: 'result', is_error: false, result: '{"say":"Posso verificar os testes de login?","tool":null}' }) + '\n'
  let release: () => void = () => undefined
  const held = new Promise<void>(resolve => (release = resolve))
  const { calls, launches } = engine(on, [
    async () => ({ status: 200, body: { commands: [{ id: 'b1', type: 'think', request: REQUEST }] } }),
    async () => (await held, { status: 410, body: {} }),
  ])

  await $.command.run(run('on'))
  await until(() => calls.some(c => c.path === '/ack'))
  await $.command.run(run('off'))
  release()

  const brainRun = launches.find(l => (l as { argv: string[] }).argv[0] === 'claude')
  // The turn goes on stdin, never in argv.
  expect(JSON.stringify(brainRun)).toContain('[agora] usuário disse: verifica os testes de login')
  expect(JSON.stringify((brainRun as { argv: string[] }).argv)).not.toContain('verifica')
  const ack = calls.find(c => c.path === '/ack')?.body
  expect(ack?.ok).toBe(true)
  expect(JSON.parse(String(ack?.message))).toEqual({ say: 'Posso verificar os testes de login?', tool: null })
})

test('a brain that fails acks the think command as failed, with the reason', async ($, on) => {
  brainStdout = JSON.stringify({ type: 'result', is_error: true, result: 'Credit balance is too low' }) + '\n'
  let release: () => void = () => undefined
  const held = new Promise<void>(resolve => (release = resolve))
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
  expect(String(ack?.message)).toContain('Credit balance is too low')
})

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
  on('store.get', (_, e) => ({ value: JSON.stringify(e).includes('voiceProvider') ? 'local' : true }))
  const { calls, launches } = engine(on)

  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await until(() => calls.some(c => c.path === '/subscribe'))
  await $.command.run(run('off'))

  expect(JSON.stringify(launches[0])).toContain('\\"provider\\":\\"local\\"')
  expect(calls.find(c => c.path === '/subscribe')?.body.provider).toBe('local')
})

test('LUKE_VOICE_PORT moves the hub address the mod calls', async ($, on) => {
  envPort = '4861'
  on('store.get', () => ({ value: true }))
  const { calls } = engine(on)

  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await until(() => calls.some(c => c.path === '/subscribe'))
  await $.command.run(run('off'))
  envPort = undefined

  expect(calls.find(c => c.path === '/subscribe')?.port).toBe('4861')
})
