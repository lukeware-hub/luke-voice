// The luke-voice hub: one local process for every subscribed Claude session and one call window.
// It never calls Claude. It queues a command; the matching session's mod pulls it and runs it.
import { spawn } from 'node:child_process'
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { createReadStream, existsSync, linkSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { pipeline } from 'node:stream/promises'
import { homedir } from 'node:os'
import { basename, dirname, join, posix, win32 } from 'node:path'
import { fileURLToPath } from 'node:url'

import { conversationToken, credits, ensureAgent, outOfCreditsMessage } from './agent.mjs'
import { PORT, isMainModule, stateDir, stateFile } from './paths.mjs'
import { ASR_GLOSSARY, SERVICES, VOICE_SETTINGS, createEngine, maxFrames, prepareEngine, profileReady, readProfile } from './engine.mjs'
import { pickMacVoice, sayWav } from './mac-voice.mjs'
import { personaFor, personaInfo } from './persona.mjs'
import { MODELS, ensureModel } from './models.mjs'
import { COMMON_QUESTIONS, MAX_PICK_CHARS, createQuestionTakes, isYesNoQuestion } from './question-pick.mjs'
import { route as routeUtterance } from './router.mjs'
import { contentType, vendorFile } from './vendor.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const VERSION = JSON.parse(readFileSync(join(ROOT, '.claude-plugin', 'plugin.json'), 'utf8')).version
const MAX_BODY = 64 * 1024
// One utterance as 16 kHz PCM16 WAV: 30 s is under 1 MB.
const MAX_AUDIO = 4 * 1024 * 1024
const MAX_TTS_CHARS = 360
const MAX_ACTIVITY = 60
const ACK_WAIT_MS = 15_000
// The router answers in ~0.3 s; past this, the utterance goes to the brain instead.
const ROUTER_WAIT_MS = 1500
// Qwen3-ASR transcribes a turn in ~0.2 s; a hung engine must not hold the request (the window gives up at 20 s).
const STT_WAIT_MS = 20_000
// How much of what Ceci just said goes into the ears' prompt: her last minute, newest 200 characters.
const RECENT_SAID_MS = 60_000
const RECENT_SAID_CHARS = 200
// A brain turn is one short Claude Sonnet call at medium effort (~2–3 s); a cold start can take longer.
const BRAIN_WAIT_MS = 40_000
const NO_SESSION_SAY = 'Nenhuma sessão do Claude está ligada. Ligue o luke-voice no Claude Code e me chame de novo.'
const STALE_SESSION_MS = 90_000
// The window is opened with a one-time launch code, not the window key: the address is on the
// browser's command line, which other users of the computer can read. The code lasts long enough
// for the browser to start; one handed to the user to open by hand lasts longer.
const LAUNCH_MS = 120_000
const MANUAL_LAUNCH_MS = 15 * 60_000
// A session whose luke-voice is older than 0.9.5 cannot think for the free voice: it would hand
// the command to Claude as a prompt. It says which session to restart instead.
const oldSessionSay = name => `A sessão ${name} está com uma versão antiga do luke-voice. Feche o Claude Code e abra de novo para atualizar.`

const STATIC = {
  '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
  '/guard.js': ['guard.js', 'text/javascript; charset=utf-8'],
  '/engines/elevenlabs.js': ['engines/elevenlabs.js', 'text/javascript; charset=utf-8'],
  '/engines/local.js': ['engines/local.js', 'text/javascript; charset=utf-8'],
  '/engines/speech-text.js': ['engines/speech-text.js', 'text/javascript; charset=utf-8'],
  '/engines/fast-path.js': ['engines/fast-path.js', 'text/javascript; charset=utf-8'],
  '/engines/turn-join.js': ['engines/turn-join.js', 'text/javascript; charset=utf-8'],
  '/engines/confirm.js': ['engines/confirm.js', 'text/javascript; charset=utf-8'],
  '/engines/progress.js': ['engines/progress.js', 'text/javascript; charset=utf-8'],
  '/engines/vad.js': ['engines/vad.js', 'text/javascript; charset=utf-8'],
  '/engines/piper-ids.js': ['engines/piper-ids.js', 'text/javascript; charset=utf-8'],
  '/engines/transcript.js': ['engines/transcript.js', 'text/javascript; charset=utf-8'],
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

// One /tts request body for Ceci's voice: the settings, then the reference as a pre-made JSON
// fragment (`"speaker_ref_b64":"...","speaker_ref_text":"..."`). Byte for byte what
// JSON.stringify of the whole object gave.
export function ttsBody(text, seed, refJson) {
  const head = JSON.stringify({ input: text, lang: 'pt', stream: true, response_format: 'wav', ...VOICE_SETTINGS, ...(seed === undefined ? {} : { seed }), n_predict: maxFrames(text) })
  return `${head.slice(0, -1)},${refJson}}`
}

// What a kept question take belongs to: the voice model files by content (their sha256, so a
// republished model never replays old takes), the sampling and the reference clip.
export const voiceKey = (refB64, refText) =>
  [...SERVICES.tts.models.map(path => `${path}@${MODELS[path]?.sha256 ?? ''}`), JSON.stringify(VOICE_SETTINGS), createHash('sha1').update(refB64 + refText).digest('hex')].join('\n')
// A short, one-way tag of the key so health can show which key is in use without exposing it.
const keyId = key => (key ? createHash('sha256').update(key).digest('hex').slice(0, 8) : null)

function readSeenKeys(file) {
  try {
    const ids = JSON.parse(readFileSync(file, 'utf8'))
    return Array.isArray(ids) ? ids.filter(id => typeof id === 'string') : []
  } catch {
    return []
  }
}

function sameSecret(given, expected) {
  if (typeof given !== 'string' || !expected) return false
  const a = Buffer.from(given)
  const b = Buffer.from(expected)
  return a.length === b.length && timingSafeEqual(a, b)
}

// Two launchers can start two hubs at once. A hub that overwrote hub.json with tokens the other
// (the one that wins the port) does not hold would get every mod refused with 401. So the file is
// only created when missing, whole and in one step (a hard link of a finished temp file), and the
// hub that finds it already there takes its tokens. A truncated or broken file is replaced (temp
// file and rename) instead of failing every start.
export function loadSecrets(file = stateFile('hub.json')) {
  let saved = null
  try {
    saved = JSON.parse(readFileSync(file, 'utf8')) ?? {}
  } catch (error) {
    if (error.code !== 'ENOENT') saved = {}
  }
  if (saved?.serviceToken && saved?.windowKey) return { serviceToken: saved.serviceToken, windowKey: saved.windowKey }
  // The window key survives a hub restart: an open window keeps working instead of failing with "key".
  const secrets = { serviceToken: saved?.serviceToken || newSecret(), windowKey: saved?.windowKey || newSecret() }
  const temp = `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`
  writeFileSync(temp, JSON.stringify(secrets, null, 2), { mode: 0o600 })
  try {
    if (saved) renameSync(temp, file)
    else {
      try {
        linkSync(temp, file)
      } catch (error) {
        // Another hub created it first: use its tokens.
        if (error.code === 'EEXIST') return loadSecrets(file)
        // A disk without hard links.
        renameSync(temp, file)
      }
    }
    return secrets
  } finally {
    rmSync(temp, { force: true })
  }
}

// The browsers that open the call as an app window (--app), in order: Google Chrome, then
// Chromium, then Microsoft Edge (on every Windows 10 and 11). Linux also looks for the snap and
// flatpak builds; macOS for an app installed in the user's own Applications folder.
export function browserCandidates({ platform = process.platform, env = process.env, home = homedir() } = {}) {
  if (platform === 'win32') {
    const bases = [env.PROGRAMFILES ?? env.ProgramFiles, env['PROGRAMFILES(X86)'] ?? env['ProgramFiles(x86)'], env.LOCALAPPDATA].filter(Boolean)
    return [
      ...bases.map(base => win32.join(base, 'Google', 'Chrome', 'Application', 'chrome.exe')),
      ...bases.map(base => win32.join(base, 'Microsoft', 'Edge', 'Application', 'msedge.exe')),
    ]
  }
  if (platform === 'darwin') {
    const apps = ['Google Chrome.app/Contents/MacOS/Google Chrome', 'Chromium.app/Contents/MacOS/Chromium', 'Microsoft Edge.app/Contents/MacOS/Microsoft Edge']
    return apps.flatMap(app => [`/Applications/${app}`, posix.join(home, 'Applications', app)])
  }
  const flatpak = id => [`/var/lib/flatpak/exports/bin/${id}`, posix.join(home, '.local/share/flatpak/exports/bin', id)]
  return [
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/snap/bin/chromium',
    ...flatpak('com.google.Chrome'),
    ...flatpak('org.chromium.Chromium'),
    '/usr/bin/microsoft-edge',
    '/usr/bin/microsoft-edge-stable',
  ]
}

export function chromePath({ exists = existsSync, ...where } = {}) {
  return browserCandidates(where).find(path => exists(path)) ?? null
}

// Linux inside WSL: the call opens in Windows' own browser, which has the microphone and the
// speakers (WSL forwards 127.0.0.1 to it).
export function isWsl({ platform = process.platform, read = path => readFileSync(path, 'utf8') } = {}) {
  if (platform !== 'linux') return false
  try {
    return /microsoft/i.test(read('/proc/version'))
  } catch {
    return false
  }
}

const onPath = (name, { env = process.env, exists = existsSync } = {}) =>
  String(env.PATH ?? '')
    .split(':')
    .filter(Boolean)
    .some(dir => exists(posix.join(dir, name)))

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

// A Chrome (or Chromium, or Edge) app window; else the default browser; in WSL, Windows' browser.
// On Windows not through cmd's `start`: cmd cuts the URL at its "&", and the call (`&call=1`)
// would not start.
export function windowCommand(url, { platform = process.platform, wsl = isWsl({ platform }), chrome = wsl ? null : chromePath({ platform }), profile = join(stateDir(), 'chrome'), has = name => onPath(name) } = {}) {
  if (wsl) return has('wslview') ? ['wslview', [url]] : ['rundll32.exe', ['url.dll,FileProtocolHandler', url]]
  if (chrome) return [chrome, chromeArgs(url, profile)]
  if (platform === 'win32') return ['rundll32', ['url.dll,FileProtocolHandler', url]]
  return [platform === 'darwin' ? 'open' : 'xdg-open', [url]]
}

// Resolves whether the window opened. A browser started as an app window counts once it runs; an
// opener (xdg-open, wslview, open, rundll32) also has to exit without an error within graceMs:
// xdg-open with no browser behind it exits with an error instead of opening anything.
export function openWindow(url, { command = windowCommand(url), log = () => {}, graceMs = 3000 } = {}) {
  const [cmd, args] = command
  const isApp = args.some(arg => String(arg).startsWith('--app='))
  return new Promise(resolve => {
    let isDone = false
    const done = (isOpened, why) => {
      if (isDone) return
      isDone = true
      // No browser to open (a Linux server without xdg-open): the hub keeps running; the mod says
      // so, with the address to open by hand.
      if (!isOpened) log(`the call window could not be opened: ${why}`)
      resolve(isOpened)
    }
    let child
    try {
      // windowsHide only for rundll32: Chrome opens its first window with the hidden show flag it is given.
      child = spawn(cmd, args, { detached: true, stdio: 'ignore', windowsHide: /rundll32/.test(cmd) })
    } catch (error) {
      return done(false, error.message)
    }
    child.on('error', error => done(false, error.message))
    child.once('spawn', () => {
      if (isApp) return done(true)
      setTimeout(() => done(true), graceMs).unref()
    })
    child.once('exit', code => (code ? done(false, `${cmd} exited with ${code}`) : done(true)))
    child.unref()
  })
}

// The engine must be prepared (again) when it never was, when a file of its profile is missing (a
// new model in an update), or when LUKE_VOICE_PROFILE asks for the other profile.
export function needsPrepare(chosen, { isReady, override = '' }) {
  if (!chosen || !isReady(chosen)) return true
  return ['gpu', 'light'].includes(override) && chosen.profile !== override
}

// Starts the native engine for the hub, once, or again for /luke-voice setup. A setup supersedes a
// start still running (it stops the engine and begins anew): the old run, which may still be
// downloading or starting, then starts no server (it would use the old exe) and writes no state.
export function createEngineRunner({ engine, setDownload, warmQuestions = () => {}, log = () => {}, read = readProfile, prepare = prepareEngine, isReady = profileReady, env = process.env, voice = join(ROOT, 'agent', 'ceci-voice.wav') }) {
  let engineStart = null
  let isSetupRunning = false
  // Bumped by every run: only the latest one may change the state or start servers.
  let generation = 0
  // What the window waits for: 'off' (not started), 'starting', 'ready', 'light' (no native engine
  // on this machine) or 'failed'.
  let state = 'off'
  // The native engine: started when setup chose the gpu profile; prepared here (in the background,
  // with progress for the window) when setup never ran, as after a marketplace update.
  const startEngine = async ({ isForced = false, isCurrent }) => {
    state = 'starting'
    let chosen = read()
    if (isForced || needsPrepare(chosen, { isReady, override: env.LUKE_VOICE_PROFILE })) {
      setDownload({ loaded: 0, total: 0, label: 'preparando' })
      chosen = await prepare({ onProgress: (loaded, total, label) => isCurrent() && setDownload({ loaded, total, label }) })
      if (!isCurrent()) return
      setDownload(null)
    }
    if (chosen.profile !== 'gpu') {
      state = 'light'
      return
    }
    await engine.start(undefined, { exe: chosen.exe, lean: chosen.lean })
    if (!isCurrent()) return
    const transcript = voice.replace(/\.wav$/, '.txt')
    await engine.warm({
      speakerRefB64: existsSync(voice) ? readFileSync(voice).toString('base64') : '',
      speakerRefText: existsSync(transcript) ? readFileSync(transcript, 'utf8').trim() : '',
    })
    if (!isCurrent()) return
    warmQuestions()
    const up = engine.status()
    state = up.tts && up.asr ? 'ready' : 'failed'
    // The next use of the free voice tries again (servers still starting are waited for, not doubled).
    if (state === 'failed') engineStart = null
  }
  const run = options => {
    const mine = ++generation
    const isCurrent = () => mine === generation
    return startEngine({ ...options, isCurrent }).catch(error => {
      if (!isCurrent()) return
      log(`native engine: ${error.message}`)
      setDownload({ error: String(error.message) })
      state = 'failed'
      engineStart = null
    })
  }
  return {
    // The free voice is used: start the native engine once (a no-op after).
    startOnce: () => {
      if (env.LUKE_VOICE_ENGINE === 'off') return
      engineStart ??= run()
    },
    setup: () => {
      if (env.LUKE_VOICE_ENGINE === 'off') return { started: false, reason: 'off' }
      if (isSetupRunning) return { started: false, reason: 'running' }
      isSetupRunning = true
      // Setup again over a running engine: stop it, so the profile and models are read anew.
      engine.stop()
      engineStart = run({ isForced: true }).finally(() => (isSetupRunning = false))
      return { started: true }
    },
    // A server that came up after its start timed out is used: the window sees it ready.
    state: () => (state === 'failed' && engine.status().tts && engine.status().asr ? 'ready' : state),
  }
}

export function createHub({ serviceToken, windowKey, apiKey = '', provider = '', root = ROOT, open = openWindow, vendor = vendorFile, models = ensureModel, engine = null, profile = () => null, voiceRef = null, onLocalVoice = () => {}, onSetup = () => ({ started: false }), engineState = () => 'off', macVoice = () => null, macVoiceGender = () => null, macVoiceSiri = () => null, macSay = sayWav, platform = process.platform, log = () => {}, onShutdown = () => process.exit(0), questionsDir = join(stateDir(), 'cache', 'questions'), staleMs = STALE_SESSION_MS, sweepMs = 10_000, sttWaitMs = STT_WAIT_MS, clock = Date.now }) {
  const sessions = new Map() // token -> session
  const launches = new Map() // one-time launch code -> when it expires
  const replaced = new Set() // tokens a newer subscription of the same Claude session took over
  const streams = new Set() // window SSE responses
  const acks = new Map() // command id -> resolve
  let focused = null
  let call = 'idle'
  let key = apiKey
  let agentId = null
  let isKeyRejected = false // ElevenLabs answered 401 to the current key
  // Short hashes of every key this hub has used (never the keys), kept across restarts: a key seen
  // before comes from a Claude session started before the user changed it.
  const seenKeysFile = stateFile('keys-seen.json')
  const seenKeys = new Set(readSeenKeys(seenKeysFile))
  const rememberKey = value => {
    if (!value || seenKeys.has(keyId(value))) return
    seenKeys.add(keyId(value))
    try {
      writeFileSync(seenKeysFile, JSON.stringify([...seenKeys].slice(-50)), { mode: 0o600 })
    } catch {
      // Only a memory: without it, an old session may bring back its key until the next change.
    }
  }
  rememberKey(key)
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

  // The address that opens the window: a fresh launch code, traded once at POST /launch for the key.
  const launchUrl = (startCall, lasts = LAUNCH_MS) => {
    const now = clock()
    for (const [code, until] of launches) if (until <= now) launches.delete(code)
    const code = newSecret()
    launches.set(code, now + lasts)
    return `http://127.0.0.1:${PORT}/?n=${code}${startCall ? '&call=1' : ''}`
  }

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
    'GET /inbox': async (session, _body, url, res) => {
      session.seenAt = Date.now()
      const wait = Math.min(Number(url.searchParams.get('wait') || 0), 25_000)
      if (session.inbox.length === 0 && wait > 0) {
        await new Promise(resolve => {
          // The waiter leaves the list when the wait ends any way (a command, the timeout, the mod
          // hanging up): one left behind would keep a dead session from ever being swept, and the
          // hub from ever going idle.
          const done = () => {
            clearTimeout(timer)
            res?.off('close', done)
            const at = session.waiters.indexOf(done)
            if (at >= 0) session.waiters.splice(at, 1)
            resolve()
          }
          const timer = setTimeout(done, wait)
          res?.once('close', done)
          session.waiters.push(done)
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
    'POST /show': async (session, body) => {
      focused = session.name
      const startCall = Boolean(body.call)
      if (streams.size === 0) {
        const url = launchUrl(startCall)
        // Never "the window is opening" when nothing could open it: the mod gets the address
        // instead, with a code of its own that lasts while the user gets to it.
        if ((await open(url, { log })) === false) {
          launches.delete(new URL(url).searchParams.get('n'))
          sendRoster()
          return [200, { ok: true, isWindowOpen: false, isOpened: false, url: launchUrl(startCall, MANUAL_LAUNCH_MS) }]
        }
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
      return [200, { provider, profile: profile()?.profile ?? null, engine: engineState(), native: engine ? engine.status() : {}, download: engineDownload, macVoice: macVoiceNow(), macVoiceHint: macVoiceHint(), persona: personaInfo(personaNow()) }]
    },
    // The native engine: the profile chosen for this machine, which servers are up, the download.
    'GET /engine': () => [200, { profile: profile(), native: engine ? engine.status() : {}, download: engineDownload }],
    // The local voice's brain: the focused session's mod asks Claude Sonnet and answers { say, tool }.
    'POST /brain': async (_none, body) => {
      const session = target()
      if (!session) return [200, { say: NO_SESSION_SAY, tool: null }]
      if (!session.canThink) return [200, { say: oldSessionSay(session.name), tool: null }]
      const clip = (value, max) => String(value ?? '').slice(0, max)
      const request = {
        kind: ['user', 'notice', 'tool_result'].includes(body.kind) ? body.kind : 'user',
        text: clip(body.text, 4000),
        context: (Array.isArray(body.context) ? body.context : []).slice(-8).map(c => clip(c, 1500)),
        turns: (Array.isArray(body.turns) ? body.turns : []).slice(-12).map(t => ({ role: t?.role === 'luke' ? 'luke' : 'user', text: clip(t?.text, 500) })),
        sessions: roster(),
        focused,
        persona: personaNow(),
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

  // What Ceci said in the last minute, for the ears: the user often answers with her words
  // ("Alcaçuz", "o Opus 5.5"). On 20 recorded turns it cut word errors from 27 to 24 of 129, and
  // noise or silence still came back empty. Kept as a list, so a short "Certo." made while the call
  // is idle does not push her last answer out.
  let recentSaid = [] // { text, at }
  const noteSaid = text => recentSaid.push({ text, at: clock() })
  const saidLately = () => {
    const since = clock() - RECENT_SAID_MS
    recentSaid = recentSaid.filter(said => said.at >= since).slice(-8)
    const joined = recentSaid.map(said => said.text).join(' ')
    // The newest words matter most: cut from the front, at a word boundary.
    return joined.length <= RECENT_SAID_CHARS ? joined : joined.slice(-RECENT_SAID_CHARS).replace(/^\S*\s+/, '')
  }
  const asrPrompt = () => {
    const names = [...sessions.values()].map(s => s.name).join(', ')
    const said = saidLately()
    return [ASR_GLOSSARY, names && `Sessões: ${names}.`, said && `Ceci acabou de dizer: ${said}`].filter(Boolean).join(' ')
  }

  // Speech to text on the native engine (Qwen3-ASR): a WAV in, { text } out.
  async function nativeStt(req, res) {
    const url = engine?.url('asr')
    if (!url) return send(res, 503, { error: 'The native speech engine is not running.' })
    const wav = await readRaw(req, MAX_AUDIO)
    const form = new FormData()
    form.append('file', new Blob([wav], { type: 'audio/wav' }), 'speech.wav')
    form.append('model', 'qwen3-asr')
    form.append('language', 'pt')
    form.append('prompt', asrPrompt())
    const started = Date.now()
    // The window gone (it hung up, or gave up waiting) or a hung engine: stop the transcription,
    // so the engine's single slot is free for the next turn. The request closes once its body is
    // read, so it is the response that tells.
    const stop = new AbortController()
    res.on('close', () => stop.abort())
    const signal = AbortSignal.any([stop.signal, AbortSignal.timeout(sttWaitMs)])
    let text = ''
    try {
      const answer = await fetch(`${url}/v1/audio/transcriptions`, { method: 'POST', body: form, signal })
      if (!answer.ok) return send(res, 502, { error: `speech engine ${answer.status}` })
      ;({ text = '' } = await answer.json())
    } catch (error) {
      if (stop.signal.aborted) return res.end()
      if (error?.name === 'TimeoutError') return send(res, 504, { error: 'The speech engine did not answer in time.' })
      throw error
    }
    // Qwen3-ASR starts its text with "language Portuguese<asr_text>".
    return send(res, 200, { text: String(text).replace(/^[\s\S]*<asr_text>/, '').trim(), ms: Date.now() - started })
  }

  // Ceci's voice on the native engine (Qwen3-TTS), streamed as WAV while it is made. A short yes/no
  // question is served from its kept takes when one rises naturally (question-pick.mjs).
  let voiceRefB64 = null
  let voiceRefText = null
  // The reference as the JSON that ends every /tts body, made once: it is ~0.5 MB of base64, and
  // serializing it again for every chunk Ceci says cost time on the hub's single thread.
  let voiceRefJson = null
  let questions = null
  // Whether Ceci's reference clip and its transcript are both loaded. Without them the engine speaks
  // in some other voice, with its accent drifting to European Portuguese: nothing is said then, and
  // a missing file is looked for again on the next line instead of being remembered as missing.
  const loadVoiceRef = () => {
    if (voiceRefB64 && voiceRefText) return true
    const transcript = voiceRef?.replace(/\.wav$/, '.txt')
    voiceRefB64 = voiceRef && existsSync(voiceRef) ? readFileSync(voiceRef).toString('base64') : null
    // The transcript of the reference: with it, llama.cpp clones Ceci from the reference codes (ICL).
    voiceRefText = transcript && existsSync(transcript) ? readFileSync(transcript, 'utf8').trim() || null : null
    voiceRefJson = voiceRefB64 && voiceRefText ? JSON.stringify({ speaker_ref_b64: voiceRefB64, speaker_ref_text: voiceRefText }).slice(1, -1) : null
    return Boolean(voiceRefJson)
  }
  // /tts streams with stream:true (on /v1/audio/speech it would need stream_format). The body is
  // the same JSON as before, with the reference's fragment appended as text. Never without the
  // reference: her voice would come out in some other accent.
  const speak = (url, text, signal, seed) => {
    if (!voiceRefJson) return Promise.resolve(null)
    return fetch(`${url}/tts`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: ttsBody(text, seed, voiceRefJson),
      signal,
    }).catch(() => null)
  }
  // Made only once the voice reference is loaded (the callers check it): a take belongs to it.
  const questionTakes = () => {
    questions ??= createQuestionTakes({
      dir: questionsDir,
      // A take belongs to one voice: the model, the sampling and the reference clip.
      voiceKey: voiceKey(voiceRefB64, voiceRefText),
      log,
      say: async (text, seed, signal) => {
        const url = engine?.url('tts')
        const take = url ? await speak(url, text, signal, seed) : null
        if (!take?.ok || !take.body) return null
        try {
          return Buffer.from(await take.arrayBuffer())
        } catch {
          return null // stopped
        }
      },
    })
    return questions
  }
  // The Mac's own Premium voice speaks when the natural voice does not run here (mac-voice.mjs).
  const macVoiceNow = () => (profile()?.profile === 'gpu' ? null : macVoice() || null)
  // A Mac with no natural voice and no Premium voice yet: the window says where to download one.
  // Ceci, or Nara or Luke when the free voice speaks with the Mac's own voice (persona.mjs).
  const personaNow = () => (voiceProvider() === 'local' ? personaFor({ platform, voice: macVoiceNow(), gender: macVoiceGender(), siri: macVoiceSiri() }) : 'ceci')
  const macVoiceHint = () => platform === 'darwin' && profile()?.profile === 'light' && !macVoiceNow() && process.env.LUKE_VOICE_MAC_VOICE !== 'off'
  async function macTts(voice, req, res) {
    const body = await readBody(req)
    const text = String(body.text ?? '').slice(0, MAX_TTS_CHARS).trim()
    if (!text) return send(res, 400, { error: 'Nothing to say.' })
    noteSaid(text)
    // The window hangs up when the user talks over Ceci: stop `say` with it.
    const stop = new AbortController()
    res.on('close', () => stop.abort())
    const wav = await macSay(voice, text, stop.signal).catch(error => {
      if (!stop.signal.aborted) log(`mac voice: ${error.message}`)
      return null
    })
    if (stop.signal.aborted) return res.end()
    if (!wav) return send(res, 502, { error: 'mac voice failed' })
    res.writeHead(200, { 'content-type': 'audio/wav', 'cache-control': 'no-store' })
    return res.end(wav)
  }
  async function nativeTts(req, res) {
    const mac = macVoiceNow()
    if (mac) return macTts(mac, req, res)
    const url = engine?.url('tts')
    if (!url) return send(res, 503, { error: 'The native voice engine is not running.' })
    const body = await readBody(req)
    // The window sends chunks of at most 220 characters. The engine's 1024 context holds the
    // reference plus ~380 characters; past that the audio would be cut short.
    const text = String(body.text ?? '').slice(0, MAX_TTS_CHARS).trim()
    if (!text) return send(res, 400, { error: 'Nothing to say.' })
    if (!loadVoiceRef()) return send(res, 503, { error: "Ceci's voice reference (agent/ceci-voice.wav and agent/ceci-voice.txt) is missing: reinstall luke-voice." })
    noteSaid(text)
    // A live line: the background question search stops until the engine is idle again.
    const done = questionTakes().live()
    // The window hangs up when the user talks over Ceci: stop the generation with it, so the
    // engine's single slot is free for the next answer. The request already closed after its body
    // was read, so it is the response that tells.
    const stop = new AbortController()
    res.on('close', () => {
      stop.abort()
      done()
    })
    const isQuestion = body.pick !== false && isYesNoQuestion(text) && text.length <= MAX_PICK_CHARS
    if (isQuestion) {
      const wav = await questionTakes().take(text, { budget: Math.max(0, Number(body.budget) || 0), signal: stop.signal })
      if (stop.signal.aborted) return res.end()
      if (wav) {
        res.writeHead(200, { 'content-type': 'audio/wav', 'cache-control': 'no-store' })
        return res.end(wav)
      }
    }
    const upstream = await speak(url, text, stop.signal)
    if (!upstream?.ok || !upstream.body) return send(res, 502, { error: `voice engine ${upstream?.status ?? 'unreachable'}` })
    res.writeHead(200, { 'content-type': 'audio/wav', 'cache-control': 'no-store' })
    const said = []
    try {
      for await (const chunk of upstream.body) {
        res.write(chunk)
        if (isQuestion) said.push(chunk)
      }
      // The live take of a question is kept too: it may already rise, and the search goes on from it.
      if (isQuestion && !stop.signal.aborted) questionTakes().remember(text, VOICE_SETTINGS.seed, Buffer.concat(said))
    } catch {
      // The window hung up (barge-in): the generation was aborted with it.
    }
    return res.end()
  }

  // A browser marks every request another web page makes (an <img>, a script tag) with the site it
  // came from. Model and vendor files download on first use, so a page on another site must not be
  // able to start gigabytes of downloads. The window and its workers are same-origin. A browser that
  // does not send Sec-Fetch-Site still sends the window's own address as Referer (its module
  // imports and its workers' fetches carry no custom header); the window key works too.
  const isFromWindow = (req, hosts) => {
    const site = req.headers['sec-fetch-site']
    if (site) return site === 'same-origin'
    if (sameSecret(req.headers['x-luke-key'], windowKey)) return true
    const from = req.headers.origin ?? req.headers.referer
    return typeof from === 'string' && hosts.some(host => from === `http://${host}` || from.startsWith(`http://${host}/`))
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
        return send(res, 200, { app: 'luke-voice', version: VERSION, sessions: sessions.size, isWindowOpen: streams.size > 0, call, hasKey: Boolean(key), provider: voiceProvider(), keyStatus: !key ? 'missing' : isKeyRejected ? 'rejected' : 'set', keyId: keyId(key), profile: profile()?.profile ?? null, native: engine ? engine.status() : {}, download: engineDownload, macVoice: macVoiceNow(), persona: personaInfo(personaNow()) })
      }

      if (route === 'POST /subscribe') {
        if (!sameSecret(bearer, serviceToken)) return send(res, 401, { error: 'token' })
        const body = await readBody(req)
        const offered = typeof body.apiKey === 'string' ? body.apiKey.trim() : ''
        // A key never seen before was just saved in Claude Code: it wins, so a changed key works
        // without waiting for the hub to exit. A key seen before comes from a session started
        // before the change, and only replaces a missing or rejected one.
        if (offered && offered !== key && (!key || isKeyRejected || !seenKeys.has(keyId(offered)))) {
          if (key) log('API key updated')
          key = offered
          isKeyRejected = false
          agentId = null
        }
        rememberKey(offered)
        // Like the key, the latest voice chosen in Claude Code wins. A session from before 0.9.5
        // sends no voice (nor version): see canThink below.
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
        const session = { token, sessionId, name: previous?.name ?? uniqueName(body.cwd), cwd: String(body.cwd ?? ''), canThink: typeof body.version === 'string' || typeof body.provider === 'string', inbox: [], waiters: [], activity: [], isBusy: false, needsYou: false, seenAt: Date.now() }
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
        const [status, out] = await sessionRoutes[route](session, body, url, res)
        return send(res, status, out)
      }

      // The page holds no secret, so a reload (its address no longer has the launch code) still
      // loads; without the key, from its launch code or this tab's storage, it can do nothing.
      if (route === 'GET /') {
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

      // The window trades its one-time launch code for the window key. Only its own page may ask (a
      // browser always sends Origin with a POST); a code works once, and only until it expires.
      if (route === 'POST /launch') {
        if (!origin || (req.headers['sec-fetch-site'] && req.headers['sec-fetch-site'] !== 'same-origin')) return send(res, 403, { error: 'origin' })
        const code = String((await readBody(req)).nonce ?? '')
        const until = launches.get(code)
        launches.delete(code)
        if (!until || until <= clock()) return send(res, 403, { error: 'launch' })
        return send(res, 200, { key: windowKey })
      }

      if (req.method === 'GET' && (url.pathname.startsWith('/vendor/') || url.pathname.startsWith('/models/')) && !isFromWindow(req, hosts)) {
        return send(res, 403, { error: 'only the call window may load these' })
      }

      if (req.method === 'GET' && url.pathname.startsWith('/vendor/')) {
        const path = url.pathname.slice('/vendor/'.length)
        const file = await vendor(path)
        if (!file) return send(res, 404, { error: 'not found' })
        // Pinned by hash: the bytes for a path never change, so the browser may keep them.
        res.writeHead(200, { 'content-type': contentType(path), 'content-length': String(statSync(file).size), 'cache-control': 'public, max-age=31536000, immutable', ...ISOLATION })
        // Streamed from disk, checked once per process (hub/vendor.mjs).
        return pipeline(createReadStream(file), res).catch(() => res.destroy())
      }

      // Voice model files, verified by sha256 (hub/models.mjs); downloaded here if setup did not.
      if (req.method === 'GET' && url.pathname.startsWith('/models/')) {
        const path = url.pathname.slice('/models/'.length)
        // The native engine reads its own files from disk; the window only needs the light voice and the turn models.
        if (path.startsWith('native/')) return send(res, 404, { error: 'not found' })
        const file = await models(path)
        if (!file) return send(res, 404, { error: 'not found' })
        res.writeHead(200, {
          'content-type': 'application/octet-stream',
          'content-length': String(statSync(file).size),
          'cache-control': 'public, max-age=31536000, immutable',
          ...ISOLATION,
        })
        // A read error (the file replaced or locked meanwhile) ends this response, not the hub.
        return pipeline(createReadStream(file), res).catch(() => res.destroy())
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
      if (session.waiters.length === 0 && now - session.seenAt > staleMs) drop(session)
    }
    if (sessions.size > 0 || streams.size > 0) lastBusy = now
  }, sweepMs)
  sweep.unref()

  server.on('close', () => clearInterval(sweep))
  server.idleFor = () => Date.now() - lastBusy
  server.setEngineDownload = setEngineDownload
  // Once the engine is up: the questions Ceci asks most get their natural takes in the background.
  // Only while the voice is up and has its reference: a take asked of a server that is down comes
  // back empty at once.
  server.warmQuestions = () => {
    if (engine?.url('tts') && loadVoiceRef()) questionTakes().warm(COMMON_QUESTIONS)
  }
  server.on('close', () => questions?.stop())
  server.voiceProvider = voiceProvider
  return server
}

// Run directly: listen on the fixed port and exit after ten idle minutes.
if (isMainModule(import.meta.url, process.argv[1])) {
  // Behind a proxy, launch.mjs started this Node with NODE_USE_ENV_PROXY (hub/proxy.mjs).
  const { serviceToken, windowKey } = loadSecrets()
  const log = line => console.log(line)
  const engine = createEngine({ log })
  const runner = createEngineRunner({ engine, log, setDownload: next => hub.setEngineDownload(next), warmQuestions: () => hub.warmQuestions() })
  // Looked for again at most once a minute: a voice downloaded, or a new Spoken Content system
  // voice (Siri Voz 1 to Voz 2), counts from the next call, with no hub restart.
  // { voice, gender, siri } or null (mac-voice.mjs).
  let macVoice = null
  let macLooked = 0
  const lookForMacVoice = () => {
    if (Date.now() - macLooked < 60_000) return
    macLooked = Date.now()
    pickMacVoice().then(found => {
      if (found && (found.voice !== macVoice?.voice || found.gender !== macVoice?.gender || found.siri !== macVoice?.siri)) log(`mac voice: ${found.voice}${found.siri ? ` ${found.siri}` : ''} (${found.gender ?? 'gender unknown'})`)
      macVoice = found
    })
  }
  lookForMacVoice()
  const hub = createHub({
    serviceToken,
    windowKey,
    apiKey: process.env.ELEVENLABS_API_KEY ?? '',
    provider: process.env.LUKE_VOICE_PROVIDER ?? '',
    engine,
    profile: () => readProfile(),
    voiceRef: join(ROOT, 'agent', 'ceci-voice.wav'),
    onLocalVoice: runner.startOnce,
    engineState: runner.state,
    macVoice: () => {
      lookForMacVoice()
      return macVoice?.voice ?? null
    },
    macVoiceGender: () => macVoice?.gender ?? null,
    macVoiceSiri: () => macVoice?.siri ?? null,
    onSetup: runner.setup,
    log,
  })
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
    if (hub.voiceProvider() === 'local') runner.startOnce()
  })
  setInterval(() => {
    if (hub.idleFor() > 10 * 60_000) process.exit(0)
  }, 60_000).unref()
}
