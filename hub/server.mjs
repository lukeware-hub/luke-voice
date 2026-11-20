// The luke-voice hub: one local process for every subscribed Claude session and one call window.
// It never calls Claude. It queues a command; the matching session's mod pulls it and runs it.
import { spawn } from 'node:child_process'
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { createReadStream, existsSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { conversationToken, credits, ensureAgent, outOfCreditsMessage } from './agent.mjs'
import { PORT, stateDir, stateFile } from './paths.mjs'
import { VOICE_SETTINGS, createEngine, maxFrames, prepareEngine, profileReady, readProfile } from './engine.mjs'
import { ensureModel } from './models.mjs'
import { route as routeUtterance } from './router.mjs'
import { contentType, vendorFile } from './vendor.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const VERSION = JSON.parse(readFileSync(join(ROOT, '.claude-plugin', 'plugin.json'), 'utf8')).version
const MAX_BODY = 64 * 1024
// One utterance as 16 kHz PCM16 WAV: 30 s is under 1 MB.
const MAX_AUDIO = 4 * 1024 * 1024
// What Qwen3-ASR is told, so English tech words and session names come out right.
const ASR_GLOSSARY = 'Conversa em português do Brasil com a Ceci, uma assistente de programação. Termos comuns: API, commit, branch, main, deploy, build, bug, pull request, GitHub, Claude, Ceci, lint, TypeScript, token, login, checkout, README.'
const MAX_ACTIVITY = 60
const ACK_WAIT_MS = 15_000
// The router answers in ~0.3 s; past this, the utterance goes to the brain instead.
const ROUTER_WAIT_MS = 1500
// A brain turn is one short Claude Haiku call (~2.5 s); a cold start can take longer.
const BRAIN_WAIT_MS = 40_000
const NO_SESSION_SAY = 'Nenhuma sessão do Claude está ligada. Ligue o luke-voice no Claude Code e me chame de novo.'
const STALE_SESSION_MS = 90_000

const STATIC = {
  '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
  '/guard.js': ['guard.js', 'text/javascript; charset=utf-8'],
  '/engines/elevenlabs.js': ['engines/elevenlabs.js', 'text/javascript; charset=utf-8'],
  '/engines/local.js': ['engines/local.js', 'text/javascript; charset=utf-8'],
  '/engines/speech-text.js': ['engines/speech-text.js', 'text/javascript; charset=utf-8'],
  '/engines/fast-path.js': ['engines/fast-path.js', 'text/javascript; charset=utf-8'],
  '/engines/turn-join.js': ['engines/turn-join.js', 'text/javascript; charset=utf-8'],
  '/engines/vad.js': ['engines/vad.js', 'text/javascript; charset=utf-8'],
  '/engines/piper-ids.js': ['engines/piper-ids.js', 'text/javascript; charset=utf-8'],
  '/engines/mic-worklet.js': ['engines/mic-worklet.js', 'text/javascript; charset=utf-8'],
  '/engines/voice-worker.js': ['engines/voice-worker.js', 'text/javascript; charset=utf-8'],
  '/style.css': ['style.css', 'text/css; charset=utf-8'],
  '/fonts/schibsted-grotesk-latin-wght-normal.woff2': ['fonts/schibsted-grotesk-latin-wght-normal.woff2', 'font/woff2'],
  '/fonts/schibsted-grotesk-latin-ext-wght-normal.woff2': ['fonts/schibsted-grotesk-latin-ext-wght-normal.woff2', 'font/woff2'],
}

// Cross-origin isolation gives the local voice SharedArrayBuffer, so its WASM runs on several threads.
// credentialless still lets the page load the pinned CDN script and the Hugging Face model files.
const ISOLATION = {
  'cross-origin-opener-policy': 'same-origin',
  'cross-origin-embedder-policy': 'credentialless',
  'cross-origin-resource-policy': 'same-origin',
}
const PROVIDERS = ['local', 'elevenlabs']

const newSecret = () => randomBytes(24).toString('base64url')
// A short, one-way tag of the key so health can show which key is in use without exposing it.
const keyId = key => (key ? createHash('sha256').update(key).digest('hex').slice(0, 8) : null)

function sameSecret(given, expected) {
  if (typeof given !== 'string' || !expected) return false
  const a = Buffer.from(given)
  const b = Buffer.from(expected)
  return a.length === b.length && timingSafeEqual(a, b)
}

export function loadSecrets() {
  const file = stateFile('hub.json')
  const saved = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {}
  // The window key survives a hub restart: an open window keeps working instead of failing with "key".
  const secrets = { serviceToken: saved.serviceToken || newSecret(), windowKey: saved.windowKey || newSecret() }
  writeFileSync(file, JSON.stringify(secrets, null, 2), { mode: 0o600 })
  return secrets
}

function chromePath() {
  const candidates =
    process.platform === 'win32'
      ? [process.env.PROGRAMFILES, process.env['PROGRAMFILES(X86)'], process.env.LOCALAPPDATA]
          .filter(Boolean)
          .map(base => join(base, 'Google', 'Chrome', 'Application', 'chrome.exe'))
      : process.platform === 'darwin'
        ? ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome']
        : ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium']
  return candidates.find(path => existsSync(path)) ?? null
}

// The Chrome app window runs in a profile of its own that only ever loads this page, so it can
// allow the microphone and play the agent's voice without a prompt or a click.
export function chromeArgs(url, profile) {
  return [
    `--app=${url}`,
    `--user-data-dir=${profile}`,
    '--window-size=760,900',
    '--no-first-run',
    '--use-fake-ui-for-media-stream',
    '--autoplay-policy=no-user-gesture-required',
  ]
}

// A Chrome app window; else the default browser.
export function openWindow(url) {
  const chrome = chromePath()
  const [cmd, args] = chrome
    ? [chrome, chromeArgs(url, join(stateDir(), 'chrome'))]
    : process.platform === 'win32'
      ? ['cmd', ['/c', 'start', '', url]]
      : [process.platform === 'darwin' ? 'open' : 'xdg-open', [url]]
  // windowsHide only for cmd: Chrome opens its first window with the hidden show flag it is given.
  spawn(cmd, args, { detached: true, stdio: 'ignore', windowsHide: cmd === 'cmd' }).unref()
}

export function createHub({ serviceToken, windowKey, apiKey = '', provider = '', root = ROOT, open = openWindow, vendor = vendorFile, models = ensureModel, engine = null, profile = () => null, voiceRef = null, onLocalVoice = () => {}, onSetup = () => ({ started: false }), engineState = () => 'off', log = () => {}, onShutdown = () => process.exit(0) }) {
  const sessions = new Map() // token -> session
  const replaced = new Set() // tokens a newer subscription of the same Claude session took over
  const streams = new Set() // window SSE responses
  const acks = new Map() // command id -> resolve
  let focused = null
  let call = 'idle'
  let key = apiKey
  let agentId = null
  let isKeyRejected = false // ElevenLabs answered 401 to the current key
  let lastBusy = Date.now()

  // The voice the window uses: the one chosen in Claude Code (config or /luke-voice voz), else
  // LUKE_VOICE_PROVIDER, else ElevenLabs while a key is set, else the free local voice.
  let chosen = ''
  // Set by the hub's main block while it prepares the native engine: { loaded, total, label, error }.
  let engineDownload = null
  const voiceProvider = () => (PROVIDERS.includes(chosen) ? chosen : PROVIDERS.includes(provider) ? provider : key ? 'elevenlabs' : 'local')

  const byName = name => [...sessions.values()].find(s => s.name === name)
  // A named session must exist: falling back to another one would run the work in the wrong place.
  const target = name => (name ? byName(name) : (byName(focused) ?? [...sessions.values()][0]))
  const missing = name =>
    sessions.size
      ? `No session is named "${name}". Open sessions: ${[...sessions.values()].map(s => s.name).join(', ')}.`
      : 'No Claude session is connected.'

  const roster = () =>
    [...sessions.values()].map(s => ({ name: s.name, cwd: s.cwd, isBusy: s.isBusy, needsYou: s.needsYou }))

  function broadcast(message) {
    const line = `data: ${JSON.stringify(message)}\n\n`
    for (const res of streams) res.write(line)
  }

  const sendRoster = () => broadcast({ type: 'roster', sessions: roster(), focused, call })

  function uniqueName(cwd) {
    const base = (basename(cwd || '') || 'session').toLowerCase().replace(/[^a-z0-9-]+/g, '-').slice(0, 24) || 'session'
    let name = base
    for (let n = 2; byName(name); n++) name = `${base}-${n}`
    return name
  }

  function wake(session) {
    const waiters = session.waiters.splice(0)
    for (const resolve of waiters) resolve()
  }

  function enqueue(session, command, wait = ACK_WAIT_MS) {
    const id = newSecret().slice(0, 12)
    session.inbox.push({ id, ...command })
    wake(session)
    return new Promise(resolve => {
      const timer = setTimeout(() => {
        acks.delete(id)
        resolve({ ok: false, message: `The ${session.name} session did not answer in time.` })
      }, wait)
      acks.set(id, result => {
        clearTimeout(timer)
        resolve(result)
      })
    })
  }

  function drop(session) {
    sessions.delete(session.token)
    wake(session)
    if (focused === session.name) focused = [...sessions.values()][0]?.name ?? null
    if (sessions.size === 0 && call !== 'idle') broadcast({ type: 'end' })
    sendRoster()
  }

  function activityText(session) {
    if (!session) return 'No Claude session is connected.'
    const lines = session.activity.map(a => `${a.kind}: ${a.text}`)
    return `[activity] session ${session.name} (${session.isBusy ? 'Claude is working' : 'Claude is idle'})\n${lines.join('\n') || 'Nothing yet.'}`
  }

  // Routes for a subscribed session's mod, by its session token.
  const sessionRoutes = {
    // /luke-voice setup: prepare the free voice again (download what is missing, pick the profile)
    // in the background; /luke-voice status shows the progress.
    'POST /setup': () => [200, onSetup()],
    'POST /events': (session, body) => {
      const events = Array.isArray(body.events) ? body.events.slice(0, 50) : []
      for (const event of events) {
        const item = { kind: String(event.kind ?? 'info').slice(0, 20), text: String(event.text ?? '').slice(0, 2000) }
        session.activity.push(item)
        if (item.kind === 'attention') session.needsYou = true
        if (item.kind === 'done' || item.kind === 'prompt') session.needsYou = false
      }
      session.activity.splice(0, Math.max(0, session.activity.length - MAX_ACTIVITY))
      if (typeof body.isBusy === 'boolean') session.isBusy = body.isBusy
      if (events.length) broadcast({ type: 'activity', session: session.name, events })
      sendRoster()
      return [200, { ok: true }]
    },
    'GET /inbox': async (session, _body, url) => {
      session.seenAt = Date.now()
      const wait = Math.min(Number(url.searchParams.get('wait') || 0), 25_000)
      if (session.inbox.length === 0 && wait > 0) {
        await new Promise(resolve => {
          const timer = setTimeout(resolve, wait)
          session.waiters.push(() => {
            clearTimeout(timer)
            resolve()
          })
        })
      }
      session.seenAt = Date.now()
      if (replaced.has(session.token)) return [409, { error: 'replaced' }]
      if (!sessions.has(session.token)) return [410, { error: 'unsubscribed' }]
      return [200, { commands: session.inbox.splice(0), call, isFocused: focused === session.name }]
    },
    'POST /ack': (_session, body) => {
      const resolve = acks.get(body.id)
      acks.delete(body.id)
      resolve?.({ ok: Boolean(body.ok), message: String(body.message ?? '') })
      return [200, { ok: true }]
    },
    'POST /show': (session, body) => {
      focused = session.name
      const startCall = Boolean(body.call)
      if (streams.size === 0) {
        open(`http://127.0.0.1:${PORT}/?k=${windowKey}${startCall ? '&call=1' : ''}`)
      } else {
        broadcast({ type: 'focus', name: session.name, startCall })
      }
      sendRoster()
      return [200, { ok: true, isWindowOpen: streams.size > 0 }]
    },
    'POST /end': () => {
      broadcast({ type: 'end' })
      return [200, { ok: true }]
    },
    // /luke-voice voz: switches the voice for the next call.
    'POST /provider': (_session, body) => {
      if (!PROVIDERS.includes(body.provider)) return [400, { ok: false, message: 'Unknown voice.' }]
      chosen = body.provider
      log(`voice set to ${chosen}`)
      return [200, { ok: true, provider: voiceProvider(), hasKey: Boolean(key) }]
    },
    'POST /unsubscribe': session => {
      drop(session)
      return [200, { ok: true }]
    },
  }

  // Routes for the call window, by the window key.
  const windowRoutes = {
    'POST /token': async () => {
      if (!key) return [409, { error: 'Falta a chave da ElevenLabs. Salve com /plugin configure luke-voice@luke-voice e reinicie o Claude Code, ou use a voz gratuita: /luke-voice voz local.' }]
      try {
        agentId ??= await ensureAgent(key, root, { log })
        // With no credits left, ElevenLabs accepts the call and drops it at once: say why instead.
        const left = await credits(key)
        if (left && left.limit > 0 && left.used >= left.limit) return [402, { error: outOfCreditsMessage(left) }]
        const token = await conversationToken(key, agentId)
        isKeyRejected = false
        return [200, { token }]
      } catch (error) {
        agentId = null
        if (error.status === 401) {
          isKeyRejected = true
          return [401, { error: 'A ElevenLabs recusou a chave salva. Crie uma chave nova em elevenlabs.io/app/settings/api-keys, salve com /plugin configure luke-voice@luke-voice e reinicie o Claude Code.' }]
        }
        return [502, { error: String(error.message ?? error) }]
      }
    },
    'POST /command': async (_none, body) => {
      const session = target(body.session)
      if (!session) return [404, { ok: false, message: missing(body.session) }]
      if (body.type === 'send') {
        const prompt = String(body.prompt ?? '').trim()
        if (!prompt) return [400, { ok: false, message: 'The prompt is empty.' }]
        const when = body.when === 'after_current' ? 'after_current' : 'now'
        return [200, await enqueue(session, { type: 'send', prompt: prompt.slice(0, 8000), when })]
      }
      if (body.type === 'task') {
        const task = String(body.task ?? '').trim()
        if (!task) return [400, { ok: false, message: 'The task is empty.' }]
        return [200, await enqueue(session, { type: 'task', task: task.slice(0, 8000) })]
      }
      if (body.type === 'stop') return [200, await enqueue(session, { type: 'stop' })]
      return [400, { ok: false, message: 'Unknown command.' }]
    },
    'GET /config': () => {
      const provider = voiceProvider()
      // The free voice is about to be used: get the native engine ready (once; it is a no-op after).
      if (provider === 'local') onLocalVoice()
      return [200, { provider, profile: profile()?.profile ?? null, engine: engineState(), native: engine ? engine.status() : {}, download: engineDownload }]
    },
    // The native engine: the profile chosen for this machine, which servers are up, the download.
    'GET /engine': () => [200, { profile: profile(), native: engine ? engine.status() : {}, download: engineDownload }],
    // The local voice's brain: the focused session's mod asks Claude Haiku and answers { say, tool }.
    'POST /brain': async (_none, body) => {
      const session = target()
      if (!session) return [200, { say: NO_SESSION_SAY, tool: null }]
      const clip = (value, max) => String(value ?? '').slice(0, max)
      const request = {
        kind: ['user', 'notice', 'tool_result'].includes(body.kind) ? body.kind : 'user',
        text: clip(body.text, 4000),
        context: (Array.isArray(body.context) ? body.context : []).slice(-8).map(c => clip(c, 1500)),
        turns: (Array.isArray(body.turns) ? body.turns : []).slice(-12).map(t => ({ role: t?.role === 'luke' ? 'luke' : 'user', text: clip(t?.text, 500) })),
        sessions: roster(),
        focused,
      }
      const result = await enqueue(session, { type: 'think', request }, BRAIN_WAIT_MS)
      if (!result.ok) return [502, { error: result.message }]
      try {
        const reply = JSON.parse(result.message)
        return [200, { say: String(reply.say ?? ''), tool: reply.tool ?? null, pending: reply.pending ?? null }]
      } catch {
        return [502, { error: 'The brain answered something that is not JSON.' }]
      }
    },
    // The instant layer of the hybrid brain (gpu profile): small talk answered on this machine in
    // ~0.3 s, with words written in hub/router.mjs. { intent: 'claude', say: null } sends the
    // utterance to the brain, as when the router is not running.
    'POST /route': async (_none, body) => {
      const url = engine?.url('router')
      if (!url) return [200, { intent: 'claude', say: null }]
      const ask = async chat => {
        const answer = await fetch(`${url}/v1/chat/completions`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(chat), signal: AbortSignal.timeout(ROUTER_WAIT_MS) })
        if (!answer.ok) throw new Error(`router ${answer.status}`)
        return answer.json()
      }
      const started = Date.now()
      const result = await routeUtterance(String(body.text ?? '').slice(0, 500), { ask, lastSaid: String(body.lastSaid ?? '').slice(-500) })
      return [200, { ...result, ms: Date.now() - started }]
    },
    'GET /activity': (_none, _body, url) => {
      const name = url.searchParams.get('session')
      const session = target(name)
      return [200, { text: session ? activityText(session) : missing(name) }]
    },
    'POST /call': (_none, body) => {
      call = ['idle', 'connecting', 'live', 'error'].includes(body.state) ? body.state : 'idle'
      sendRoster()
      return [200, { ok: true }]
    },
    'POST /focus': (_none, body) => {
      if (byName(body.name)) focused = body.name
      sendRoster()
      return [200, { ok: true }]
    },
  }

  async function readRaw(req, limit) {
    let size = 0
    const chunks = []
    for await (const chunk of req) {
      size += chunk.length
      if (size > limit) throw Object.assign(new Error('body too large'), { status: 413 })
      chunks.push(chunk)
    }
    return Buffer.concat(chunks)
  }

  // Speech to text on the native engine (Qwen3-ASR): a WAV in, { text } out.
  async function nativeStt(req, res) {
    const url = engine?.url('asr')
    if (!url) return send(res, 503, { error: 'The native speech engine is not running.' })
    const wav = await readRaw(req, MAX_AUDIO)
    const names = [...sessions.values()].map(s => s.name).join(', ')
    const form = new FormData()
    form.append('file', new Blob([wav], { type: 'audio/wav' }), 'speech.wav')
    form.append('model', 'qwen3-asr')
    form.append('language', 'pt')
    form.append('prompt', names ? `${ASR_GLOSSARY} Sessões: ${names}.` : ASR_GLOSSARY)
    const started = Date.now()
    const answer = await fetch(`${url}/v1/audio/transcriptions`, { method: 'POST', body: form })
    if (!answer.ok) return send(res, 502, { error: `speech engine ${answer.status}` })
    const { text = '' } = await answer.json()
    // Qwen3-ASR starts its text with "language Portuguese<asr_text>".
    return send(res, 200, { text: String(text).replace(/^[\s\S]*<asr_text>/, '').trim(), ms: Date.now() - started })
  }

  // Ceci's voice on the native engine (Qwen3-TTS), streamed as WAV while it is made.
  let voiceRefB64 = null
  let voiceRefText = null
  async function nativeTts(req, res) {
    const url = engine?.url('tts')
    if (!url) return send(res, 503, { error: 'The native voice engine is not running.' })
    const body = await readBody(req)
    const text = String(body.text ?? '').slice(0, 2000).trim()
    if (!text) return send(res, 400, { error: 'Nothing to say.' })
    voiceRefB64 ??= voiceRef && existsSync(voiceRef) ? readFileSync(voiceRef).toString('base64') : ''
    // The transcript of the reference: with it, llama.cpp clones Ceci from the reference codes (ICL).
    voiceRefText ??= voiceRef && existsSync(voiceRef.replace(/\.wav$/, '.txt')) ? readFileSync(voiceRef.replace(/\.wav$/, '.txt'), 'utf8').trim() : ''
    const stop = new AbortController()
    req.on('close', () => stop.abort())
    // /tts streams with stream:true (on /v1/audio/speech it would need stream_format).
    const upstream = await fetch(`${url}/tts`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        input: text,
        lang: 'pt',
        stream: true,
        response_format: 'wav',
        ...VOICE_SETTINGS,
        n_predict: maxFrames(text),
        ...(voiceRefB64 ? { speaker_ref_b64: voiceRefB64, ...(voiceRefText ? { speaker_ref_text: voiceRefText } : {}) } : {}),
      }),
      signal: stop.signal,
    }).catch(() => null)
    if (!upstream?.ok || !upstream.body) return send(res, 502, { error: `voice engine ${upstream?.status ?? 'unreachable'}` })
    res.writeHead(200, { 'content-type': 'audio/wav', 'cache-control': 'no-store' })
    try {
      for await (const chunk of upstream.body) res.write(chunk)
    } catch {
      // The window hung up (barge-in): the generation was aborted with it.
    }
    return res.end()
  }

  async function readBody(req) {
    let size = 0
    const chunks = []
    for await (const chunk of req) {
      size += chunk.length
      if (size > MAX_BODY) throw Object.assign(new Error('body too large'), { status: 413 })
      chunks.push(chunk)
    }
    const text = Buffer.concat(chunks).toString('utf8')
    return text ? JSON.parse(text) : {}
  }

  function send(res, status, body) {
    res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' })
    res.end(JSON.stringify(body))
  }

  const setEngineDownload = next => {
    engineDownload = next
  }

  const server = createServer(async (req, res) => {
    try {
      const port = server.address()?.port
      const hosts = [`127.0.0.1:${port}`, `localhost:${port}`]
      if (!hosts.includes(req.headers.host)) return send(res, 403, { error: 'host' })
      const origin = req.headers.origin
      if (origin && !hosts.some(host => origin === `http://${host}`)) return send(res, 403, { error: 'origin' })

      const url = new URL(req.url, `http://${req.headers.host}`)
      const route = `${req.method} ${url.pathname}`
      const bearer = (req.headers.authorization ?? '').replace(/^Bearer /, '')

      if (route === 'GET /health') {
        return send(res, 200, { app: 'luke-voice', version: VERSION, sessions: sessions.size, isWindowOpen: streams.size > 0, call, hasKey: Boolean(key), provider: voiceProvider(), keyStatus: !key ? 'missing' : isKeyRejected ? 'rejected' : 'set', keyId: keyId(key), profile: profile()?.profile ?? null, native: engine ? engine.status() : {}, download: engineDownload })
      }

      if (route === 'POST /subscribe') {
        if (!sameSecret(bearer, serviceToken)) return send(res, 401, { error: 'token' })
        const body = await readBody(req)
        const offered = typeof body.apiKey === 'string' ? body.apiKey.trim() : ''
        // The latest key saved in Claude Code wins, so a changed key works without waiting for the hub to exit.
        if (offered && offered !== key) {
          if (key) log('API key updated')
          key = offered
          isKeyRejected = false
          agentId = null
        }
        // Like the key, the latest voice chosen in Claude Code wins.
        if (PROVIDERS.includes(body.provider)) chosen = body.provider
        const token = newSecret()
        const sessionId = typeof body.sessionId === 'string' ? body.sessionId.slice(0, 200) : ''
        // A reloaded mod subscribes again from the same Claude session: it takes over the old row.
        const previous = sessionId ? [...sessions.values()].find(s => s.sessionId === sessionId) : undefined
        if (previous) {
          sessions.delete(previous.token)
          replaced.add(previous.token)
          wake(previous)
        }
        const session = { token, sessionId, name: previous?.name ?? uniqueName(body.cwd), cwd: String(body.cwd ?? ''), inbox: [], waiters: [], activity: [], isBusy: false, needsYou: false, seenAt: Date.now() }
        sessions.set(token, session)
        focused ??= session.name
        sendRoster()
        return send(res, 200, { token, name: session.name, hasKey: Boolean(key), provider: voiceProvider() })
      }

      if (route === 'POST /shutdown') {
        if (!sameSecret(bearer, serviceToken)) return send(res, 401, { error: 'token' })
        broadcast({ type: 'end' })
        send(res, 200, { ok: true })
        setTimeout(onShutdown, 100)
        return
      }

      if (sessionRoutes[route]) {
        const session = sessions.get(bearer)
        if (!session) return send(res, replaced.has(bearer) ? 409 : 401, { error: replaced.has(bearer) ? 'replaced' : 'session' })
        const body = req.method === 'POST' ? await readBody(req) : {}
        const [status, out] = await sessionRoutes[route](session, body, url)
        return send(res, status, out)
      }

      if (route === 'GET /') {
        if (!sameSecret(url.searchParams.get('k'), windowKey)) return send(res, 403, { error: 'key' })
        const page = readFileSync(join(root, 'window', 'index.html'))
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', ...ISOLATION })
        return res.end(page)
      }

      if (req.method === 'GET' && STATIC[url.pathname]) {
        const [file, type] = STATIC[url.pathname]
        const content = readFileSync(join(root, 'window', file))
        res.writeHead(200, { 'content-type': type, 'cache-control': 'no-store', ...ISOLATION })
        return res.end(content)
      }

      if (req.method === 'GET' && url.pathname.startsWith('/vendor/')) {
        const path = url.pathname.slice('/vendor/'.length)
        const content = await vendor(path)
        if (!content) return send(res, 404, { error: 'not found' })
        // Pinned by hash: the bytes for a path never change, so the browser may keep them.
        res.writeHead(200, { 'content-type': contentType(path), 'cache-control': 'public, max-age=31536000, immutable', ...ISOLATION })
        return res.end(content)
      }

      // Voice model files, verified by sha256 (hub/models.mjs); downloaded here if setup did not.
      if (req.method === 'GET' && url.pathname.startsWith('/models/')) {
        const path = url.pathname.slice('/models/'.length)
        const file = await models(path)
        if (!file) return send(res, 404, { error: 'not found' })
        res.writeHead(200, {
          'content-type': 'application/octet-stream',
          'content-length': String(statSync(file).size),
          'cache-control': 'public, max-age=31536000, immutable',
          ...ISOLATION,
        })
        return createReadStream(file).pipe(res)
      }

      if (route === 'GET /stream') {
        if (!sameSecret(url.searchParams.get('k'), windowKey)) return send(res, 403, { error: 'key' })
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' })
        streams.add(res)
        res.write(`data: ${JSON.stringify({ type: 'roster', sessions: roster(), focused, call })}\n\n`)
        const ping = setInterval(() => res.write(': ping\n\n'), 20_000)
        req.on('close', () => {
          clearInterval(ping)
          streams.delete(res)
          if (streams.size === 0) call = 'idle'
        })
        return
      }

      if (route === 'POST /stt' || route === 'POST /tts') {
        if (!sameSecret(req.headers['x-luke-key'], windowKey)) return send(res, 401, { error: 'key' })
        return route === 'POST /stt' ? await nativeStt(req, res) : await nativeTts(req, res)
      }

      if (windowRoutes[route]) {
        if (!sameSecret(req.headers['x-luke-key'], windowKey)) return send(res, 401, { error: 'key' })
        const body = req.method === 'POST' ? await readBody(req) : {}
        const [status, out] = await windowRoutes[route](null, body, url)
        return send(res, status, out)
      }

      send(res, 404, { error: 'not found' })
    } catch (error) {
      if (res.headersSent) res.end()
      else send(res, error.status ?? 500, { error: String(error.message ?? error) })
    }
  })

  // Drops sessions whose mod stopped polling (a closed or crashed Claude).
  const sweep = setInterval(() => {
    const now = Date.now()
    for (const session of sessions.values()) {
      if (session.waiters.length === 0 && now - session.seenAt > STALE_SESSION_MS) drop(session)
    }
    if (sessions.size > 0 || streams.size > 0) lastBusy = now
  }, 10_000)
  sweep.unref()

  server.on('close', () => clearInterval(sweep))
  server.idleFor = () => Date.now() - lastBusy
  server.setEngineDownload = setEngineDownload
  server.voiceProvider = voiceProvider
  return server
}

// Run directly: listen on the fixed port and exit after ten idle minutes.
if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const { serviceToken, windowKey } = loadSecrets()
  const log = line => console.log(line)
  const engine = createEngine({ log })
  const hub = createHub({
    serviceToken,
    windowKey,
    apiKey: process.env.ELEVENLABS_API_KEY ?? '',
    provider: process.env.LUKE_VOICE_PROVIDER ?? '',
    engine,
    profile: () => readProfile(),
    voiceRef: join(ROOT, 'agent', 'ceci-voice.wav'),
    onLocalVoice: () => startOnce(),
    engineState: () => state,
    onSetup: () => {
      if (process.env.LUKE_VOICE_ENGINE === 'off') return { started: false, reason: 'off' }
      if (isSetupRunning) return { started: false, reason: 'running' }
      isSetupRunning = true
      // Setup again over a running engine: stop it, so the profile and models are read anew.
      engine.stop()
      engineStart = run({ isForced: true }).finally(() => (isSetupRunning = false))
      return { started: true }
    },
    log,
  })
  let engineStart = null
  let isSetupRunning = false
  // What the window waits for: 'off' (not started), 'starting', 'ready', 'light' (no native engine
  // on this machine) or 'failed'.
  let state = 'off'
  const run = options =>
    startEngine(options).catch(error => {
      log(`native engine: ${error.message}`)
      hub.setEngineDownload({ error: String(error.message) })
      state = 'failed'
      engineStart = null
    })
  // The free voice is used: start the native engine once (a no-op after).
  const startOnce = () => {
    if (process.env.LUKE_VOICE_ENGINE === 'off') return
    engineStart ??= run()
  }
  // The native engine: started when setup chose the gpu profile; prepared here (in the background,
  // with progress for the window) when setup never ran, as after a marketplace update.
  const startEngine = async ({ isForced = false } = {}) => {
    state = 'starting'
    let chosen = readProfile()
    // Never prepared, a file of its profile is missing (a new model in an update), or asked for.
    if (isForced || !chosen || !profileReady(chosen)) {
      hub.setEngineDownload({ loaded: 0, total: 0, label: 'preparando' })
      chosen = await prepareEngine({ onProgress: (loaded, total, label) => hub.setEngineDownload({ loaded, total, label }) })
      hub.setEngineDownload(null)
    }
    if (chosen.profile !== 'gpu') {
      state = 'light'
      return
    }
    await engine.start(undefined, { exe: chosen.exe })
    const voice = join(ROOT, 'agent', 'ceci-voice.wav')
    const transcript = voice.replace(/\.wav$/, '.txt')
    await engine.warm({
      speakerRefB64: existsSync(voice) ? readFileSync(voice).toString('base64') : '',
      speakerRefText: existsSync(transcript) ? readFileSync(transcript, 'utf8').trim() : '',
    })
    const up = engine.status()
    state = up.tts && up.asr ? 'ready' : 'failed'
  }
  process.on('exit', () => engine.stop())
  // Two launchers can race to start a hub; the one that finds the port taken leaves quietly.
  hub.on('error', error => {
    if (error.code === 'EADDRINUSE') {
      console.log(`luke-voice hub: 127.0.0.1:${PORT} is already served, exiting`)
      process.exit(0)
    }
    throw error
  })
  hub.listen(PORT, '127.0.0.1', () => {
    console.log(`luke-voice hub on 127.0.0.1:${PORT}`)
    // The free voice is the choice: warm the native engine up now, so the first call has it.
    if (hub.voiceProvider() === 'local') startOnce()
  })
  setInterval(() => {
    if (hub.idleFor() > 10 * 60_000) process.exit(0)
  }, 60_000).unref()
}
