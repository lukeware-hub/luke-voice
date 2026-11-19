import assert from 'node:assert/strict'
import { request } from 'node:http'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, test } from 'node:test'

process.env.LUKE_VOICE_HOME = mkdtempSync(join(tmpdir(), 'luke-voice-test-'))
const { chromeArgs, createHub } = await import('./server.mjs')

const SERVICE = 'service-token'
const WINDOW = 'window-key'
let hub
let port
const opened = []
let shutdowns = 0

before(async () => {
  hub = createHub({ serviceToken: SERVICE, windowKey: WINDOW, open: url => opened.push(url), onShutdown: () => shutdowns++ })
  await new Promise(resolve => hub.listen(0, '127.0.0.1', resolve))
  port = hub.address().port
})

after(() => {
  hub.closeAllConnections()
  hub.close()
})

function call(method, path, { body, auth, key, host, origin } = {}) {
  return new Promise((resolve, reject) => {
    const headers = { host: host ?? `127.0.0.1:${port}`, 'content-type': 'application/json' }
    if (auth) headers.authorization = `Bearer ${auth}`
    if (key) headers['x-luke-key'] = key
    if (origin) headers.origin = origin
    const req = request({ host: '127.0.0.1', port, method, path, headers }, res => {
      let text = ''
      res.on('data', chunk => (text += chunk))
      res.on('end', () => resolve({ status: res.statusCode, body: res.headers['content-type']?.startsWith('application/json') ? JSON.parse(text) : text }))
    })
    req.on('error', reject)
    req.end(body === undefined ? undefined : JSON.stringify(body))
  })
}

test('a foreign Host or Origin is refused', async () => {
  assert.equal((await call('GET', '/health', { host: 'evil.example:4848' })).status, 403)
  assert.equal((await call('GET', '/health', { origin: 'https://evil.example' })).status, 403)
  assert.equal((await call('GET', '/health')).body.app, 'luke-voice')
})

test('subscribe needs the service token, and the window key cannot pull an inbox', async () => {
  assert.equal((await call('POST', '/subscribe', { auth: WINDOW, body: { cwd: '/x' } })).status, 401)
  assert.equal((await call('GET', '/inbox', { auth: WINDOW })).status, 401)
  assert.equal((await call('POST', '/command', { key: SERVICE, body: { type: 'stop' } })).status, 401)
})

test('a send reaches only the named session, and its ack answers the window', async () => {
  const a = (await call('POST', '/subscribe', { auth: SERVICE, body: { cwd: '/repos/auth' } })).body
  const b = (await call('POST', '/subscribe', { auth: SERVICE, body: { cwd: '/repos/auth' } })).body
  assert.equal(a.name, 'auth')
  assert.equal(b.name, 'auth-2')

  const sent = call('POST', '/command', { key: WINDOW, body: { type: 'send', session: 'auth-2', prompt: 'add tests', when: 'now' } })
  const inbox = await call('GET', '/inbox?wait=2000', { auth: b.token })
  assert.equal(inbox.body.commands.length, 1)
  assert.equal(inbox.body.commands[0].prompt, 'add tests')
  await call('POST', '/ack', { auth: b.token, body: { id: inbox.body.commands[0].id, ok: true, message: 'Started a new turn.' } })
  assert.deepEqual((await sent).body, { ok: true, message: 'Started a new turn.' })

  const other = await call('GET', '/inbox?wait=0', { auth: a.token })
  assert.equal(other.body.commands.length, 0)

  await call('POST', '/unsubscribe', { auth: a.token })
  await call('POST', '/unsubscribe', { auth: b.token })
  assert.equal((await call('GET', '/inbox', { auth: a.token })).status, 401)
})

test('show opens the window once with the window key, and the page needs that key', async () => {
  const s = (await call('POST', '/subscribe', { auth: SERVICE, body: { cwd: '/repos/web' } })).body
  await call('POST', '/show', { auth: s.token, body: { call: true } })
  assert.equal(opened.length, 1)
  assert.match(opened[0], new RegExp(`k=${WINDOW}&call=1$`))
  assert.equal((await call('GET', '/')).status, 403)
  assert.equal((await call('GET', `/?k=${WINDOW}`)).status, 200)
  await call('POST', '/unsubscribe', { auth: s.token })
})

test('events are kept as activity the agent can read', async () => {
  const s = (await call('POST', '/subscribe', { auth: SERVICE, body: { cwd: '/repos/api' } })).body
  await call('POST', '/events', { auth: s.token, body: { events: [{ kind: 'tool', text: 'Bash npm test' }], isBusy: true } })
  const activity = await call('GET', '/activity?session=api', { key: WINDOW })
  assert.match(activity.body.text, /Claude is working/)
  assert.match(activity.body.text, /tool: Bash npm test/)
  await call('POST', '/unsubscribe', { auth: s.token })
})

test('a call token without an API key says how to add one', async () => {
  const res = await call('POST', '/token', { key: WINDOW })
  assert.equal(res.status, 409)
  assert.match(res.body.error, /ELEVENLABS_API_KEY/)
})

test('a reload of the same Claude session takes over its row: same name, old token answered 409', async () => {
  const first = (await call('POST', '/subscribe', { auth: SERVICE, body: { cwd: '/repos/cli', sessionId: 's-1' } })).body
  const second = (await call('POST', '/subscribe', { auth: SERVICE, body: { cwd: '/repos/cli', sessionId: 's-1' } })).body
  assert.equal(second.name, first.name)
  assert.equal((await call('GET', '/inbox', { auth: first.token })).status, 409)
  assert.equal((await call('GET', '/inbox?wait=0', { auth: second.token })).status, 200)
  assert.equal((await call('GET', '/health')).body.sessions, 1)
  await call('POST', '/unsubscribe', { auth: second.token })
})

test('shutdown needs the service token', async () => {
  assert.equal((await call('POST', '/shutdown', { auth: WINDOW })).status, 401)
  assert.equal((await call('POST', '/shutdown', { auth: SERVICE })).status, 200)
  await new Promise(resolve => setTimeout(resolve, 150))
  assert.equal(shutdowns, 1)
})

test('the Chrome window allows the mic and sound without a prompt, in its own profile', () => {
  const args = chromeArgs('http://127.0.0.1:4848/?k=x', '/home/u/.luke-voice/chrome')
  assert.ok(args.includes('--use-fake-ui-for-media-stream'))
  assert.ok(args.includes('--autoplay-policy=no-user-gesture-required'))
  assert.ok(args.includes('--user-data-dir=/home/u/.luke-voice/chrome'))
  assert.ok(args.includes('--app=http://127.0.0.1:4848/?k=x'))
})
