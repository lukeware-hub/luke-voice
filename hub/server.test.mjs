import assert from 'node:assert/strict'
import { createServer as createHttpServer, request } from 'node:http'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, test } from 'node:test'

process.env.LUKE_VOICE_HOME = mkdtempSync(join(tmpdir(), 'luke-voice-test-'))
const { chromeArgs, createHub, loadSecrets } = await import('./server.mjs')

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

test('every external script on the page carries an integrity hash, and the page scripts import nothing remote', async () => {
  const page = (await call('GET', `/?k=${WINDOW}`)).body
  const external = [...page.matchAll(/<script\b[^>]*\bsrc="https?:\/\/[^"]*"[^>]*>/g)].map(m => m[0])
  assert.ok(external.length > 0)
  for (const tag of external) {
    assert.match(tag, /\bintegrity="sha(256|384|512)-[A-Za-z0-9+/=]+"/)
    assert.match(tag, /\bcrossorigin="anonymous"/)
  }
  for (const path of ['/app.js', '/guard.js', '/engines/elevenlabs.js', '/engines/local.js', '/engines/speech-text.js', '/engines/fast-path.js', '/engines/turn-join.js', '/engines/vad.js', '/engines/piper-ids.js', '/engines/mic-worklet.js', '/engines/voice-worker.js']) {
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
  const args = chromeArgs('http://127.0.0.1:4848/?k=x', '/home/u/.luke-voice/chrome')
  assert.ok(args.includes('--use-fake-ui-for-media-stream'))
  assert.ok(args.includes('--autoplay-policy=no-user-gesture-required'))
  assert.ok(args.includes('--user-data-dir=/home/u/.luke-voice/chrome'))
  assert.ok(args.includes('--app=http://127.0.0.1:4848/?k=x'))
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
  const served = createHub({
    serviceToken: SERVICE,
    windowKey: WINDOW,
    open: () => {},
    vendor: async path => (path === 'espeak/dist/version.mjs' ? Buffer.from('export const V = 1') : null),
    models: async path => (path === 'turn/silero-vad.onnx' ? modelFile : null),
  })
  await new Promise(resolve => served.listen(0, '127.0.0.1', resolve))
  const p = served.address().port
  const fetchRaw = path =>
    new Promise((resolve, reject) => {
      const req = request({ host: '127.0.0.1', port: p, path, headers: { host: `127.0.0.1:${p}` } }, res => {
        let text = ''
        res.on('data', chunk => (text += chunk))
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text }))
      })
      req.on('error', reject)
      req.end()
    })
  try {
    const file = await fetchRaw('/vendor/espeak/dist/version.mjs')
    assert.equal(file.status, 200)
    assert.equal(file.text, 'export const V = 1')
    assert.equal(file.headers['content-type'], 'text/javascript; charset=utf-8')
    assert.equal((await fetchRaw('/vendor/../../hub.json')).status, 404)
    const model = await fetchRaw('/models/turn/silero-vad.onnx')
    assert.equal(model.status, 200)
    assert.equal(model.text, 'ONNXBYTES')
    assert.equal(model.headers['content-length'], '9')
    assert.equal((await fetchRaw('/models/nope.onnx')).status, 404)
    const page = await fetchRaw(`/?k=${WINDOW}`)
    assert.equal(page.headers['cross-origin-opener-policy'], 'same-origin')
    assert.equal(page.headers['cross-origin-embedder-policy'], 'credentialless')
    assert.equal((await fetchRaw('/engines/voice-worker.js')).headers['cross-origin-embedder-policy'], 'credentialless')
  } finally {
    served.closeAllConnections()
    served.close()
  }
})

test('the brain turn goes to the focused session as a think command, and its JSON reply comes back', async () => {
  const s1 = (await call('POST', '/subscribe', { auth: SERVICE, body: { cwd: '/repos/brainy' } })).body
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
    assert.deepEqual([seen.tts.temperature, seen.tts.top_p, seen.tts.seed], [0.75, 0.9, 7])
    assert.equal(seen.tts.n_predict, Math.ceil('Comecei, te aviso quando terminar.'.length * 1.5) + 25)
    assert.equal((await post('/tts', JSON.stringify({ text: '  ' }), 'application/json')).status, 400)
  } finally {
    hub2.closeAllConnections()
    hub2.close()
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

test('loadSecrets keeps the window key across hub restarts', () => {
  const first = loadSecrets()
  const second = loadSecrets()
  assert.equal(second.windowKey, first.windowKey)
  assert.equal(second.serviceToken, first.serviceToken)
  assert.ok(first.windowKey.length > 0)
})
