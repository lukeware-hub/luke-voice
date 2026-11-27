import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { request } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, test } from 'node:test'

process.env.LUKE_VOICE_HOME = mkdtempSync(join(tmpdir(), 'luke-voice-test-'))
const { createHub } = await import('./server.mjs')
const { openMemory } = await import('./memory.mjs')
const { OPEN } = await import('../window/guard.js')

const SERVICE = 'service-token'
const WINDOW = 'window-key'
let hub
let port
let memory
// The knowledge graph's updater (hub/graph.mjs), faked: it only records when it is asked.
const graphAsks = []
const graph = { schedule: ms => graphAsks.push(ms), stop: () => {} }

before(async () => {
  memory = openMemory({ dir: mkdtempSync(join(tmpdir(), 'ceci-memory-')) })
  hub = createHub({ serviceToken: SERVICE, windowKey: WINDOW, open: () => {}, memory, graph, summarizeEveryMs: 60_000 })
  await new Promise(resolve => hub.listen(0, '127.0.0.1', resolve))
  port = hub.address().port
})

after(() => {
  hub.closeAllConnections()
  hub.close()
  memory.close()
})

function call(method, path, { body, auth, key } = {}) {
  return new Promise((resolve, reject) => {
    const headers = { host: `127.0.0.1:${port}`, 'content-type': 'application/json' }
    if (auth) headers.authorization = `Bearer ${auth}`
    if (key) headers['x-luke-key'] = key
    const req = request({ host: '127.0.0.1', port, method, path, headers }, res => {
      let text = ''
      res.on('data', chunk => (text += chunk))
      res.on('end', () => resolve({ status: res.statusCode, body: text ? JSON.parse(text) : {} }))
    })
    req.on('error', reject)
    req.end(body === undefined ? undefined : JSON.stringify(body))
  })
}

// A session's mod: answers each command it pulls with `answer(command)`.
async function serve(token, answer, rounds = 1) {
  for (let i = 0; i < rounds; i++) {
    const inbox = await call('GET', '/inbox?wait=3000', { auth: token })
    for (const command of inbox.body.commands ?? []) {
      const { ok = true, message = '' } = await answer(command)
      await call('POST', '/ack', { auth: token, body: { id: command.id, ok, message } })
    }
  }
}

test('the memory routes need the window key or a session token', async () => {
  assert.equal((await call('POST', '/memory/events', { body: { events: [{ kind: 'user', text: 'x' }] } })).status, 401)
  assert.equal((await call('GET', '/memory/search?q=x')).status, 401)
  assert.equal((await call('POST', '/memory/delete', { key: 'wrong', body: { scope: { all: true } } })).status, 401)
  assert.equal((await call('GET', '/memory/stats', { key: WINDOW })).status, 200)
})

test('a call is recorded whole: words, commands and their answers, the sessions\' activity', async () => {
  const session = (await call('POST', '/subscribe', { auth: SERVICE, body: { cwd: '/repos/api', version: '9', canSummarize: true } })).body
  await call('POST', '/call', { key: WINDOW, body: { state: 'live' } })
  await call('POST', '/memory/events', { key: WINDOW, body: { events: [{ kind: 'user', text: 'Roda os testes do Girassol.', at: Date.now() }, { kind: 'ceci', text: 'Rodo os testes, posso?' }, { kind: 'robot', text: 'ignored' }] } })
  const sent = call('POST', '/command', { key: WINDOW, body: { type: 'task', task: 'rodar os testes do Girassol' } })
  await serve(session.token, () => ({ message: 'Started.' }))
  assert.equal((await sent).body.ok, true)
  await call('POST', '/events', { auth: session.token, body: { events: [{ kind: 'tool', text: 'Bash: npm test' }, { kind: 'task_done', text: 'Os testes do Girassol passaram.' }] } })
  graphAsks.length = 0
  await call('POST', '/call', { key: WINDOW, body: { state: 'idle' } })
  // The call's end asks the knowledge graph for an update, a minute later, with the summaries.
  assert.deepEqual(graphAsks, [65_000])

  const last = (await call('GET', '/memory/conversation?id=last', { key: WINDOW })).body
  const kinds = last.items.map(i => i.kind)
  assert.deepEqual(kinds, ['user', 'ceci', 'task', 'tool_result', 'session_tool', 'task_result'])
  assert.equal(last.items.find(i => i.kind === 'session_tool').untrusted, true)
  assert.equal(last.items.find(i => i.kind === 'user').untrusted, false)
  const found = (await call('GET', '/memory/search?q=girassol', { key: WINDOW })).body
  assert.ok(found.hits.length >= 3)
  assert.equal(found.total, found.hits.length)
  // The window asks for one page: the hits after the first one, and how many there are.
  const rest = (await call('GET', '/memory/search?q=girassol&limit=10&offset=1', { key: WINDOW })).body
  assert.deepEqual(rest.hits.map(h => h.id), found.hits.slice(1).map(h => h.id))
  assert.equal(rest.total, found.total)
  const listed = (await call('GET', '/memory/conversations?limit=10&offset=0', { key: WINDOW })).body
  assert.equal(listed.total, listed.conversations.length)
  assert.deepEqual((await call('GET', '/memory/conversations?limit=10&offset=10', { key: WINDOW })).body.conversations, [])
  // The mod reads the same memory with its own token.
  assert.equal((await call('GET', '/memory/stats', { auth: session.token })).body.events, 6)
  await call('POST', '/unsubscribe', { auth: session.token })
})

test('the brain reads the memory: old hits with their dates, the sessions\' words quoted as untrusted', async () => {
  const session = (await call('POST', '/subscribe', { auth: SERVICE, body: { cwd: '/repos/web', version: '9' } })).body
  await call('POST', '/call', { key: WINDOW, body: { state: 'live' } })
  const asked = call('POST', '/brain', { key: WINDOW, body: { kind: 'user', text: 'como foram os testes do Girassol?', turns: [], context: [] } })
  let seen = null
  await serve(session.token, command => {
    seen = command.request
    return { message: JSON.stringify({ say: 'Passaram!', tool: null, pending: { name: 'luke_send_to_claude', args: { prompt: 'x' } } }) }
  })
  assert.equal((await asked).body.say, 'Passaram!')
  assert.match(seen.memory, /Primeira conversa: \d{4}-\d{2}-\d{2}\./)
  assert.match(seen.memory, /usuário: Roda os testes do Girassol\./)
  assert.ok(seen.memory.includes(OPEN), seen.memory)
  // The brain's proposal is kept too.
  const now = (await call('GET', '/memory/conversation?id=last', { key: WINDOW })).body
  assert.match(now.items.at(-1).text, /Perguntou antes de usar luke_send_to_claude/)
  await call('POST', '/call', { key: WINDOW, body: { state: 'idle' } })
  await call('POST', '/unsubscribe', { auth: session.token })
})

test('a delete from the window removes what it names, and says how much', async () => {
  const before = (await call('GET', '/memory/stats', { key: WINDOW })).body.events
  const preview = (await call('POST', '/memory/preview', { key: WINDOW, body: { scope: { search: 'girassol' } } })).body
  assert.ok(preview.events >= 3)
  graphAsks.length = 0
  const done = (await call('POST', '/memory/delete', { key: WINDOW, body: { scope: { search: 'girassol' } } })).body
  assert.equal(done.deleted, preview.events)
  // The knowledge graph is asked to drop the deleted words too, right away.
  assert.deepEqual(graphAsks, [0])
  assert.deepEqual((await call('GET', '/memory/search?q=girassol', { key: WINDOW })).body.hits, [])
  assert.equal((await call('GET', '/memory/stats', { key: WINDOW })).body.events, before - preview.events)
})

test('a delete by voice is only ever asked: the brain\'s proposal gets its count, deletes nothing, and a miss is not asked', async () => {
  await call('POST', '/call', { key: WINDOW, body: { state: 'live' } })
  await call('POST', '/memory/events', { key: WINDOW, body: { events: [{ kind: 'user', text: 'A senha do cofre é Tartaruga.' }, { kind: 'user', text: 'Outra fala sobre Tartaruga.' }] } })
  await call('POST', '/call', { key: WINDOW, body: { state: 'idle' } })
  const session = (await call('POST', '/subscribe', { auth: SERVICE, body: { cwd: '/repos/cofre', version: '9' } })).body
  const ask = async reply => {
    const asked = call('POST', '/brain', { key: WINDOW, body: { kind: 'user', text: 'apaga o que falei da tartaruga', turns: [], context: [] } })
    await serve(session.token, () => ({ message: JSON.stringify(reply) }))
    return (await asked).body
  }
  const before = (await call('GET', '/memory/stats', { key: WINDOW })).body.events
  const pending = { name: 'luke_memory_delete', args: { search: 'tartaruga' } }
  const proposed = await ask({ say: 'Apago tudo que fala da tartaruga, posso?', tool: null, pending })
  assert.equal(proposed.say, 'São 2 registros. Apago tudo que fala da tartaruga, posso?')
  assert.deepEqual(proposed.pending, pending)
  // The brain calling it at once deletes nothing either: only the window runs it, after a yes.
  const atOnce = await ask({ say: 'Apaguei.', tool: pending, pending: null })
  assert.deepEqual(atOnce.tool, pending)
  // A delete that matches nothing is not asked about.
  const miss = await ask({ say: 'Apago tudo sobre girafas, posso?', tool: null, pending: { name: 'luke_memory_delete', args: { search: 'girafas' } } })
  assert.equal(miss.pending, null)
  assert.match(miss.say, /não achei nada/i)
  const unclear = await ask({ say: 'Apago, posso?', tool: null, pending: { name: 'luke_memory_delete', args: {} } })
  assert.equal(unclear.pending, null)
  // Nothing was deleted by any of it (the brain's proposals were recorded, so there are more events).
  assert.ok((await call('GET', '/memory/stats', { key: WINDOW })).body.events >= before)
  assert.equal((await call('GET', '/memory/search?q=tartaruga&kind=user', { key: WINDOW })).body.hits.length, 2)
  await call('POST', '/unsubscribe', { auth: session.token })
})

test('a session event keeps its whole text in the memory, even when the voice reads it shortened', async () => {
  const session = (await call('POST', '/subscribe', { auth: SERVICE, body: { cwd: '/repos/longo', version: '9' } })).body
  const long = `Resposta longa ${'palavra '.repeat(3000)}fim-do-texto`
  await call('POST', '/events', { auth: session.token, body: { events: [{ kind: 'done', text: 'Resposta longa…', full: long }] } })
  const hit = (await call('GET', '/memory/search?q=fim-do-texto', { key: WINDOW })).body.hits[0]
  assert.equal(hit.text, long)
  await call('POST', '/unsubscribe', { auth: session.token })
})
