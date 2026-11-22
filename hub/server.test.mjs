import assert from 'node:assert/strict'
import { createServer as createHttpServer, request } from 'node:http'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, test } from 'node:test'

process.env.LUKE_VOICE_HOME = mkdtempSync(join(tmpdir(), 'luke-voice-test-'))
const { browserCandidates, chromeArgs, chromePath, createEngineRunner, createHub, isWsl, loadSecrets, needsPrepare, openWindow, windowCommand } = await import('./server.mjs')
const { ASR_GLOSSARY } = await import('./engine.mjs')

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

// Ceci's voice reference and its transcript: /tts refuses to speak without both.
const voiceRefFile = () => {
  const file = join(mkdtempSync(join(tmpdir(), 'luke-voice-ref-')), 'ceci.wav')
  writeFileSync(file, 'CECIVOICE')
  writeFileSync(file.replace(/[.]wav$/, '.txt'), 'Oi, eu sou a Ceci.')
  return file
}

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

test('show opens the window once with a one-time launch code, never the window key, and the page trades it once for the key', async () => {
  const s = (await call('POST', '/subscribe', { auth: SERVICE, body: { cwd: '/repos/web' } })).body
  await call('POST', '/show', { auth: s.token, body: { call: true } })
  assert.equal(opened.length, 1)
  // The address is on the browser's command line, which other users of the computer can read.
  assert.ok(!opened[0].includes(WINDOW), 'the window key is not in the address')
  const nonce = /[?&]n=([\w-]+)&call=1$/.exec(opened[0])?.[1]
  assert.ok(nonce, opened[0])
  // The page holds no secret: a reload (the address no longer has the code) still loads it.
  assert.equal((await call('GET', '/')).status, 200)
  const same = `http://127.0.0.1:${port}`
  // Only the window's own page may trade it: another site, or no Origin at all, is refused.
  assert.equal((await call('POST', '/launch', { body: { nonce }, origin: 'https://evil.example' })).status, 403)
  assert.equal((await call('POST', '/launch', { body: { nonce } })).status, 403)
  const traded = await call('POST', '/launch', { body: { nonce }, origin: same })
  assert.equal(traded.status, 200)
  assert.equal(traded.body.key, WINDOW)
  assert.equal((await call('POST', '/launch', { body: { nonce }, origin: same })).status, 403, 'a code works once')
  assert.equal((await call('POST', '/launch', { body: { nonce: 'made-up' }, origin: same })).status, 403)
  assert.equal((await call('POST', '/launch', { body: {}, origin: same })).status, 403)
  await call('POST', '/unsubscribe', { auth: s.token })
})

test('a launch code expires after two minutes', async () => {
  let now = 1_000_000
  const timed = createHub({ serviceToken: SERVICE, windowKey: WINDOW, open: url => opened.push(url), clock: () => now })
  await new Promise(resolve => timed.listen(0, '127.0.0.1', resolve))
  const saved = port
  port = timed.address().port
  try {
    const same = `http://127.0.0.1:${port}`
    const s = (await call('POST', '/subscribe', { auth: SERVICE, body: { cwd: '/repos/web' } })).body
    const code = async () => {
      await call('POST', '/show', { auth: s.token, body: {} })
      return /[?&]n=([\w-]+)$/.exec(opened.at(-1))?.[1]
    }
    const inTime = await code()
    now += 119_000
    assert.equal((await call('POST', '/launch', { body: { nonce: inTime }, origin: same })).status, 200)
    const late = await code()
    now += 121_000
    assert.equal((await call('POST', '/launch', { body: { nonce: late }, origin: same })).status, 403)
    await call('POST', '/unsubscribe', { auth: s.token })
  } finally {
    port = saved
    timed.closeAllConnections()
    timed.close()
  }
})

test('the page loads no remote script; the ElevenLabs client is loaded on demand, pinned, with an integrity hash', async () => {
  const page = (await call('GET', '/')).body
  // The free voice must never wait on a CDN: no remote script on the page itself.
  assert.doesNotMatch(page, /<script\b[^>]*\bsrc="https?:/)
  const eleven = (await call('GET', '/engines/elevenlabs.js')).body
  assert.match(eleven, /CLIENT_URL = 'https:\/\/cdn\.jsdelivr\.net\/npm\/@elevenlabs\/client@\d+\.\d+\.\d+\/dist\/lib\.iife\.js'/)
  assert.match(eleven, /CLIENT_INTEGRITY = 'sha384-[A-Za-z0-9+/=]{64}'/)
  assert.match(eleven, /script\.integrity = CLIENT_INTEGRITY/)
  assert.match(eleven, /script\.crossOrigin = 'anonymous'/)
  for (const path of ['/app.js', '/guard.js', '/engines/elevenlabs.js', '/engines/local.js', '/engines/speech-text.js', '/engines/fast-path.js', '/engines/turn-join.js', '/engines/confirm.js', '/engines/progress.js', '/engines/vad.js', '/engines/piper-ids.js', '/engines/transcript.js', '/engines/mic-worklet.js', '/engines/voice-worker.js']) {
    const res = await call('GET', path)
    assert.equal(res.status, 200)
    assert.doesNotMatch(res.body, /\bfrom\s*['"]https?:|import\s*\(\s*['"]https?:/)
  }
})

test('events are kept as activity the agent can read', async () => {
  const s = (await call('POST', '/subscribe', { auth: SERVICE, body: { cwd: '/repos/api' } })).body
  await call('POST', '/events', { auth: s.token, body: { events: [{ kind: 'tool', text: 'Bash npm test' }], isBusy: true } })
  const activity = await call('GET', '/activity?session=api', { key: WINDOW })
  assert.match(activity.body.text, /Claude is working/)
  assert.match(activity.body.text, /tool: Bash npm test/)
  await call('POST', '/unsubscribe', { auth: s.token })
})

test('a call token without an API key says how to add one, or to use the free voice', async () => {
  const res = await call('POST', '/token', { key: WINDOW })
  assert.equal(res.status, 409)
  assert.match(res.body.error, /plugin configure luke-voice@luke-voice/)
  assert.match(res.body.error, /luke-voice voz local/)
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
  const args = chromeArgs('http://127.0.0.1:4848/?n=x', '/home/u/.luke-voice/chrome')
  assert.ok(args.includes('--use-fake-ui-for-media-stream'))
  assert.ok(args.includes('--autoplay-policy=no-user-gesture-required'))
  assert.ok(args.includes('--user-data-dir=/home/u/.luke-voice/chrome'))
  assert.ok(args.includes('--app=http://127.0.0.1:4848/?n=x'))
})

test('a voice task reaches the named session, and an empty task is refused', async () => {
  const s1 = (await call('POST', '/subscribe', { auth: SERVICE, body: { cwd: '/repos/tasks' } })).body
  assert.equal((await call('POST', '/command', { key: WINDOW, body: { type: 'task', session: s1.name, task: '  ' } })).status, 400)
  const started = call('POST', '/command', { key: WINDOW, body: { type: 'task', session: s1.name, task: 'verifica o login' } })
  const inbox = await call('GET', '/inbox?wait=2000', { auth: s1.token })
  assert.deepEqual({ type: inbox.body.commands[0].type, task: inbox.body.commands[0].task }, { type: 'task', task: 'verifica o login' })
  await call('POST', '/ack', { auth: s1.token, body: { id: inbox.body.commands[0].id, ok: true, message: 'Started.' } })
  assert.deepEqual((await started).body, { ok: true, message: 'Started.' })
  await call('POST', '/unsubscribe', { auth: s1.token })
})

test('the window font is served locally as font/woff2', async () => {
  const res = await new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path: '/fonts/schibsted-grotesk-latin-wght-normal.woff2', headers: { host: `127.0.0.1:${port}` } }, r => {
      r.resume()
      r.on('end', () => resolve(r))
    })
    req.on('error', reject)
    req.end()
  })
  assert.equal(res.statusCode, 200)
  assert.equal(res.headers['content-type'], 'font/woff2')
})

test('health reports a missing key, and a new key offered on subscribe is taken when none is set', async () => {
  assert.equal((await call('GET', '/health')).body.keyStatus, 'missing')
  const s = (await call('POST', '/subscribe', { auth: SERVICE, body: { cwd: '/repos/keys', apiKey: 'k-1' } })).body
  assert.equal((await call('GET', '/health')).body.keyStatus, 'set')
  await call('POST', '/unsubscribe', { auth: s.token })
})

test('a changed key offered on subscribe replaces the one in use, and the same key changes nothing', async () => {
  const first = (await call('POST', '/subscribe', { auth: SERVICE, body: { cwd: '/repos/keys-a', apiKey: 'key-a' } })).body
  const idA = (await call('GET', '/health')).body.keyId
  const second = (await call('POST', '/subscribe', { auth: SERVICE, body: { cwd: '/repos/keys-b', apiKey: 'key-b' } })).body
  const idB = (await call('GET', '/health')).body.keyId
  assert.match(idA, /^[0-9a-f]{8}$/)
  assert.notEqual(idB, idA)
  const third = (await call('POST', '/subscribe', { auth: SERVICE, body: { cwd: '/repos/keys-c', apiKey: 'key-b' } })).body
  assert.equal((await call('GET', '/health')).body.keyId, idB)
  assert.equal((await call('GET', '/health')).body.keyStatus, 'set')
  for (const s of [first, second, third]) await call('POST', '/unsubscribe', { auth: s.token })
})

test('an older session cannot bring back a key the user already replaced', async () => {
  const before = (await call('POST', '/subscribe', { auth: SERVICE, body: { cwd: '/repos/old-a', apiKey: 'key-old' } })).body
  const changed = (await call('POST', '/subscribe', { auth: SERVICE, body: { cwd: '/repos/new', apiKey: 'key-new' } })).body
  const idNew = (await call('GET', '/health')).body.keyId
  // The session started before the change reconnects with the old key.
  const stale = (await call('POST', '/subscribe', { auth: SERVICE, body: { cwd: '/repos/old-b', apiKey: 'key-old' } })).body
  assert.equal((await call('GET', '/health')).body.keyId, idNew)
  for (const s of [before, changed, stale]) await call('POST', '/unsubscribe', { auth: s.token })
})

test('a command or activity for an unknown session is refused, never sent to another session', async () => {
  const s1 = (await call('POST', '/subscribe', { auth: SERVICE, body: { cwd: '/repos/real' } })).body
  const out = await call('POST', '/command', { key: WINDOW, body: { type: 'task', session: 'ghost', task: 'apaga tudo' } })
  assert.equal(out.status, 404)
  assert.equal(out.body.ok, false)
  assert.match(out.body.message, /ghost/)
  assert.match(out.body.message, new RegExp(s1.name))
  const activity = (await call('GET', '/activity?session=ghost', { key: WINDOW })).body.text
  assert.match(activity, /ghost/)
  const inbox = await call('GET', '/inbox?wait=200', { auth: s1.token })
  assert.deepEqual(inbox.body.commands, [])
  await call('POST', '/unsubscribe', { auth: s1.token })
})

test('a command with no session still goes to the focused one', async () => {
  const s1 = (await call('POST', '/subscribe', { auth: SERVICE, body: { cwd: '/repos/solo' } })).body
  await call('POST', '/focus', { key: WINDOW, body: { name: s1.name } })
  const sent = call('POST', '/command', { key: WINDOW, body: { type: 'stop' } })
  const inbox = await call('GET', '/inbox?wait=2000', { auth: s1.token })
  assert.equal(inbox.body.commands[0].type, 'stop')
  await call('POST', '/ack', { auth: s1.token, body: { id: inbox.body.commands[0].id, ok: true, message: 'Stopped.' } })
  assert.equal((await sent).body.ok, true)
  await call('POST', '/unsubscribe', { auth: s1.token })
})

test('the window gets the free local voice without a key, and ElevenLabs once a key is set', async () => {
  const fresh = createHub({ serviceToken: SERVICE, windowKey: WINDOW, open: () => {} })
  await new Promise(resolve => fresh.listen(0, '127.0.0.1', resolve))
  const get = (path, headers = {}) =>
    new Promise((resolve, reject) => {
      const p = fresh.address().port
      const req = request({ host: '127.0.0.1', port: p, path, method: path === '/subscribe' ? 'POST' : 'GET', headers: { host: `127.0.0.1:${p}`, 'content-type': 'application/json', ...headers } }, res => {
        let text = ''
        res.on('data', chunk => (text += chunk))
        res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(text) }))
      })
      req.on('error', reject)
      req.end(path === '/subscribe' ? JSON.stringify({ cwd: '/repos/p', apiKey: 'k-p' }) : undefined)
    })
  try {
    assert.equal((await get('/config')).status, 401)
    assert.equal((await get('/config', { 'x-luke-key': WINDOW })).body.provider, 'local')
    await get('/subscribe', { authorization: `Bearer ${SERVICE}` })
    assert.equal((await get('/config', { 'x-luke-key': WINDOW })).body.provider, 'elevenlabs')
  } finally {
    fresh.closeAllConnections()
    fresh.close()
  }
})

test('the voice chosen in Claude Code wins over the env and the key, and /provider switches it while running', async () => {
  const hub2 = createHub({ serviceToken: SERVICE, windowKey: WINDOW, apiKey: 'k', provider: 'elevenlabs', open: () => {} })
  await new Promise(resolve => hub2.listen(0, '127.0.0.1', resolve))
  const p = hub2.address().port
  const ask = (method, path, { body, headers = {} } = {}) =>
    new Promise((resolve, reject) => {
      const req = request({ host: '127.0.0.1', port: p, method, path, headers: { host: `127.0.0.1:${p}`, 'content-type': 'application/json', ...headers } }, res => {
        let text = ''
        res.on('data', chunk => (text += chunk))
        res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(text) }))
      })
      req.on('error', reject)
      req.end(body === undefined ? undefined : JSON.stringify(body))
    })
  const config = async () => (await ask('GET', '/config', { headers: { 'x-luke-key': WINDOW } })).body.provider
  try {
    assert.equal(await config(), 'elevenlabs')
    const s = (await ask('POST', '/subscribe', { body: { cwd: '/repos/v', provider: 'local' }, headers: { authorization: `Bearer ${SERVICE}` } })).body
    assert.equal(s.provider, 'local')
    assert.equal(await config(), 'local')
    const switched = await ask('POST', '/provider', { body: { provider: 'elevenlabs' }, headers: { authorization: `Bearer ${s.token}` } })
    assert.deepEqual(switched.body, { ok: true, provider: 'elevenlabs', hasKey: true })
    assert.equal(await config(), 'elevenlabs')
    assert.equal((await ask('POST', '/provider', { body: { provider: 'banana' }, headers: { authorization: `Bearer ${s.token}` } })).status, 400)
    assert.equal((await ask('POST', '/provider', { body: { provider: 'local' }, headers: { authorization: 'Bearer nope' } })).status, 401)
    // A subscribe with no choice keeps the voice chosen before.
    await ask('POST', '/subscribe', { body: { cwd: '/repos/w' }, headers: { authorization: `Bearer ${SERVICE}` } })
    assert.equal(await config(), 'elevenlabs')
  } finally {
    hub2.closeAllConnections()
    hub2.close()
  }
})

test('an explicit provider wins over the key', async () => {
  const pinned = createHub({ serviceToken: SERVICE, windowKey: WINDOW, apiKey: 'k', provider: 'local', open: () => {} })
  await new Promise(resolve => pinned.listen(0, '127.0.0.1', resolve))
  const p = pinned.address().port
  const body = await new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port: p, path: '/health', headers: { host: `127.0.0.1:${p}` } }, res => {
      let text = ''
      res.on('data', chunk => (text += chunk))
      res.on('end', () => resolve(JSON.parse(text)))
    })
    req.on('error', reject)
    req.end()
  })
  pinned.closeAllConnections()
  pinned.close()
  assert.equal(body.provider, 'local')
})

test('vendored files are served from the hub, unknown ones are 404, and the page is cross-origin isolated', async () => {
  const modelFile = join(mkdtempSync(join(tmpdir(), 'luke-model-')), 'm.onnx')
  writeFileSync(modelFile, 'ONNXBYTES')
  const vendored = join(mkdtempSync(join(tmpdir(), 'luke-vendor-')), 'version.mjs')
  writeFileSync(vendored, 'export const V = 1')
  const asked = []
  const served = createHub({
    serviceToken: SERVICE,
    windowKey: WINDOW,
    open: () => {},
    vendor: async path => (path === 'espeak/dist/version.mjs' ? vendored : null),
    models: async path => {
      asked.push(path)
      return path === 'turn/silero-vad.onnx' ? modelFile : null
    },
  })
  await new Promise(resolve => served.listen(0, '127.0.0.1', resolve))
  const p = served.address().port
  const fetchRaw = (path, headers = {}) =>
    new Promise((resolve, reject) => {
      const req = request({ host: '127.0.0.1', port: p, path, headers: { host: `127.0.0.1:${p}`, ...headers } }, res => {
        let text = ''
        res.on('data', chunk => (text += chunk))
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text }))
      })
      req.on('error', reject)
      req.end()
    })
  try {
    const file = await fetchRaw('/vendor/espeak/dist/version.mjs', { 'sec-fetch-site': 'same-origin' })
    assert.equal(file.status, 200)
    assert.equal(file.text, 'export const V = 1')
    assert.equal(file.headers['content-type'], 'text/javascript; charset=utf-8')
    assert.equal(file.headers['content-length'], '18')
    assert.equal((await fetchRaw('/vendor/../../hub.json', { 'sec-fetch-site': 'same-origin' })).status, 404)
    const model = await fetchRaw('/models/turn/silero-vad.onnx', { 'sec-fetch-site': 'same-origin' })
    assert.equal(model.status, 200)
    assert.equal(model.text, 'ONNXBYTES')
    assert.equal(model.headers['content-length'], '9')
    assert.equal((await fetchRaw('/models/nope.onnx', { 'sec-fetch-site': 'same-origin' })).status, 404)
    // The window's own worker gets them; another web page (an <img> on some site) does not.
    assert.equal((await fetchRaw('/models/turn/silero-vad.onnx', { 'sec-fetch-site': 'same-origin' })).status, 200)
    assert.equal((await fetchRaw('/models/turn/silero-vad.onnx', { 'sec-fetch-site': 'cross-site' })).status, 403)
    assert.equal((await fetchRaw('/vendor/espeak/dist/version.mjs', { 'sec-fetch-site': 'same-site' })).status, 403)
    // A browser that does not send Sec-Fetch-Site: the window's own loads carry its address as
    // Referer (or the window key); a page elsewhere, or one that hides its Referer, gets nothing.
    assert.equal((await fetchRaw('/models/turn/silero-vad.onnx')).status, 403)
    assert.equal((await fetchRaw('/models/turn/silero-vad.onnx', { referer: 'https://evil.example/page' })).status, 403)
    assert.equal((await fetchRaw('/models/turn/silero-vad.onnx', { referer: `http://127.0.0.1:${p}.evil.example/` })).status, 403)
    assert.equal((await fetchRaw('/vendor/espeak/dist/version.mjs', { referer: `http://127.0.0.1:${p}/engines/voice-worker.js` })).status, 200)
    assert.equal((await fetchRaw('/models/turn/silero-vad.onnx', { 'x-luke-key': WINDOW })).status, 200)
    assert.equal((await fetchRaw('/models/turn/silero-vad.onnx', { 'x-luke-key': 'wrong' })).status, 403)
    assert.equal(asked.includes('native/qwen3-asr-0.6b-q8_0.gguf'), false)
    assert.equal((await fetchRaw('/models/native/qwen3-asr-0.6b-q8_0.gguf', { 'sec-fetch-site': 'same-origin' })).status, 404)
    assert.equal(asked.includes('native/qwen3-asr-0.6b-q8_0.gguf'), false, 'the native models are never fetched for the window')
    const page = await fetchRaw('/')
    assert.equal(page.headers['cross-origin-opener-policy'], 'same-origin')
    assert.equal(page.headers['cross-origin-embedder-policy'], 'credentialless')
    assert.equal((await fetchRaw('/engines/voice-worker.js')).headers['cross-origin-embedder-policy'], 'credentialless')
  } finally {
    served.closeAllConnections()
    served.close()
  }
})

test('the brain turn goes to the focused session as a think command, and its JSON reply comes back', async () => {
  const s1 = (await call('POST', '/subscribe', { auth: SERVICE, body: { cwd: '/repos/brainy', version: '0.9.6' } })).body
  await call('POST', '/focus', { key: WINDOW, body: { name: s1.name } })
  const asked = call('POST', '/brain', { key: WINDOW, body: { kind: 'user', text: 'oi', context: Array(20).fill('x'), turns: [{ role: 'user', text: 'oi' }] } })
  const inbox = await call('GET', '/inbox?wait=2000', { auth: s1.token })
  const command = inbox.body.commands[0]
  assert.equal(command.type, 'think')
  assert.equal(command.request.text, 'oi')
  assert.equal(command.request.context.length, 8)
  assert.ok(command.request.sessions.some(s => s.name === s1.name))
  const pending = { name: 'luke_run_task', args: { task: 'rodar os testes' } }
  await call('POST', '/ack', { auth: s1.token, body: { id: command.id, ok: true, message: JSON.stringify({ say: 'Posso?', tool: null, pending }) } })
  // The pending action reaches the window, so a plain "sim" runs it with no second brain call.
  assert.deepEqual((await asked).body, { say: 'Posso?', tool: null, pending })

  const failing = call('POST', '/brain', { key: WINDOW, body: { kind: 'user', text: 'oi' } })
  const next = (await call('GET', '/inbox?wait=2000', { auth: s1.token })).body.commands[0]
  await call('POST', '/ack', { auth: s1.token, body: { id: next.id, ok: false, message: 'The brain did not answer: no credits' } })
  const failed = await failing
  assert.equal(failed.status, 502)
  assert.match(failed.body.error, /no credits/)
  await call('POST', '/unsubscribe', { auth: s1.token })
})

test('a session from an older luke-voice (no version, no voice) is never asked to think', async () => {
  // 0.7.9 handed any command it did not know to Claude as a prompt: "…pass this on: undefined".
  const old = (await call('POST', '/subscribe', { auth: SERVICE, body: { cwd: '/repos/oldie' } })).body
  await call('POST', '/focus', { key: WINDOW, body: { name: old.name } })
  const reply = await call('POST', '/brain', { key: WINDOW, body: { kind: 'user', text: 'oi' } })
  assert.equal(reply.status, 200)
  assert.match(reply.body.say, new RegExp(`${old.name} está com uma versão antiga`))
  const inbox = await call('GET', '/inbox?wait=50', { auth: old.token })
  assert.equal((inbox.body.commands ?? []).length, 0, 'no think command reached the old session')
  // A 0.9.5 session sends its voice but no version: it can think.
  const s095 = (await call('POST', '/subscribe', { auth: SERVICE, body: { cwd: '/repos/ninefive', provider: 'local' } })).body
  await call('POST', '/focus', { key: WINDOW, body: { name: s095.name } })
  const asked = call('POST', '/brain', { key: WINDOW, body: { kind: 'user', text: 'oi' } })
  const command = (await call('GET', '/inbox?wait=2000', { auth: s095.token })).body.commands[0]
  assert.equal(command.type, 'think')
  await call('POST', '/ack', { auth: s095.token, body: { id: command.id, ok: true, message: JSON.stringify({ say: 'Oi!', tool: null, pending: null }) } })
  assert.equal((await asked).body.say, 'Oi!')
  await call('POST', '/unsubscribe', { auth: old.token })
  await call('POST', '/unsubscribe', { auth: s095.token })
})

test('with no Claude session, the brain says how to connect one instead of failing', async () => {
  const lonely = createHub({ serviceToken: SERVICE, windowKey: WINDOW, open: () => {} })
  await new Promise(resolve => lonely.listen(0, '127.0.0.1', resolve))
  const p = lonely.address().port
  const body = await new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port: p, method: 'POST', path: '/brain', headers: { host: `127.0.0.1:${p}`, 'x-luke-key': WINDOW, 'content-type': 'application/json' } }, res => {
      let text = ''
      res.on('data', chunk => (text += chunk))
      res.on('end', () => resolve(JSON.parse(text)))
    })
    req.on('error', reject)
    req.end(JSON.stringify({ kind: 'user', text: 'oi' }))
  })
  lonely.closeAllConnections()
  lonely.close()
  assert.equal(body.tool, null)
  assert.match(body.say, /Ligue o luke-voice/)
})

test('speech goes to the native engine: /stt sends the WAV with the glossary, /tts streams the cloned voice back', async () => {
  // A stand-in for the two llama-servers.
  const seen = {}
  const fake = createHttpServer(async (req, res) => {
    const chunks = []
    for await (const c of req) chunks.push(c)
    const body = Buffer.concat(chunks)
    if (req.url === '/v1/audio/transcriptions') {
      seen.stt = body.toString('latin1')
      res.writeHead(200, { 'content-type': 'application/json' })
      return res.end(JSON.stringify({ text: 'language Portuguese<asr_text>verifica os testes da api' }))
    }
    if (req.url === '/tts') {
      seen.tts = JSON.parse(body.toString('utf8'))
      res.writeHead(200, { 'content-type': 'audio/wav' })
      res.write(Buffer.from('RIFF....WAVE'))
      return res.end(Buffer.from([1, 2, 3, 4]))
    }
    res.writeHead(404)
    res.end()
  })
  await new Promise(resolve => fake.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${fake.address().port}`
  const voiceRef = join(mkdtempSync(join(tmpdir(), 'luke-voice-ref-')), 'ceci.wav')
  writeFileSync(voiceRef, 'CECIVOICE')
  writeFileSync(voiceRef.replace(/[.]wav$/, '.txt'), 'Oi, eu sou a Ceci.')
  const engine = { url: () => base, status: () => ({ tts: true, asr: true, router: false }) }
  const hub2 = createHub({ serviceToken: SERVICE, windowKey: WINDOW, open: () => {}, engine, voiceRef, profile: () => ({ profile: 'gpu' }) })
  await new Promise(resolve => hub2.listen(0, '127.0.0.1', resolve))
  const p = hub2.address().port
  const post = (path, body, type, key = WINDOW) =>
    new Promise((resolve, reject) => {
      const req = request({ host: '127.0.0.1', port: p, method: 'POST', path, headers: { host: `127.0.0.1:${p}`, 'content-type': type, 'x-luke-key': key } }, res => {
        const parts = []
        res.on('data', c => parts.push(c))
        res.on('end', () => resolve({ status: res.statusCode, type: res.headers['content-type'], body: Buffer.concat(parts) }))
      })
      req.on('error', reject)
      req.end(body)
    })
  try {
    assert.equal((await post('/stt', Buffer.from('RIFFWAV'), 'audio/wav', 'wrong')).status, 401)
    const stt = await post('/stt', Buffer.from('RIFFWAV'), 'audio/wav')
    assert.equal(stt.status, 200)
    assert.equal(JSON.parse(stt.body).text, 'verifica os testes da api')
    assert.match(seen.stt, /RIFFWAV/)
    assert.match(seen.stt, /name="language"\r\n\r\npt/)
    assert.match(seen.stt, /commit, branch/)
    const tts = await post('/tts', JSON.stringify({ text: 'Comecei, te aviso quando terminar.' }), 'application/json')
    assert.equal(tts.status, 200)
    assert.equal(tts.type, 'audio/wav')
    assert.equal(tts.body.length, 16)
    assert.equal(seen.tts.input, 'Comecei, te aviso quando terminar.')
    assert.equal(seen.tts.lang, 'pt')
    assert.equal(seen.tts.stream, true)
    assert.equal(Buffer.from(seen.tts.speaker_ref_b64, 'base64').toString(), 'CECIVOICE')
    // Cloned with the reference transcript (Brazilian accent), Ceci's sampling, and a cap against loops.
    assert.equal(seen.tts.speaker_ref_text, 'Oi, eu sou a Ceci.')
    assert.deepEqual([seen.tts.temperature, seen.tts.top_p, seen.tts.seed], [0.9, 0.9, 7])
    assert.equal(seen.tts.n_predict, Math.ceil('Comecei, te aviso quando terminar.'.length * 1.5) + 25)
    assert.equal((await post('/tts', JSON.stringify({ text: '  ' }), 'application/json')).status, 400)
    // The engine's small context holds ~380 characters: a longer text is capped, not cut mid-audio.
    await post('/tts', JSON.stringify({ text: 'a'.repeat(500) }), 'application/json')
    assert.equal(seen.tts.input.length, 360)
  } finally {
    hub2.closeAllConnections()
    hub2.close()
    fake.close()
  }
})

test('the ears hear with what Ceci said in the last minute: newest words first, capped, then forgotten', async () => {
  const prompts = []
  const fake = createHttpServer(async (req, res) => {
    const chunks = []
    for await (const c of req) chunks.push(c)
    if (req.url === '/v1/audio/transcriptions') {
      prompts.push(Buffer.concat(chunks).toString('utf8').match(/name="prompt"\r\n\r\n([^\r]*)/)[1])
      res.writeHead(200, { 'content-type': 'application/json' })
      return res.end(JSON.stringify({ text: 'language Portuguese<asr_text>tenta falar Alcaçuz' }))
    }
    res.writeHead(200, { 'content-type': 'audio/wav' })
    res.end(Buffer.from('RIFF....WAVE\x01\x02\x03\x04'))
  })
  await new Promise(resolve => fake.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${fake.address().port}`
  const voiceRef = join(mkdtempSync(join(tmpdir(), 'luke-voice-ref-')), 'ceci.wav')
  writeFileSync(voiceRef, 'CECIVOICE')
  writeFileSync(voiceRef.replace(/[.]wav$/, '.txt'), 'Oi, eu sou a Ceci.')
  let now = 1_000_000
  const engine = { url: () => base, status: () => ({ tts: true, asr: true, router: false }) }
  const hub2 = createHub({ serviceToken: SERVICE, windowKey: WINDOW, open: () => {}, engine, voiceRef, profile: () => ({ profile: 'gpu' }), clock: () => now })
  await new Promise(resolve => hub2.listen(0, '127.0.0.1', resolve))
  const p = hub2.address().port
  const post = (path, body, type) =>
    new Promise((resolve, reject) => {
      const req = request({ host: '127.0.0.1', port: p, method: 'POST', path, headers: { host: `127.0.0.1:${p}`, 'content-type': type, 'x-luke-key': WINDOW } }, res => {
        res.resume()
        res.on('end', () => resolve(res.statusCode))
      })
      req.on('error', reject)
      req.end(body)
    })
  const say = text => post('/tts', JSON.stringify({ text }), 'application/json')
  const hear = async () => (await post('/stt', Buffer.from('RIFFWAV'), 'audio/wav'), prompts.at(-1))
  try {
    // Nothing said yet: the glossary alone, with the model names in it.
    assert.equal(await hear(), ASR_GLOSSARY)
    assert.match(ASR_GLOSSARY, /Opus, Sonnet, Haiku, Anthropic, Lukeware/)
    assert.match(ASR_GLOSSARY, /push, merge, PR, teste, repositório, subagente, npm, luke-voice\.$/)
    // Her answer stays after a short acknowledgement made while the call is idle.
    await say('A Lagoa de Alcaçuz fica em Natal.')
    now += 5_000
    await say('Certo.')
    assert.equal(await hear(), `${ASR_GLOSSARY} Ceci acabou de dizer: A Lagoa de Alcaçuz fica em Natal. Certo.`)
    // A long answer: only its newest 200 characters, cut at a word.
    const long = Array.from({ length: 30 }, (_, i) => `palavra${i}`).join(' ')
    await say(long)
    const said = (await hear()).split('Ceci acabou de dizer: ')[1]
    assert.ok(said.length <= 200, said)
    assert.ok(said.endsWith('palavra29'))
    assert.match(said, /^palavra\d+ /)
    // A minute later it is forgotten.
    now += 61_000
    assert.equal(await hear(), ASR_GLOSSARY)
  } finally {
    hub2.closeAllConnections()
    hub2.close()
    fake.close()
  }
})

test('a yes/no question gets more takes only while the line before still plays, and its natural take is kept', async () => {
  const { take, wav } = await import('./test-audio.mjs')
  // Ceci's seed (7) and the first extra seed end flat; the next one rises +6 semitones.
  const flat = wav(take(1.5, 0))
  const rising = wav(take(1.5, 6))
  const seeds = []
  const fake = createHttpServer(async (req, res) => {
    const chunks = []
    for await (const c of req) chunks.push(c)
    const { seed } = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    seeds.push(seed)
    res.writeHead(200, { 'content-type': 'audio/wav' })
    res.end(seed === 7 || seed === 101 ? flat : rising)
  })
  await new Promise(resolve => fake.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${fake.address().port}`
  const engine = { url: () => base, status: () => ({ tts: true, asr: true, router: false }) }
  const questionsDir = mkdtempSync(join(tmpdir(), 'luke-voice-questions-'))
  const hub2 = createHub({ serviceToken: SERVICE, windowKey: WINDOW, open: () => {}, engine, voiceRef: voiceRefFile(), profile: () => ({ profile: 'gpu' }), questionsDir })
  await new Promise(resolve => hub2.listen(0, '127.0.0.1', resolve))
  const p = hub2.address().port
  const say = body =>
    new Promise((resolve, reject) => {
      const req = request({ host: '127.0.0.1', port: p, method: 'POST', path: '/tts', headers: { host: `127.0.0.1:${p}`, 'content-type': 'application/json', 'x-luke-key': WINDOW } }, res => {
        const parts = []
        res.on('data', c => parts.push(c))
        res.on('end', () => resolve(Buffer.concat(parts)))
      })
      req.on('error', reject)
      req.end(JSON.stringify(body))
    })
  try {
    // First in a line (nothing plays before it): said live, with Ceci's seed, at once.
    assert.ok((await say({ text: 'Faço o commit agora?', budget: 0 })).equals(flat))
    assert.deepEqual(seeds.splice(0), [7])
    // After a line that still plays for 3 s: more takes, until one rises.
    assert.ok((await say({ text: 'Posso começar?', budget: 3000 })).equals(rising))
    assert.deepEqual(seeds.splice(0), [101, 102])
    // Next time it is served from the kept takes, with no wait and no engine work.
    assert.ok((await say({ text: 'Posso começar?', budget: 0 })).equals(rising))
    assert.deepEqual(seeds.splice(0), [])
    // A question with a question word falls in pt-BR: said once, live.
    await say({ text: 'O que vamos fazer hoje?', budget: 3000 })
    assert.deepEqual(seeds.splice(0), [7])
    // ?voice-question=0 in the window.
    await say({ text: 'Tudo bem?', budget: 3000, pick: false })
    assert.deepEqual(seeds.splice(0), [7])
  } finally {
    hub2.closeAllConnections()
    hub2.close()
    fake.close()
  }
})

test('when the window hangs up mid-sentence (barge-in), the generation on the engine is stopped', async () => {
  let isUpstreamClosed = false
  let onUpstreamClosed
  const upstreamClosed = new Promise(resolve => (onUpstreamClosed = resolve))
  const fake = createHttpServer(async (req, res) => {
    for await (const _ of req);
    res.on('close', () => {
      isUpstreamClosed = true
      onUpstreamClosed()
    })
    res.writeHead(200, { 'content-type': 'audio/wav' })
    // A long sentence: a frame every 50 ms, until the hub hangs up.
    const timer = setInterval(() => res.write(Buffer.alloc(64)), 50)
    res.on('close', () => clearInterval(timer))
  })
  await new Promise(resolve => fake.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${fake.address().port}`
  const engine = { url: () => base, status: () => ({ tts: true, asr: true, router: false }) }
  const hub2 = createHub({ serviceToken: SERVICE, windowKey: WINDOW, open: () => {}, engine, voiceRef: voiceRefFile(), profile: () => ({ profile: 'gpu' }) })
  await new Promise(resolve => hub2.listen(0, '127.0.0.1', resolve))
  const p = hub2.address().port
  try {
    await new Promise((resolve, reject) => {
      const req = request({ host: '127.0.0.1', port: p, method: 'POST', path: '/tts', headers: { host: `127.0.0.1:${p}`, 'content-type': 'application/json', 'x-luke-key': WINDOW } }, res => {
        // The first audio arrives, then the user talks over Ceci and the window aborts.
        res.once('data', () => {
          req.destroy()
          resolve()
        })
      })
      req.on('error', () => {})
      req.end(JSON.stringify({ text: 'Uma frase longa que a Ceci ainda estava dizendo quando foi interrompida.' }))
      setTimeout(() => reject(new Error('no audio')), 3000)
    })
    await Promise.race([upstreamClosed, new Promise(resolve => setTimeout(resolve, 2000))])
    assert.equal(isUpstreamClosed, true, 'the engine kept generating after the window hung up')
  } finally {
    hub2.closeAllConnections()
    hub2.close()
    fake.closeAllConnections()
    fake.close()
  }
})

test('small talk is routed on the native router; with no router, everything goes to the brain', async () => {
  const fake = createHttpServer(async (req, res) => {
    const chunks = []
    for await (const c of req) chunks.push(c)
    const { messages } = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    const intent = messages.at(-1).content === 'valeu!' ? 'thanks' : 'claude'
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ intent }) } }] }))
  })
  await new Promise(resolve => fake.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${fake.address().port}`
  const engine = { url: name => (name === 'router' ? base : null), status: () => ({ router: true }) }
  const hub4 = createHub({ serviceToken: SERVICE, windowKey: WINDOW, open: () => {}, engine })
  await new Promise(resolve => hub4.listen(0, '127.0.0.1', resolve))
  const routeAt = (p, text) =>
    new Promise((resolve, reject) => {
      const req = request({ host: '127.0.0.1', port: p, method: 'POST', path: '/route', headers: { host: `127.0.0.1:${p}`, 'x-luke-key': WINDOW, 'content-type': 'application/json' } }, res => {
        let out = ''
        res.on('data', c => (out += c))
        res.on('end', () => resolve(JSON.parse(out)))
      })
      req.on('error', reject)
      req.end(JSON.stringify({ text }))
    })
  try {
    const thanks = await routeAt(hub4.address().port, 'valeu!')
    assert.equal(thanks.intent, 'thanks')
    assert.ok(thanks.say)
    assert.deepEqual([(await routeAt(hub4.address().port, 'roda os testes')).intent], ['claude'])
    // The default hub has no engine: the brain decides.
    assert.equal((await routeAt(port, 'valeu!')).intent, 'claude')
  } finally {
    hub4.closeAllConnections()
    hub4.close()
    fake.close()
  }
})

test('/setup runs the hub setup for a subscribed session only', async () => {
  let asked = 0
  const hub5 = createHub({ serviceToken: SERVICE, windowKey: WINDOW, open: () => {}, onSetup: () => (asked++, { started: true }) })
  await new Promise(resolve => hub5.listen(0, '127.0.0.1', resolve))
  const p = hub5.address().port
  const post = (path, body, auth) =>
    new Promise((resolve, reject) => {
      const req = request({ host: '127.0.0.1', port: p, method: 'POST', path, headers: { host: `127.0.0.1:${p}`, 'content-type': 'application/json', authorization: `Bearer ${auth}` } }, res => {
        let out = ''
        res.on('data', c => (out += c))
        res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(out) }))
      })
      req.on('error', reject)
      req.end(JSON.stringify(body))
    })
  try {
    assert.equal((await post('/setup', {}, WINDOW)).status, 401)
    const { token } = (await post('/subscribe', { cwd: '/repos/api' }, SERVICE)).body
    assert.deepEqual(await post('/setup', {}, token), { status: 200, body: { started: true } })
    assert.equal(asked, 1)
  } finally {
    hub5.closeAllConnections()
    hub5.close()
  }
})

test('with no native engine, /stt and /tts answer 503 so the window keeps its own voice', async () => {
  const hub3 = createHub({ serviceToken: SERVICE, windowKey: WINDOW, open: () => {} })
  await new Promise(resolve => hub3.listen(0, '127.0.0.1', resolve))
  const p = hub3.address().port
  const status = path =>
    new Promise((resolve, reject) => {
      const req = request({ host: '127.0.0.1', port: p, method: 'POST', path, headers: { host: `127.0.0.1:${p}`, 'x-luke-key': WINDOW, 'content-type': 'application/json' } }, res => {
        res.resume()
        res.on('end', () => resolve(res.statusCode))
      })
      req.on('error', reject)
      req.end('{"text":"oi"}')
    })
  try {
    assert.equal(await status('/stt'), 503)
    assert.equal(await status('/tts'), 503)
  } finally {
    hub3.closeAllConnections()
    hub3.close()
  }
})

test('with a Mac Premium voice and no natural voice, /tts speaks with say and /config names the voice', async () => {
  const said = []
  let profileNow = { profile: 'light' }
  let genderNow = 'female'
  let siriNow = null
  const hub4 = createHub({
    serviceToken: SERVICE,
    windowKey: WINDOW,
    open: () => {},
    profile: () => profileNow,
    platform: 'darwin',
    macVoice: () => 'Luciana (Premium)',
    macVoiceGender: () => genderNow,
    macVoiceSiri: () => siriNow,
    macSay: async (voice, text) => (said.push([voice, text]), Buffer.from('RIFFfake')),
  })
  await new Promise(resolve => hub4.listen(0, '127.0.0.1', resolve))
  const p = hub4.address().port
  const call = (method, path, body) =>
    new Promise((resolve, reject) => {
      const req = request({ host: '127.0.0.1', port: p, method, path, headers: { host: `127.0.0.1:${p}`, 'x-luke-key': WINDOW, 'content-type': 'application/json', 'sec-fetch-site': 'same-origin' } }, res => {
        const chunks = []
        res.on('data', chunk => chunks.push(chunk))
        res.on('end', () => resolve({ status: res.statusCode, type: res.headers['content-type'], body: Buffer.concat(chunks).toString() }))
      })
      req.on('error', reject)
      req.end(body)
    })
  try {
    const tts = await call('POST', '/tts', '{"text":"Oi, eu sou a Ceci."}')
    assert.equal(tts.status, 200)
    assert.equal(tts.type, 'audio/wav')
    assert.deepEqual(said, [['Luciana (Premium)', 'Oi, eu sou a Ceci.']])
    assert.equal(JSON.parse((await call('GET', '/config')).body).macVoice, 'Luciana (Premium)')
    // A female Mac voice is Ceci; a male one is Luke, from the next call.
    assert.deepEqual(JSON.parse((await call('GET', '/config')).body).persona, { key: 'ceci', name: 'Ceci', gender: 'female' })
    genderNow = 'male'
    assert.deepEqual(JSON.parse((await call('GET', '/config')).body).persona, { key: 'luke', name: 'Luke', gender: 'male' })
    // Siri Voz 2 (sandra) is Nara.
    siriNow = 'sandra'
    genderNow = 'female'
    assert.deepEqual(JSON.parse((await call('GET', '/config')).body).persona, { key: 'nara', name: 'Nara', gender: 'female' })
    // The natural voice runs here: the Mac voice stays out of it.
    profileNow = { profile: 'gpu' }
    assert.equal(JSON.parse((await call('GET', '/config')).body).macVoice, null)
    // The natural voice is Ceci's own: no Luke, whatever the Mac's voice.
    assert.equal(JSON.parse((await call('GET', '/config')).body).persona.name, 'Ceci')
    assert.equal((await call('POST', '/tts', '{"text":"oi"}')).status, 503)
  } finally {
    hub4.closeAllConnections()
    hub4.close()
  }
})

test('off the Mac, the persona is always Ceci, even with a male voice reported', async () => {
  const hub5 = createHub({ serviceToken: SERVICE, windowKey: WINDOW, open: () => {}, profile: () => ({ profile: 'light' }), platform: 'win32', macVoice: () => 'system', macVoiceGender: () => 'male' })
  await new Promise(resolve => hub5.listen(0, '127.0.0.1', resolve))
  const p = hub5.address().port
  try {
    const body = await new Promise((resolve, reject) => {
      const req = request({ host: '127.0.0.1', port: p, method: 'GET', path: '/config', headers: { host: `127.0.0.1:${p}`, 'x-luke-key': WINDOW, 'sec-fetch-site': 'same-origin' } }, res => {
        const chunks = []
        res.on('data', chunk => chunks.push(chunk))
        res.on('end', () => resolve(JSON.parse(Buffer.concat(chunks).toString())))
      })
      req.on('error', reject)
      req.end()
    })
    assert.deepEqual(body.persona, { key: 'ceci', name: 'Ceci', gender: 'female' })
  } finally {
    hub5.closeAllConnections()
    hub5.close()
  }
})

test('loadSecrets keeps the window key across hub restarts', () => {
  const first = loadSecrets()
  const second = loadSecrets()
  assert.equal(second.windowKey, first.windowKey)
  assert.equal(second.serviceToken, first.serviceToken)
  assert.ok(first.windowKey.length > 0)
})

test('the engine is prepared again when it never was, misses a file, or LUKE_VOICE_PROFILE asks for the other profile', () => {
  const ready = () => true
  assert.equal(needsPrepare(null, { isReady: ready }), true)
  assert.equal(needsPrepare({ profile: 'gpu' }, { isReady: () => false }), true)
  assert.equal(needsPrepare({ profile: 'gpu' }, { isReady: ready }), false)
  assert.equal(needsPrepare({ profile: 'gpu' }, { isReady: ready, override: 'light' }), true)
  assert.equal(needsPrepare({ profile: 'light' }, { isReady: ready, override: 'gpu' }), true)
  assert.equal(needsPrepare({ profile: 'light' }, { isReady: ready, override: 'light' }), false)
  assert.equal(needsPrepare({ profile: 'gpu' }, { isReady: ready, override: 'turbo' }), false)
})

test('a setup over an engine start still running supersedes it: the old run starts no server and writes no state', async () => {
  const prepares = []
  const started = []
  const downloads = []
  let stops = 0
  let up = { tts: false, asr: false }
  const engine = { start: async (_names, { exe }) => (started.push(exe), (up = { tts: true, asr: true })), warm: async () => {}, stop: () => stops++, status: () => up }
  const prepare = options =>
    new Promise((resolve, reject) => prepares.push({ resolve, reject, onProgress: options.onProgress }))
  const runner = createEngineRunner({ engine, setDownload: next => downloads.push(next), read: () => null, prepare, isReady: () => false, env: {}, voice: 'missing.wav' })
  const settle = () => new Promise(resolve => setTimeout(resolve, 20))

  runner.startOnce()
  await settle()
  assert.equal(runner.state(), 'starting')
  assert.deepEqual(runner.setup(), { started: true })
  assert.equal(stops, 1)
  await settle()
  assert.equal(prepares.length, 2)

  // The old run ends after setup began, either way: nothing of it lands.
  const before = downloads.length
  prepares[0].onProgress(5, 10, 'old')
  prepares[0].reject(new Error('old run failed'))
  await settle()
  assert.equal(downloads.length, before, 'no progress or error from the old run')
  assert.equal(runner.state(), 'starting')
  runner.startOnce()
  await settle()
  assert.equal(prepares.length, 2, 'the setup run is still the one in flight')

  prepares[1].resolve({ profile: 'gpu', exe: 'new' })
  await settle()
  assert.deepEqual(started, ['new'])
  assert.equal(runner.state(), 'ready')
})

test('an engine start that resolves after a setup superseded it starts nothing', async () => {
  const prepares = []
  const started = []
  const engine = { start: async (_names, { exe }) => started.push(exe), warm: async () => {}, stop: () => {}, status: () => ({ tts: true, asr: true }) }
  const prepare = () => new Promise(resolve => prepares.push(resolve))
  const runner = createEngineRunner({ engine, setDownload: () => {}, read: () => null, prepare, isReady: () => false, env: {}, voice: 'missing.wav' })
  const settle = () => new Promise(resolve => setTimeout(resolve, 20))
  runner.startOnce()
  await settle()
  runner.setup()
  await settle()
  prepares[0]({ profile: 'gpu', exe: 'old' })
  await settle()
  assert.deepEqual(started, [], 'the old exe is never started')
  prepares[1]({ profile: 'gpu', exe: 'new' })
  await settle()
  assert.deepEqual(started, ['new'])
})

test('without Chrome, the default browser gets the whole URL (on Windows not through cmd, which cuts it at "&")', () => {
  const url = 'http://127.0.0.1:4860/?n=abc&call=1'
  const [cmd, args] = windowCommand(url, { chrome: null, platform: 'win32' })
  assert.equal(cmd, 'rundll32')
  assert.deepEqual(args, ['url.dll,FileProtocolHandler', url])
  assert.deepEqual(windowCommand(url, { chrome: null, platform: 'darwin' }), ['open', [url]])
  assert.deepEqual(windowCommand(url, { chrome: null, platform: 'linux', wsl: false }), ['xdg-open', [url]])
  assert.equal(windowCommand(url, { chrome: 'C:/chrome.exe', platform: 'win32', profile: 'P' })[1][0], `--app=${url}`)
})

test('the app window opens in Chrome, else Chromium, else Edge: on Windows, snap and flatpak on Linux, ~/Applications on a Mac', () => {
  const only = path => candidate => candidate === path
  const winEnv = { PROGRAMFILES: 'C:\\Program Files', 'PROGRAMFILES(X86)': 'C:\\Program Files (x86)', LOCALAPPDATA: 'C:\\Users\\ana\\AppData\\Local' }
  const edge = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
  const chrome = 'C:\\Users\\ana\\AppData\\Local\\Google\\Chrome\\Application\\chrome.exe'
  assert.equal(chromePath({ platform: 'win32', env: winEnv, exists: only(edge) }), edge)
  assert.equal(chromePath({ platform: 'win32', env: winEnv, exists: p => p === edge || p === chrome }), chrome)
  for (const path of ['/usr/bin/chromium-browser', '/snap/bin/chromium', '/var/lib/flatpak/exports/bin/com.google.Chrome', '/home/ana/.local/share/flatpak/exports/bin/org.chromium.Chromium']) {
    assert.equal(chromePath({ platform: 'linux', home: '/home/ana', exists: only(path) }), path)
  }
  assert.equal(chromePath({ platform: 'darwin', home: '/Users/ana', exists: only('/Users/ana/Applications/Google Chrome.app/Contents/MacOS/Google Chrome') }), '/Users/ana/Applications/Google Chrome.app/Contents/MacOS/Google Chrome')
  assert.equal(chromePath({ platform: 'linux', home: '/home/ana', exists: () => false }), null)
  assert.equal(browserCandidates({ platform: 'linux', home: '/home/ana' })[0], '/usr/bin/google-chrome')
  // The same --app flags for every one of them.
  assert.equal(windowCommand('http://x/?n=1', { chrome: edge, platform: 'win32', profile: 'P' })[1][0], '--app=http://x/?n=1')
})

test('in WSL the call opens in Windows\' browser: wslview when there, else rundll32.exe, with the whole URL', () => {
  const url = 'http://127.0.0.1:4848/?n=abc&call=1'
  assert.equal(isWsl({ platform: 'linux', read: () => 'Linux version 5.15.153.1-microsoft-standard-WSL2' }), true)
  assert.equal(isWsl({ platform: 'linux', read: () => 'Linux version 6.8.0-45-generic (buildd@lcy02)' }), false)
  assert.equal(isWsl({ platform: 'linux', read: () => { throw new Error('ENOENT') } }), false)
  assert.equal(isWsl({ platform: 'win32', read: () => 'microsoft' }), false)
  assert.deepEqual(windowCommand(url, { platform: 'linux', wsl: true, has: name => name === 'wslview' }), ['wslview', [url]])
  assert.deepEqual(windowCommand(url, { platform: 'linux', wsl: true, has: () => false }), ['rundll32.exe', ['url.dll,FileProtocolHandler', url]])
})

test('opening the window says whether it opened: an opener that fails or exits with an error is not "opening"', async () => {
  const quiet = () => {}
  assert.equal(await openWindow('http://x/', { command: [process.execPath, ['-e', 'process.exit(3)']], log: quiet }), false)
  assert.equal(await openWindow('http://x/', { command: [process.execPath, ['-e', 'process.exit(0)']], log: quiet }), true)
  assert.equal(await openWindow('http://x/', { command: ['luke-voice-no-such-browser', []], log: quiet }), false)
})

test('when the window cannot be opened, show tells the mod and gives it the address to open by hand', async () => {
  let now = 1_000_000
  const hub5 = createHub({ serviceToken: SERVICE, windowKey: WINDOW, open: async () => false, clock: () => now })
  await new Promise(resolve => hub5.listen(0, '127.0.0.1', resolve))
  const saved = port
  port = hub5.address().port
  try {
    const s = (await call('POST', '/subscribe', { auth: SERVICE, body: { cwd: '/repos/web' } })).body
    const shown = (await call('POST', '/show', { auth: s.token, body: { call: true } })).body
    assert.equal(shown.isOpened, false)
    assert.equal(shown.isWindowOpen, false)
    assert.match(shown.url, /[?&]n=[\w-]+&call=1$/)
    assert.ok(!shown.url.includes(WINDOW))
    // Opened by hand, maybe minutes later: its code lasts longer than two minutes, and works once.
    const nonce = /n=([\w-]+)/.exec(shown.url)[1]
    now += 10 * 60_000
    const traded = await call('POST', '/launch', { body: { nonce }, origin: `http://127.0.0.1:${port}` })
    assert.equal(traded.body.key, WINDOW)
    await call('POST', '/unsubscribe', { auth: s.token })
  } finally {
    port = saved
    hub5.closeAllConnections()
    hub5.close()
  }
})

test('with no program to open the window (no xdg-open), the hub keeps running and says why', async () => {
  const said = []
  openWindow('http://127.0.0.1:1/?n=x', { command: ['luke-voice-no-such-browser', []], log: line => said.push(line) })
  for (let i = 0; i < 100 && said.length === 0; i++) await new Promise(resolve => setTimeout(resolve, 20))
  assert.match(said[0] ?? '', /could not be opened: .*ENOENT/)
})

test('a mod that stops polling is dropped, even when its last long poll timed out or hung up', async () => {
  const hub4 = createHub({ serviceToken: SERVICE, windowKey: WINDOW, open: () => {}, staleMs: 300, sweepMs: 100 })
  await new Promise(resolve => hub4.listen(0, '127.0.0.1', resolve))
  const p = hub4.address().port
  const ask = (method, path, auth, { hangUpAfter } = {}) =>
    new Promise(resolve => {
      const req = request({ host: '127.0.0.1', port: p, method, path, headers: { host: `127.0.0.1:${p}`, 'content-type': 'application/json', ...(auth ? { authorization: `Bearer ${auth}` } : {}) } }, res => {
        let text = ''
        res.on('data', c => (text += c))
        res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(text) }))
      })
      req.on('error', () => resolve(null))
      if (hangUpAfter) setTimeout(() => (req.destroy(), resolve(null)), hangUpAfter)
      req.end(method === 'POST' ? JSON.stringify({ cwd: '/repos/gone', version: '0.10.1' }) : undefined)
    })
  const sessions = async () => (await ask('GET', '/health')).body.sessions
  const gone = async () => {
    for (let i = 0; i < 30 && (await sessions()) > 0; i++) await new Promise(resolve => setTimeout(resolve, 100))
    return (await sessions()) === 0
  }
  try {
    // The long poll times out with nothing to pull, then the Claude session closes.
    const timedOut = (await ask('POST', '/subscribe', SERVICE)).body
    assert.equal((await ask('GET', '/inbox?wait=150', timedOut.token)).status, 200)
    assert.equal(await gone(), true, 'a session whose long poll timed out was never swept')
    // The Claude session is killed in the middle of a long poll.
    const killed = (await ask('POST', '/subscribe', SERVICE)).body
    await ask('GET', '/inbox?wait=25000', killed.token, { hangUpAfter: 100 })
    assert.equal(await gone(), true, 'a session that hung up mid-poll was kept until its poll timed out')
  } finally {
    hub4.closeAllConnections()
    hub4.close()
  }
})

test("/tts never speaks without Ceci's voice reference and its transcript, and finds them once they are there", async () => {
  const seen = []
  const fake = createHttpServer(async (req, res) => {
    const chunks = []
    for await (const c of req) chunks.push(c)
    seen.push(JSON.parse(Buffer.concat(chunks).toString('utf8')))
    res.writeHead(200, { 'content-type': 'audio/wav' })
    res.end(Buffer.from('RIFF....WAVE'))
  })
  await new Promise(resolve => fake.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${fake.address().port}`
  const engine = { url: () => base, status: () => ({ tts: true, asr: true, router: false }) }
  const voiceRef = join(mkdtempSync(join(tmpdir(), 'luke-voice-ref-')), 'ceci.wav')
  const questionsDir = mkdtempSync(join(tmpdir(), 'luke-voice-questions-'))
  const hub5 = createHub({ serviceToken: SERVICE, windowKey: WINDOW, open: () => {}, engine, voiceRef, profile: () => ({ profile: 'gpu' }), questionsDir })
  await new Promise(resolve => hub5.listen(0, '127.0.0.1', resolve))
  const p = hub5.address().port
  const say = text =>
    new Promise((resolve, reject) => {
      const req = request({ host: '127.0.0.1', port: p, method: 'POST', path: '/tts', headers: { host: `127.0.0.1:${p}`, 'content-type': 'application/json', 'x-luke-key': WINDOW } }, res => {
        let body = ''
        res.on('data', c => (body += c))
        res.on('end', () => resolve({ status: res.statusCode, body }))
      })
      req.on('error', reject)
      req.end(JSON.stringify({ text }))
    })
  try {
    // Without the reference the engine would speak in another voice, with a European accent.
    const missing = await say('Comecei, te aviso quando terminar.')
    assert.equal(missing.status, 503)
    assert.match(JSON.parse(missing.body).error, /ceci-voice/)
    // The background takes of common questions wait for the reference too.
    hub5.warmQuestions()
    await new Promise(resolve => setTimeout(resolve, 100))
    // The clip without its transcript is not enough either.
    writeFileSync(voiceRef, 'CECIVOICE')
    assert.equal((await say('Comecei, te aviso quando terminar.')).status, 503)
    assert.equal(seen.length, 0, 'the engine was asked to speak without the reference')
    // Restored: found on the next line, without a hub restart.
    writeFileSync(voiceRef.replace(/[.]wav$/, '.txt'), 'Oi, eu sou a Ceci.')
    assert.equal((await say('Comecei, te aviso quando terminar.')).status, 200)
    assert.equal(Buffer.from(seen[0].speaker_ref_b64, 'base64').toString(), 'CECIVOICE')
    assert.equal(seen[0].speaker_ref_text, 'Oi, eu sou a Ceci.')
  } finally {
    hub5.closeAllConnections()
    hub5.close()
    fake.close()
  }
})

test('a truncated hub.json is replaced instead of failing every start', () => {
  const file = join(mkdtempSync(join(tmpdir(), 'luke-voice-secrets-')), 'hub.json')
  writeFileSync(file, '{"serviceToken": "abc')
  const secrets = loadSecrets(file)
  assert.ok(secrets.serviceToken && secrets.windowKey)
  assert.deepEqual(loadSecrets(file), secrets)
})

test('two hubs starting at once end up with the same secrets, so no mod is refused by the winner', async () => {
  const { spawn } = await import('node:child_process')
  const { pathToFileURL } = await import('node:url')
  const dir = mkdtempSync(join(tmpdir(), 'luke-voice-race-'))
  const file = join(dir, 'hub.json')
  const at = Date.now() + 1500
  // Each stand-in hub waits for the same instant, then loads (or creates) the secrets.
  const script = `import { loadSecrets } from ${JSON.stringify(pathToFileURL(join(import.meta.dirname, 'server.mjs')).href)}
while (Date.now() < ${at});
console.log(JSON.stringify(loadSecrets(${JSON.stringify(file)})))`
  const runs = Array.from({ length: 6 }, () =>
    new Promise(resolve => {
      const child = spawn(process.execPath, ['--input-type=module', '-e', script], { env: { ...process.env, LUKE_VOICE_HOME: dir }, stdio: ['ignore', 'pipe', 'inherit'] })
      let out = ''
      child.stdout.on('data', c => (out += c))
      child.on('exit', () => resolve(out.trim()))
    }),
  )
  const seen = await Promise.all(runs)
  const onDisk = JSON.stringify(JSON.parse(readFileSync(file, 'utf8')))
  for (const line of seen) assert.equal(line, onDisk)
})

test('a hung speech engine times /stt out, and a window that hangs up stops the transcription', async () => {
  const aborted = []
  const fake = createHttpServer((req, res) => {
    // Never answers; notes when the hub gives up on it.
    req.resume()
    res.on('close', () => aborted.push(req.url))
  })
  await new Promise(resolve => fake.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${fake.address().port}`
  const engine = { url: () => base, status: () => ({ tts: true, asr: true, router: false }) }
  const hub2 = createHub({ serviceToken: SERVICE, windowKey: WINDOW, open: () => {}, engine, profile: () => ({ profile: 'gpu' }), sttWaitMs: 300 })
  await new Promise(resolve => hub2.listen(0, '127.0.0.1', resolve))
  const p = hub2.address().port
  const stt = () => request({ host: '127.0.0.1', port: p, method: 'POST', path: '/stt', headers: { host: `127.0.0.1:${p}`, 'content-type': 'audio/wav', 'x-luke-key': WINDOW } })
  try {
    const timedOut = await new Promise((resolve, reject) => {
      const req = stt()
      req.on('response', res => (res.resume(), resolve(res.statusCode)))
      req.on('error', reject)
      req.end(Buffer.from('RIFFWAV'))
    })
    assert.equal(timedOut, 504)
    await new Promise(resolve => setTimeout(resolve, 100))
    assert.equal(aborted.length, 1, 'the engine request was dropped with it')
    // The window hangs up before the answer: the engine request is dropped at once, not at the timeout.
    const hub3 = createHub({ serviceToken: SERVICE, windowKey: WINDOW, open: () => {}, engine, profile: () => ({ profile: 'gpu' }), sttWaitMs: 60_000 })
    await new Promise(resolve => hub3.listen(0, '127.0.0.1', resolve))
    const q = hub3.address().port
    const req = request({ host: '127.0.0.1', port: q, method: 'POST', path: '/stt', headers: { host: `127.0.0.1:${q}`, 'content-type': 'audio/wav', 'x-luke-key': WINDOW } })
    req.on('error', () => {})
    req.end(Buffer.from('RIFFWAV'))
    await new Promise(resolve => setTimeout(resolve, 200))
    req.destroy()
    await new Promise(resolve => setTimeout(resolve, 200))
    assert.equal(aborted.length, 2)
    hub3.closeAllConnections()
    hub3.close()
  } finally {
    hub2.closeAllConnections()
    hub2.close()
    fake.closeAllConnections()
    fake.close()
  }
})

test('the /tts body is the same JSON as before, with the reference fragment made once', async () => {
  const { ttsBody } = await import('./server.mjs')
  const { VOICE_SETTINGS, maxFrames } = await import('./engine.mjs')
  const ref = { speaker_ref_b64: Buffer.from('CECIVOICE "aspas" \\ e ç').toString('base64'), speaker_ref_text: 'Oi, eu sou a "Ceci".\n' }
  const fragment = JSON.stringify(ref).slice(1, -1)
  for (const [text, seed] of [['Comecei, te aviso.', undefined], ['Posso? "sim"', 103]]) {
    const before = JSON.stringify({ input: text, lang: 'pt', stream: true, response_format: 'wav', ...VOICE_SETTINGS, ...(seed === undefined ? {} : { seed }), n_predict: maxFrames(text), ...ref })
    assert.equal(ttsBody(text, seed, fragment), before)
  }
})

test('a kept question take belongs to the voice model files by content, not only by name', async () => {
  const { voiceKey } = await import('./server.mjs')
  const { MODELS } = await import('./models.mjs')
  const { SERVICES } = await import('./engine.mjs')
  const key = voiceKey('UkVG', 'Oi.')
  for (const path of SERVICES.tts.models) assert.ok(key.includes(MODELS[path].sha256), path)
  const saved = MODELS[SERVICES.tts.models[0]].sha256
  try {
    MODELS[SERVICES.tts.models[0]].sha256 = '0'.repeat(64)
    assert.notEqual(voiceKey('UkVG', 'Oi.'), key)
  } finally {
    MODELS[SERVICES.tts.models[0]].sha256 = saved
  }
})
