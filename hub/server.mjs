// The luke-voice hub: one local process for every subscribed Claude session and one call window.
// It never calls Claude. It queues a command; the matching session's mod pulls it and runs it.
import { spawn } from 'node:child_process'
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { appendFileSync, createReadStream, existsSync, linkSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
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
import { createNotices } from './notices.mjs'
import { COMMON_QUESTIONS, MAX_PICK_CHARS, createQuestionTakes, isYesNoQuestion } from './question-pick.mjs'
import { route as routeUtterance } from './router.mjs'
import { asrWords, withoutPromptLeak } from './asr-leak.mjs'
import { splitWav } from './asr-split.mjs'
import { dayOf, openMemory, rangeOf, scopeFromArgs } from './memory.mjs'
import { createGraphUpdater } from './graph.mjs'
import { quoteUntrusted } from '../window/guard.js'
import { contentType, vendorFile } from './vendor.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const VERSION = JSON.parse(readFileSync(join(ROOT, '.claude-plugin', 'plugin.json'), 'utf8')).version
const MAX_BODY = 64 * 1024
// One utterance as 16 kHz PCM16 WAV: 30 s is under 1 MB.
const MAX_AUDIO = 4 * 1024 * 1024
const MAX_TTS_CHARS = 360
const MAX_ACTIVITY = 60
// Ceci's memory (hub/memory.mjs): a session's report kinds as memory kinds, and the most text kept
// per event (a whole tool output can be long; the memory keeps it, up to this).
const SESSION_KINDS = { prompt: 'session_prompt', tool: 'session_tool', failure: 'session_failure', done: 'session_done', task_done: 'task_result', task_progress: 'session_info', attention: 'session_info', info: 'session_info' }
const MEMORY_TEXT = 100_000
// What the brain reads of the memory on every turn: each hit clipped, the whole block capped.
const MEMORY_HIT_CHARS = 300
const MEMORY_BLOCK_CHARS = 3000
const WEEKDAYS = ['domingo', 'segunda-feira', 'terça-feira', 'quarta-feira', 'quinta-feira', 'sexta-feira', 'sábado']
const ACK_WAIT_MS = 15_000
// The router answers in ~0.3 s; past this, the utterance goes to the brain instead.
const ROUTER_WAIT_MS = 1500
// Qwen3-ASR transcribes a turn in ~0.2 s; a hung engine must not hold the request (the window gives up at 20 s).
// A voice-task result that finds no window open opens one, at most once in this long.
// The call window's log file starts over past this size.
const WINDOW_LOG_BYTES = 1_000_000
const REOPEN_FOR_NOTICE_MS = 60_000
const STT_WAIT_MS = 20_000
// How much of what Ceci just said goes into the ears' prompt: her last minute, newest 200 characters.
const RECENT_SAID_MS = 60_000
const RECENT_SAID_CHARS = 200
// A brain turn is one short Claude Sonnet call at medium effort (~2–3 s); a cold start can take longer.
const BRAIN_WAIT_MS = 40_000
const NO_SESSION_SAY = 'Nenhuma sessão do Claude está ligada. Ligue o luke-voice no Claude Code e me chame de novo.'
const STALE_SESSION_MS = 90_000
// How many sessions ended from the window the hub remembers (~/.luke-voice/ended.json).
const MAX_ENDED = 200
// The window is opened with a one-time launch code, not the window key: the address is on the
// browser's command line, which other users of the computer can read. The code lasts long enough
// for the browser to start; one handed to the user to open by hand lasts longer.
const LAUNCH_MS = 120_000
const MANUAL_LAUNCH_MS = 15 * 60_000
// A window the hub just opened has this long to connect its stream. Meanwhile no second one is
// opened: a cold Chrome takes seconds to start, and a second /show (or a finished task) in that
// time would open a second window.
const LAUNCH_WAIT_MS = 20_000
// How many tokens of replaced and ended sessions the hub keeps answering 409 or 410, oldest
// forgotten first: a hub that runs for weeks must not keep every token it ever handed out.
const MAX_GONE = 500
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
  '/engines/greetings.js': ['engines/greetings.js', 'text/javascript; charset=utf-8'],
  '/engines/acks.js': ['engines/acks.js', 'text/javascript; charset=utf-8'],
  '/engines/phrase-audio.js': ['engines/phrase-audio.js', 'text/javascript; charset=utf-8'],
  '/engines/progress.js': ['engines/progress.js', 'text/javascript; charset=utf-8'],
  '/engines/context.js': ['engines/context.js', 'text/javascript; charset=utf-8'],
  '/engines/vad.js': ['engines/vad.js', 'text/javascript; charset=utf-8'],
  '/engines/gain.js': ['engines/gain.js', 'text/javascript; charset=utf-8'],
  '/engines/microphone.js': ['engines/microphone.js', 'text/javascript; charset=utf-8'],
  '/engines/mic-test.js': ['engines/mic-test.js', 'text/javascript; charset=utf-8'],
  '/engines/piper-ids.js': ['engines/piper-ids.js', 'text/javascript; charset=utf-8'],
  '/engines/transcript.js': ['engines/transcript.js', 'text/javascript; charset=utf-8'],
  '/engines/speech-check.js': ['engines/speech-check.js', 'text/javascript; charset=utf-8'],
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
// file and rename) instead of failing every start. A file that cannot be read for a moment (Windows:
// EBUSY or EPERM while an antivirus or a backup holds it) is read again, then the error is thrown:
// replacing it would change the tokens every running mod holds.
export function loadSecrets(file = stateFile('hub.json'), { read = path => readFileSync(path, 'utf8'), retryMs = 100, tries = 5 } = {}) {
  let saved = null
  for (let attempt = 1; ; attempt++) {
    let text
    try {
      text = read(file)
    } catch (error) {
      if (error.code === 'ENOENT') break
      if (attempt >= tries) throw error
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, retryMs)
      continue
    }
    try {
      saved = JSON.parse(text) ?? {}
    } catch {
      saved = {}
    }
    break
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
        if (error.code === 'EEXIST') return loadSecrets(file, { read, retryMs, tries })
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

export function createHub({ serviceToken, windowKey, apiKey = '', provider = '', root = ROOT, open = openWindow, vendor = vendorFile, models = ensureModel, engine = null, profile = () => null, voiceRef = null, onLocalVoice = () => {}, onSetup = () => ({ started: false }), engineState = () => 'off', macVoice = () => null, macVoiceGender = () => null, macVoiceSiri = () => null, macSay = sayWav, platform = process.platform, log = () => {}, onShutdown = () => process.exit(0), questionsDir = join(stateDir(), 'cache', 'questions'), staleMs = STALE_SESSION_MS, sweepMs = 10_000, sttWaitMs = STT_WAIT_MS, clock = Date.now, noticesFile = stateFile('notices.json'), reopenMs = REOPEN_FOR_NOTICE_MS, windowLog = stateFile('window.log'), memory = null, graph = null, summarizeEveryMs = 120_000, endedFile = stateFile('ended.json'), ackWaitMs = ACK_WAIT_MS, maxGone = MAX_GONE }) {
  const sessions = new Map() // token -> session
  const launches = new Map() // one-time launch code -> when it expires
  const replaced = new Set() // tokens a newer subscription of the same Claude session took over
  const ended = new Set() // tokens of sessions the user ended from the window: their mod turns off
  // Adds a token to `replaced` or `ended`, forgetting the oldest past maxGone. A forgotten one is
  // answered 401, as any unknown token: its mod subscribes again or turns off.
  const rememberGone = (set, token) => {
    set.add(token)
    for (const old of set) {
      if (set.size <= maxGone) break
      set.delete(old)
    }
  }
  const streams = new Set() // window SSE responses
  // Until when a window the hub opened is still starting (see LAUNCH_WAIT_MS); 0 when none is.
  let launchingUntil = 0
  const canOpenWindow = () => streams.size === 0 && clock() >= launchingUntil
  // Voice-task results not yet handed to the voice (notices.mjs), and when a result last opened
  // the window, so a burst of results opens it once.
  const notices = createNotices({ file: noticesFile, clock })
  let reopenedAt = -Infinity
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
  // Claude sessions the user ended from the window, by their Claude session id, kept across
  // restarts: a mod that subscribes again for one (a reload, a hub restart, an older luke-voice
  // that treats any 410 as "subscribe again") is refused, so an ended session never comes back by
  // itself. Only the user turning luke-voice on again in that session (`byUser`) lifts it.
  const endedIds = new Set(readSeenKeys(endedFile))
  const saveEnded = () => {
    for (const id of [...endedIds].slice(0, -MAX_ENDED)) endedIds.delete(id)
    try {
      writeFileSync(endedFile, JSON.stringify([...endedIds]), { mode: 0o600 })
    } catch {
      // Kept in memory still; only a hub restart would forget it.
    }
  }
  let lastBusy = Date.now()

  // Ceci's memory. Recording never fails a request: memory.append() keeps what it cannot write.
  const remember = event => {
    if (!memory) return
    try {
      memory.append(event)
    } catch (error) {
      log(`memory: ${error?.message ?? error}`)
    }
  }

  // The memory as the brain reads it: the life summary, the last conversations and the hits for
  // what the user just said. Hits from the sessions are quoted as untrusted, like the activity.
  const memoryBlock = text => {
    if (!memory?.isAvailable) return ''
    try {
      const d = memory.digest(text)
      const lines = []
      if (d.firstDay) lines.push(`Primeira conversa: ${d.firstDay}.`)
      if (d.life) lines.push(`Resumo de tudo: ${d.life}`)
      if (d.recent.length) lines.push(`Últimas conversas: ${d.recent.map(c => `${c.day} (#${c.id})${c.title ? ` ${c.title}` : ''}`).join('; ')}.`)
      for (const hit of d.hits) {
        const who = hit.kind === 'user' ? 'usuário' : hit.kind === 'ceci' ? 'ceci' : hit.kind
        const text = hit.text.replace(/\s+/g, ' ').slice(0, MEMORY_HIT_CHARS)
        lines.push(`${hit.when ?? hit.day} (#${hit.conversation}) ${who}: ${hit.untrusted ? quoteUntrusted(text) : text}`)
      }
      // Whole lines only, so an untrusted quote is never cut open.
      let block = ''
      for (const line of lines) {
        if (block.length + line.length + 1 > MEMORY_BLOCK_CHARS) break
        block += `${block ? '\n' : ''}${line}`
      }
      return block
    } catch (error) {
      log(`memory: ${error?.message ?? error}`)
      return ''
    }
  }

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

  // Opens the window, and no other until it connects its stream (or LAUNCH_WAIT_MS passes). Resolves
  // to what open() said: false when nothing could be opened, which leaves no launch waiting.
  const openLaunched = async url => {
    launchingUntil = clock() + LAUNCH_WAIT_MS
    let isOpened
    try {
      isOpened = await open(url, { log })
    } catch (error) {
      launchingUntil = 0
      throw error
    }
    if (isOpened === false) launchingUntil = 0
    return isOpened
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

  function enqueue(session, command, wait = ackWaitMs) {
    const id = newSecret().slice(0, 12)
    session.inbox.push({ id, ...command })
    wake(session)
    return new Promise(resolve => {
      const timer = setTimeout(() => {
        acks.delete(id)
        // Not pulled yet: it leaves the inbox, or the mod would run it later (a prompt the window
        // already reported as failed, a stale stop or think).
        const at = session.inbox.findIndex(queued => queued.id === id)
        if (at >= 0) session.inbox.splice(at, 1)
        resolve({ ok: false, message: `The ${session.name} session did not answer in time.` })
      }, wait)
      // Answered once, by the mod's ack or the session ending: the entry goes with it.
      acks.set(id, result => {
        clearTimeout(timer)
        acks.delete(id)
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

  // Before Ceci asks "ok?" about deleting from the memory, the user hears how much it is; a
  // delete that matches nothing is not asked about at all.
  const withDeleteCount = (say, pending) => {
    if (pending?.name !== 'luke_memory_delete' || !memory?.isAvailable) return { say, pending }
    const scope = scopeFromArgs(pending.args ?? {})
    if (!scope) return { say: 'Não entendi o que apagar da memória. Diga uma conversa, um dia ou umas palavras.', pending: null }
    const found = memory.preview(scope)
    if (found.events === 0) return { say: 'Não achei nada na memória com isso, então não há o que apagar.', pending: null }
    const where = found.conversations > 1 ? ` em ${found.conversations} conversas` : ''
    const count = `São ${found.events} ${found.events === 1 ? 'registro' : 'registros'}${where}.`
    return { say: `${count} ${say}`.trim(), pending }
  }

  // What a command to a session answered, kept in the memory.
  const recorded = (result, session) => {
    remember({ kind: 'tool_result', text: `${result.ok ? 'Feito' : 'Falhou'}: ${result.message ?? ''}`.trim(), session: session.name, untrusted: true })
    return result
  }

  // ---- Ceci's memory: reading, deleting, summaries ----

  const num = value => (value === null || value === undefined || value === '' ? null : Number.isFinite(Number(value)) ? Number(value) : null)
  // A period from the window, the brain or a command: a date ("2026-11-03"), a month ("2026-11") or ms.
  const edge = (value, side) => {
    if (value === null || value === undefined || value === '') return null
    const range = rangeOf(/^\d+$/.test(String(value)) ? Number(value) : String(value))
    return range ? range[side] : null
  }

  // The memory's routes, the same for the call window and a session's mod. `how` says who deletes.
  const memoryRoutes = how => ({
    'GET /memory/stats': () => [200, memory ? memory.stats() : { isAvailable: false }],
    // The memory as the brain reads it, for a voice whose brain is not ours (ElevenLabs): sent at call start.
    'GET /memory/digest': () => [200, { text: memoryBlock('') }],
    'GET /memory/search': (_none, _body, url) => {
      if (!memory) return [503, { error: 'The memory is not available.' }]
      const p = url.searchParams
      const { hits, total } = memory.searchPage(p.get('q') ?? '', { from: edge(p.get('from'), 0), to: edge(p.get('to'), 1), kind: p.get('kind') || null, limit: num(p.get('limit')) ?? 10, offset: num(p.get('offset')) ?? 0 })
      return [200, { hits, total }]
    },
    // One page of conversations, newest first, and how many there are, for the window's page numbers.
    'GET /memory/conversations': (_none, _body, url) => {
      if (!memory) return [503, { error: 'The memory is not available.' }]
      const p = url.searchParams
      const includeBackground = p.get('background') === '1'
      const conversations = memory.conversations({ before: num(p.get('before')), limit: num(p.get('limit')) ?? 30, offset: num(p.get('offset')) ?? 0, includeBackground })
      return [200, { conversations, total: memory.conversationCount({ includeBackground }) }]
    },
    'GET /memory/conversation': (_none, _body, url) => {
      if (!memory) return [503, { error: 'The memory is not available.' }]
      const p = url.searchParams
      const which = p.get('id') ?? 'last'
      const found = memory.conversation(/^\d+$/.test(which) ? Number(which) : which, { offset: num(p.get('offset')) ?? 0, limit: num(p.get('limit')) ?? 200, includeBackground: true })
      return found ? [200, found] : [404, { error: 'No such conversation.' }]
    },
    'GET /memory/timeline': (_none, _body, url) => {
      if (!memory) return [503, { error: 'The memory is not available.' }]
      const p = url.searchParams
      return [200, memory.timeline({ from: edge(p.get('from'), 0), to: edge(p.get('to'), 1) })]
    },
    'POST /memory/preview': (_none, body) => {
      if (!memory) return [503, { error: 'The memory is not available.' }]
      return [200, memory.preview(body.scope ?? {})]
    },
    // Deleting is for good. The window and the commands confirm before they ask; the voice only
    // asks after the user's yes to "ok?" (the brain's luke_memory_delete is a pending tool).
    'POST /memory/delete': (_none, body) => {
      if (!memory) return [503, { error: 'The memory is not available.' }]
      const scope = body.scope ?? {}
      const result = memory.deleteMemory(scope, { how: String(body.how ?? how).slice(0, 20) })
      broadcast({ type: 'memory', deleted: result.deleted })
      // The knowledge graph holds the deleted words too (its transcripts, Graphify's output): the
      // next run takes them out, as soon as no call is live and the safety gap allows.
      if (result.deleted) graph?.schedule(0)
      return [200, { ok: true, ...result }]
    },
  })

  // Summaries are written by a session's brain, one batch at a time, while no call is live.
  let isSummarizing = false
  let summaryTimer = null
  async function summarize() {
    if (!memory?.isAvailable || isSummarizing || call === 'live') return
    const session = [...sessions.values()].find(s => s.name === focused && s.canSummarize) ?? [...sessions.values()].find(s => s.canSummarize)
    if (!session) return
    const items = memory.pendingSummaries({ max: 4 })
    if (items.length === 0) return
    isSummarizing = true
    try {
      const result = await enqueue(session, { type: 'summarize', items: items.map(({ level, period, toEvent, day, text }) => ({ level, period, toEvent, day, text })) }, BRAIN_WAIT_MS * 3)
      if (!result.ok) return log(`memory: summaries not written: ${result.message}`)
      let written = []
      try {
        written = JSON.parse(result.message)
      } catch {
        return log('memory: summaries came back not as JSON')
      }
      let saved = 0
      for (const item of Array.isArray(written) ? written : []) {
        const asked = items.find(i => i.level === item?.level && i.period === String(item?.period))
        if (asked && memory.saveSummary({ ...asked, text: String(item.text ?? ''), title: item.title ?? null })) saved++
      }
      if (saved) log(`memory: wrote ${saved} summaries`)
      // More may be waiting (a day once its conversations are done, then the month, then life).
      if (saved) scheduleSummaries(1000)
    } finally {
      isSummarizing = false
    }
  }
  function scheduleSummaries(ms) {
    if (!memory?.isAvailable) return
    clearTimeout(summaryTimer)
    summaryTimer = setTimeout(() => void summarize().catch(error => log(`memory: ${error?.message ?? error}`)), ms)
    summaryTimer.unref?.()
  }

  // Every change of the call state goes through here: the window's /call, its stream closing, a
  // shutdown, the hub exiting idle. A call that goes live is a new conversation in the memory; one
  // that ends closes it, and its summary is written soon after.
  function setCall(next) {
    const was = call
    call = next
    if (memory && call === 'live' && was !== 'live') memory.startCall({ persona: personaNow(), voice: voiceProvider() })
    if (memory && call !== 'live' && was === 'live') {
      memory.endCall()
      scheduleSummaries(65_000)
      // The knowledge graph (hub/graph.mjs) takes the new conversation at the same moment, in the
      // background, at most once per its safety gap.
      graph?.schedule(65_000)
    }
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
    ...memoryRoutes('command'),
    'POST /events': (session, body) => {
      // An entry that is not an object (null, a number) is skipped, not a 500 for the whole batch.
      const events = Array.isArray(body.events) ? body.events.slice(0, 50).filter(event => event && typeof event === 'object') : []
      // Everything the sessions report is kept in Ceci's memory, marked as not the user's words.
      for (const event of events) remember({ kind: SESSION_KINDS[String(event.kind)] ?? 'session_info', text: String(event.full ?? event.text ?? '').slice(0, MEMORY_TEXT), session: session.name, untrusted: true })
      for (const event of events) {
        // As long as a task's result may be (2500 in hooks/register.tsx), so it is not cut again here.
        const item = { kind: String(event.kind ?? 'info').slice(0, 20), text: String(event.text ?? '').slice(0, 2500) }
        session.activity.push(item)
        if (item.kind === 'attention') session.needsYou = true
        if (item.kind === 'done' || item.kind === 'prompt') session.needsYou = false
      }
      session.activity.splice(0, Math.max(0, session.activity.length - MAX_ACTIVITY))
      if (typeof body.isBusy === 'boolean') session.isBusy = body.isBusy
      // A finished task is kept until a window hands it to the voice: it carries the notice's id.
      const told = events
        .map(event => {
          if (String(event.kind) !== 'task_done') return event
          const notice = notices.add(session.name, String(event.text ?? '').slice(0, 2500))
          // The same result the window handed to the voice a moment ago (the mod sent it again):
          // not broadcast, so Ceci does not say it twice.
          if (notice.isHeard) return null
          return { ...event, id: notice.id }
        })
        .filter(Boolean)
      if (told.length) broadcast({ type: 'activity', session: session.name, events: told })
      // No window to tell it: open one that starts the call, so Ceci says it without being asked.
      if (told.some(event => event.id) && canOpenWindow() && clock() - reopenedAt >= reopenMs) {
        reopenedAt = clock()
        void openLaunched(launchUrl(true)).catch(() => {})
      }
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
      if (ended.has(session.token)) return [410, { error: 'ended' }]
      if (!sessions.has(session.token)) return [410, { error: 'unsubscribed' }]
      return [200, { commands: session.inbox.splice(0), call, isFocused: focused === session.name }]
    },
    'POST /ack': (_session, body) => {
      acks.get(body.id)?.({ ok: Boolean(body.ok), message: String(body.message ?? '') })
      return [200, { ok: true }]
    },
    'POST /show': async (session, body) => {
      focused = session.name
      const startCall = Boolean(body.call)
      if (canOpenWindow()) {
        const url = launchUrl(startCall)
        // Never "the window is opening" when nothing could open it: the mod gets the address
        // instead, with a code of its own that lasts while the user gets to it.
        if ((await openLaunched(url)) === false) {
          launches.delete(new URL(url).searchParams.get('n'))
          sendRoster()
          return [200, { ok: true, isWindowOpen: false, isOpened: false, url: launchUrl(startCall, MANUAL_LAUNCH_MS) }]
        }
      } else {
        // An open window moves to this session; one still starting reads the focus from the roster
        // it gets when its stream connects.
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
    // The call window's own "[luke-voice]" console lines, kept in ~/.luke-voice/window.log so a
    // call that went wrong can be read afterwards (the window runs in its own Chrome profile, with
    // no DevTools at hand). At most ~1 MB, then the file starts over (the previous one kept as .old).
    'POST /log': (_none, body) => {
      const lines = (Array.isArray(body.lines) ? body.lines : []).slice(0, 200).map(line => String(line).replace(/[\r\n]+/g, ' ').slice(0, 500))
      if (lines.length === 0 || !windowLog) return [200, { ok: true }]
      try {
        if (existsSync(windowLog) && statSync(windowLog).size > WINDOW_LOG_BYTES) renameSync(windowLog, `${windowLog}.old`)
        appendFileSync(windowLog, `${lines.join('\n')}\n`, { mode: 0o600 })
      } catch {
        // A log that cannot be written changes nothing for the call.
      }
      return [200, { ok: true }]
    },
    // The user ends a session from the window, even one that hangs: it leaves the roster now, and
    // its mod, on its next request, is told it was ended and turns luke-voice off in that session.
    'POST /session-end': (_none, body) => {
      const session = byName(String(body.name ?? ''))
      if (!session) return [404, { ok: false, error: missing(String(body.name ?? '')) }]
      rememberGone(ended, session.token)
      // Remembered by its Claude session too: a new subscription from it is refused (see /subscribe).
      if (session.sessionId) {
        endedIds.delete(session.sessionId)
        endedIds.add(session.sessionId)
        saveEnded()
      }
      // Its waiting commands get no answer now: the window is not left hanging on them. Answering
      // one also forgets its ack (see enqueue).
      for (const command of session.inbox) acks.get(command.id)?.({ ok: false, message: `The ${session.name} session was ended.` })
      session.inbox = []
      drop(session)
      log(`session ${session.name} ended from the window`)
      return [200, { ok: true }]
    },
    // The window handed a finished task's result to the voice: it is not sent again.
    'POST /notice-ack': (_none, body) => [200, { ok: notices.ack(String(body.id ?? '')) }],
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
        remember({ kind: 'task', text: `Mandar ao Claude: ${prompt}`, session: session.name, meta: { type: 'send', when, plan: body.plan === true } })
        return [200, recorded(await enqueue(session, { type: 'send', prompt: prompt.slice(0, 8000), when, plan: body.plan === true }), session)]
      }
      if (body.type === 'task') {
        const task = String(body.task ?? '').trim()
        if (!task) return [400, { ok: false, message: 'The task is empty.' }]
        remember({ kind: 'task', text: `Tarefa: ${task}`, session: session.name, meta: { type: 'task' } })
        return [200, recorded(await enqueue(session, { type: 'task', task: task.slice(0, 8000) }), session)]
      }
      if (body.type === 'stop') {
        remember({ kind: 'task', text: 'Parar o Claude.', session: session.name, meta: { type: 'stop' } })
        return [200, recorded(await enqueue(session, { type: 'stop' }), session)]
      }
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
        context: (Array.isArray(body.context) ? body.context : []).slice(-8).map(c => clip(c, 2500)),
        turns: (Array.isArray(body.turns) ? body.turns : []).slice(-12).map(t => ({ role: t?.role === 'luke' ? 'luke' : 'user', text: clip(t?.text, 500) })),
        sessions: roster(),
        focused,
        persona: personaNow(),
        today: `${dayOf(clock())}, ${WEEKDAYS[new Date(clock()).getDay()]}, ${new Date(clock()).toTimeString().slice(0, 5)}`,
        memory: memoryBlock(['user', 'tool_result'].includes(body.kind) || !body.kind ? clip(body.text, 500) : ''),
      }
      // A tool's answer read by the brain is kept too, as data from the computer.
      if (request.kind === 'tool_result') remember({ kind: 'tool_result', text: String(body.text ?? '').slice(0, MEMORY_TEXT), untrusted: true })
      const result = await enqueue(session, { type: 'think', request }, BRAIN_WAIT_MS)
      if (!result.ok) return [502, { error: result.message }]
      try {
        const reply = JSON.parse(result.message)
        // Counted before the proposal itself is recorded (its words would match its own search).
        const { say, pending } = withDeleteCount(String(reply.say ?? ''), reply.pending ?? null)
        for (const [field, tool] of [['tool', reply.tool], ['pending', pending]]) {
          if (tool?.name) remember({ kind: 'tool_call', text: `${field === 'pending' ? 'Perguntou antes de usar' : 'Usou'} ${tool.name}: ${JSON.stringify(tool.args ?? {})}`, meta: { field, tool } })
        }
        return [200, { say, tool: reply.tool ?? null, pending }]
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
      setCall(['idle', 'connecting', 'live', 'error'].includes(body.state) ? body.state : 'idle')
      sendRoster()
      return [200, { ok: true }]
    },
    ...memoryRoutes('window'),
    // What the user and Ceci said, sent by the window in batches. Automatic notices are kept as such.
    'POST /memory/events': (_none, body) => {
      const events = Array.isArray(body.events) ? body.events.slice(0, 200) : []
      const at = clock()
      for (const event of events) {
        const kind = ['user', 'ceci', 'notice'].includes(event?.kind) ? event.kind : null
        if (!kind) continue
        // A time from the window, if sane (a batch held a while is still in order); else now.
        const when = Number(event.at)
        remember({ kind, text: String(event.text ?? '').slice(0, MEMORY_TEXT), at: Number.isFinite(when) && Math.abs(at - when) < 86_400_000 ? when : at })
      }
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
    const prompt = asrPrompt()
    const started = Date.now()
    // The window gone (it hung up, or gave up waiting) or a hung engine: stop the transcription,
    // so the engine's single slot is free for the next turn. The request closes once its body is
    // read, so it is the response that tells.
    const stop = new AbortController()
    res.on('close', () => stop.abort())
    const signal = AbortSignal.any([stop.signal, AbortSignal.timeout(sttWaitMs)])
    // Long speech (parts joined across pauses) is heard in pieces of at most 30 s, one after the
    // other: whole, it outgrew the engine's context and came back cut short or not at all (asr-split.mjs).
    const heard = []
    try {
      for (const piece of splitWav(wav)) {
        const form = new FormData()
        form.append('file', new Blob([piece], { type: 'audio/wav' }), 'speech.wav')
        form.append('model', 'qwen3-asr')
        form.append('language', 'pt')
        form.append('prompt', prompt)
        const answer = await fetch(`${url}/v1/audio/transcriptions`, { method: 'POST', body: form, signal })
        if (!answer.ok) return send(res, 502, { error: `speech engine ${answer.status}` })
        const { text = '' } = await answer.json()
        // Only the words after the ears' language tag; on silence or soft noise they can also write
        // their own prompt down, and that part is not the user (asr-leak.mjs).
        heard.push(withoutPromptLeak(asrWords(text), prompt))
      }
    } catch (error) {
      if (stop.signal.aborted) return res.end()
      if (error?.name === 'TimeoutError') return send(res, 504, { error: 'The speech engine did not answer in time.' })
      throw error
    }
    return send(res, 200, { text: heard.filter(Boolean).join(' '), ms: Date.now() - started })
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
    if (!text) return {}
    // A body that is not JSON, or JSON that is not an object (null, a list), is the caller's error:
    // 400, not a 500 from the route reading its fields.
    let body
    try {
      body = JSON.parse(text)
    } catch {
      throw Object.assign(new Error('The body is not valid JSON.'), { status: 400 })
    }
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw Object.assign(new Error('The body must be a JSON object.'), { status: 400 })
    return body
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
        const sessionId = typeof body.sessionId === 'string' ? body.sessionId.slice(0, 200) : ''
        // A session the user ended from the window stays ended: its mod hears so and turns off,
        // until the user turns luke-voice on again in that session (the button or the command).
        if (sessionId && endedIds.has(sessionId)) {
          if (body.byUser !== true) return send(res, 410, { error: 'ended' })
          endedIds.delete(sessionId)
          saveEnded()
        }
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
        // A reloaded mod subscribes again from the same Claude session: it takes over the old row.
        const previous = sessionId ? [...sessions.values()].find(s => s.sessionId === sessionId) : undefined
        if (previous) {
          sessions.delete(previous.token)
          rememberGone(replaced, previous.token)
          wake(previous)
        }
        const cwd = typeof body.cwd === 'string' ? body.cwd : ''
        const session = { token, sessionId, name: previous?.name ?? uniqueName(cwd), cwd, canThink: typeof body.version === 'string' || typeof body.provider === 'string', canSummarize: body.canSummarize === true, inbox: previous?.inbox ?? [], waiters: [], activity: [], isBusy: false, needsYou: false, seenAt: Date.now() }
        sessions.set(token, session)
        focused ??= session.name
        sendRoster()
        return send(res, 200, { token, name: session.name, hasKey: Boolean(key), provider: voiceProvider() })
      }

      if (route === 'POST /shutdown') {
        if (!sameSecret(bearer, serviceToken)) return send(res, 401, { error: 'token' })
        broadcast({ type: 'end' })
        // A call still live is closed in the memory now: the hub is about to exit.
        setCall('idle')
        send(res, 200, { ok: true })
        setTimeout(onShutdown, 100)
        return
      }

      // The memory's routes are both: a request with no session token goes on to the window's.
      if (sessionRoutes[route] && (bearer || !windowRoutes[route])) {
        const session = sessions.get(bearer)
        // A reloaded mod may still ack a command it pulled before the reload: acks are by command id.
        const isLateAck = route === 'POST /ack' && replaced.has(bearer)
        // A session ended from the window: its mod is told so, and turns itself off.
        if (!session && ended.has(bearer)) return send(res, 410, { error: 'ended' })
        if (!session && !isLateAck) return send(res, replaced.has(bearer) ? 409 : 401, { error: replaced.has(bearer) ? 'replaced' : 'session' })
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
        // The window the hub opened is up: the next /show may open another once this one closes.
        launchingUntil = 0
        res.write(`data: ${JSON.stringify({ type: 'roster', sessions: roster(), focused, call })}\n\n`)
        // Results this window has not heard yet (it was closed, or reconnecting, when they came).
        const unheard = notices.pending()
        if (unheard.length) res.write(`data: ${JSON.stringify({ type: 'notices', notices: unheard })}\n\n`)
        const ping = setInterval(() => res.write(': ping\n\n'), 20_000)
        req.on('close', () => {
          clearInterval(ping)
          streams.delete(res)
          // The last window closed (or crashed) mid-call: the call ends, in the memory too.
          if (streams.size === 0) setCall('idle')
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
  // Summaries left to write (a day that ended, a month) are looked for now and then.
  const summaries = setInterval(() => void summarize().catch(error => log(`memory: ${error?.message ?? error}`)), summarizeEveryMs)
  summaries.unref()
  server.on('close', () => {
    clearInterval(summaries)
    clearTimeout(summaryTimer)
    graph?.stop()
  })

  server.on('close', () => clearInterval(sweep))
  server.idleFor = () => Date.now() - lastBusy
  server.setEngineDownload = setEngineDownload
  // Once the engine is up, only with LUKE_VOICE_WARM_QUESTIONS=1: the questions Ceci asks most get
  // their natural takes in the background. Off by default, so a hub that just started leaves the GPU
  // alone; a question still gets its takes the first time Ceci asks it. Only while the voice is up
  // and has its reference: a take asked of a server that is down comes back empty at once.
  server.warmQuestions = () => {
    if (process.env.LUKE_VOICE_WARM_QUESTIONS !== '1') return
    if (engine?.url('tts') && loadVoiceRef()) questionTakes().warm(COMMON_QUESTIONS)
  }
  server.on('close', () => questions?.stop())
  server.voiceProvider = voiceProvider
  server.callState = () => call
  // The hub exits (idle): a call still live is closed in the memory first.
  server.endCall = () => setCall('idle')
  server.pendingAcks = () => acks.size
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
  // Ceci's memory: created here when it is missing (no question asked), opened when it is there.
  let memory = null
  try {
    memory = openMemory({ log })
    log(`memory: ${memory.file}`)
  } catch (error) {
    log(`memory: could not open it: ${error?.message ?? error}`)
  }
  // Ceci's knowledge graph, kept up to date from the memory after each call (CECI_GRAPH=0 turns it off).
  const graph = memory?.isAvailable ? createGraphUpdater({ isCallLive: () => hub?.callState() === 'live', log }) : null
  const hub = createHub({
    memory,
    graph,
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
    if (hub.idleFor() <= 10 * 60_000) return
    hub.endCall()
    process.exit(0)
  }, 60_000).unref()
}
