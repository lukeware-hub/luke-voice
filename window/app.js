// The call window: one voice call for every subscribed Claude session.
// The voice itself comes from an engine (engines/*.js); this page drives its session the same way for each.
import {
  NOTICE,
  QUIET_NOTICE,
  QUIET_OFF,
  QUIET_ON,
  REFUSED,
  createQuietMode,
  createSpeechFilter,
  createVoiceGate,
  queueSpeech,
  quoteUntrusted,
  safeKind,
  taskKey,
} from '/guard.js'
import { inputOptions, micConstraints, resolveMicrophone, saveMicrophone, savedMicrophone } from '/engines/microphone.js'
import { analyzeRecording, encodeWav, meterLevel } from '/engines/mic-test.js'

// Appearance: follows the system unless the user picked light or dark in Configurações.
// Runs before the key exchange below awaits, so the saved theme lands on the first frames.
// ponytail: a module script runs after first paint, so a forced theme opposite to the system can
// flash for a frame; an inline <head> script would fix it if that ever shows.
const THEME_ITEM = 'ceci-theme'
function applyTheme(theme) {
  if (theme === 'light' || theme === 'dark') document.documentElement.dataset.theme = theme
  else delete document.documentElement.dataset.theme
  const value = document.documentElement.dataset.theme ?? 'system'
  const group = document.querySelector('.segmented')
  if (group) group.dataset.value = value
  for (const option of document.querySelectorAll('[data-theme-option]')) {
    option.setAttribute('aria-checked', String(option.dataset.themeOption === value))
  }
}
try {
  applyTheme(localStorage.getItem(THEME_ITEM))
} catch {
  applyTheme('system')
}
for (const option of document.querySelectorAll('[data-theme-option]')) {
  option.addEventListener('click', () => {
    applyTheme(option.dataset.themeOption)
    try {
      localStorage.setItem(THEME_ITEM, option.dataset.themeOption)
    } catch {
      // No storage: the choice holds until the window closes.
    }
  })
}

// Microphone: lists the system's audio inputs and keeps the chosen one for every call.
const micSelect = document.getElementById('micSelect')
let micListed = false
async function listMicrophones() {
  if (!micSelect || !navigator.mediaDevices?.enumerateDevices) return
  const saved = savedMicrophone()
  const options = inputOptions(await navigator.mediaDevices.enumerateDevices().catch(() => []))
  micListed = options.length > 0
  micSelect.replaceChildren(
    new Option('Padrão do sistema', ''),
    ...options.map(({ id, label }) => new Option(label, id)),
  )
  // A saved microphone that is unplugged shows as the default; the choice itself stays saved.
  micSelect.value = options.some(option => option.id === saved) ? saved : ''
}
// Before the first permission the browser hides every device id, so the list would be empty.
// One short open of the microphone, when the user reaches for the list, makes the real devices show.
async function revealMicrophones() {
  if (micListed || callState === 'live' || callState === 'connecting' || micTesting) return
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
    stream.getTracks().forEach(track => track.stop())
  } catch {
    return
  }
  await listMicrophones()
}
micSelect?.addEventListener('change', () => saveMicrophone(micSelect.value))
micSelect?.addEventListener('pointerdown', () => void revealMicrophones())
micSelect?.addEventListener('focus', () => void revealMicrophones())
navigator.mediaDevices?.addEventListener?.('devicechange', listMicrophones)
listMicrophones()

// Mic test: records 5 s from the chosen microphone, then mic-test.js judges the clip.
const TEST_SECONDS = 5
const TEST_RATE = 16000
const micTestBtn = document.getElementById('micTestBtn')
const micTestLabel = document.getElementById('micTestLabel')
const micMeter = document.getElementById('micMeter')
const micResult = document.getElementById('micResult')
const micBadge = document.getElementById('micBadge')
const micTips = document.getElementById('micTips')
const micInCallNote = document.getElementById('micInCallNote')
const micPlayBtn = document.getElementById('micPlayBtn')
const micPlayIcon = document.getElementById('micPlayIcon')
const micPlayLabel = document.getElementById('micPlayLabel')
const micDevice = document.getElementById('micDevice')
let micTesting = false
// The last test clip, kept only in memory so the user can judge it by ear.
const micPlayback = new Audio()
let micPlaybackUrl = ''

function setPlaying(on) {
  micPlayIcon.setAttribute('href', on ? '#i-stop' : '#i-play-fill')
  micPlayLabel.textContent = on ? 'Parar' : 'Ouvir gravação'
}
micPlayback.addEventListener('play', () => setPlaying(true))
micPlayback.addEventListener('pause', () => setPlaying(false))
micPlayback.addEventListener('ended', () => setPlaying(false))

function setPlaybackClip(audio) {
  micPlayback.pause()
  if (micPlaybackUrl) URL.revokeObjectURL(micPlaybackUrl)
  micPlaybackUrl = audio ? URL.createObjectURL(new Blob([encodeWav(audio, TEST_RATE)], { type: 'audio/wav' })) : ''
  micPlayback.src = micPlaybackUrl
  micPlayBtn.hidden = !audio
  setPlaying(false)
}

micPlayBtn?.addEventListener('click', () => {
  if (!micPlayback.paused) {
    micPlayback.pause()
    return
  }
  micPlayback.currentTime = 0
  void micPlayback.play().catch(() => setPlaying(false))
})

function showTestResult(quality, label, tips, device = '') {
  micResult.hidden = false
  micDevice.textContent = device ? `Gravado com: ${device}` : ''
  micDevice.hidden = !device
  micResult.dataset.quality = quality
  micBadge.textContent = label
  micTips.replaceChildren(...tips.map(tip => Object.assign(document.createElement('li'), { textContent: tip })))
}

function setMicTesting(on) {
  micTesting = on
  micTestBtn.disabled = on
  micTestLabel.textContent = on ? 'Abrindo microfone...' : 'Gravar teste'
  if (!on) micMeter.style.transform = 'scaleX(0)'
}

async function recordMicTest() {
  if (micTesting) return
  if (callState === 'live' || callState === 'connecting') {
    showTestResult('ruim', 'Indisponível', ['Encerre a chamada para testar o microfone.'])
    return
  }
  setMicTesting(true)
  setPlaybackClip(null)
  micResult.hidden = true
  let stream
  let context
  try {
    // The same constraints the call uses, so the test hears what Ceci would hear.
    micTestLabel.textContent = 'Aguardando permissão...'
    // What the list shows is what is tested; an exact request fails instead of silently using another device.
    const request = navigator.mediaDevices.getUserMedia({
      audio: micConstraints(micSelect?.value ?? savedMicrophone(), { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: false }, { strict: true }),
    })
    const timeout = new Promise((_, reject) => setTimeout(() => reject(Object.assign(new Error('timeout'), { name: 'NotAllowedError' })), 15000))
    // A stream that arrives after the timeout is stopped too, or the mic stays on.
    stream = await Promise.race([request, timeout]).catch(error => {
      request.then(late => late.getTracks().forEach(track => track.stop()), () => {})
      throw error
    })
    micTestLabel.textContent = 'Gravando...'
    listMicrophones()
    context = new AudioContext({ sampleRate: TEST_RATE })
    await context.audioWorklet.addModule('/engines/mic-worklet.js')
    const frames = new AudioWorkletNode(context, 'luke-mic-frames')
    context.createMediaStreamSource(stream).connect(frames)
    const chunks = []
    frames.port.onmessage = ({ data }) => {
      chunks.push(data)
      micMeter.style.transform = `scaleX(${meterLevel(data)})`
    }
    await new Promise(resolve => setTimeout(resolve, TEST_SECONDS * 1000))
    frames.port.onmessage = null
    const audio = new Float32Array(chunks.length * 512)
    chunks.forEach((chunk, i) => audio.set(chunk, i * 512))
    const result = analyzeRecording(audio, TEST_RATE)
    showTestResult(result.quality, result.label, result.tips, stream.getAudioTracks()[0]?.label)
    setPlaybackClip(audio)
  } catch (error) {
    const denied = error?.name === 'NotAllowedError' || error?.name === 'SecurityError'
    const gone = error?.name === 'OverconstrainedError' || error?.name === 'NotFoundError'
    showTestResult('pessimo', 'Sem acesso', [
      denied
        ? 'Libere o microfone nesta janela e tente de novo.'
        : gone
          ? 'Esse microfone não está disponível agora. Confira se está ligado ou escolha outro.'
          : 'Não consegui abrir este microfone. Escolha outro e tente de novo.',
    ])
  } finally {
    stream?.getTracks().forEach(track => track.stop())
    await context?.close().catch(() => {})
    setMicTesting(false)
  }
}
micTestBtn?.addEventListener('click', () => void recordMicTest())

const params = new URLSearchParams(location.search)
const STALE_WINDOW = 'Esta janela ficou desatualizada. Feche-a e digite /luke-voice window no Claude Code.'
const KEY_ITEM = 'luke-voice-key'

// The window key never stays in the address: the hub opens this page with a one-time launch code
// (?n=), traded here once for the key. The key is kept in this tab's sessionStorage, so a reload
// still works, and the code leaves the address bar. ?k= is a window opened by a hub before 0.10.4.
async function windowKey() {
  const code = params.get('n')
  let key = params.get('k') ?? ''
  if (code) {
    const res = await fetch('/launch', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ nonce: code }) }).catch(() => null)
    key = res?.ok ? String((await res.json().catch(() => ({}))).key ?? '') : ''
  }
  try {
    if (key) sessionStorage.setItem(KEY_ITEM, key)
    else key = sessionStorage.getItem(KEY_ITEM) ?? ''
  } catch {
    // No storage (a locked-down browser): the key lives in this page only, and a reload loses it.
  }
  if (params.has('n') || params.has('k')) {
    params.delete('n')
    params.delete('k')
    history.replaceState(null, '', `${location.pathname}${params.size ? `?${params}` : ''}${location.hash}`)
  }
  return key
}
const KEY = await windowKey()
const SPEAK_AFTER_SILENCE_MS = 1500
const ACTIVITY_FLUSH_MS = 3000
const MIC_TIMEOUT_MS = 10_000
const EARLY_DROP_MS = 4000
const STREAM_RETRY_MS = 3000
const MAX_ENTRIES = 60
const RECENT = 3
const COMPACT_SIZE = [380, 560]
const SVG = 'http://www.w3.org/2000/svg'

const $ = id => document.getElementById(id)
const ui = {
  status: $('status'),
  statusText: $('statusText'),
  orb: $('orb'),
  orbIcon: $('orbIcon'),
  headline: $('headline'),
  caption: $('caption'),
  call: $('callButton'),
  callLabel: $('callLabel'),
  mute: $('muteButton'),
  muteIcon: $('muteIcon'),
  muteLabel: $('muteLabel'),
  mic: $('micButton'),
  micIcon: $('micIcon'),
  micLabel: $('micLabel'),
  recent: $('recentSessions'),
  all: $('allSessions'),
  log: $('log'),
  historyCount: $('historyCount'),
  banner: $('banner'),
  bannerIcon: $('bannerIcon'),
  bannerTitle: $('bannerTitle'),
  bannerText: $('bannerText'),
  facts: $('facts'),
}

// What each call state says, in the pill, the stage and the banner.
const STATES = {
  idle: {
    pill: 'Pronto',
    headline: 'Pronto para conversar',
    caption: 'Toque em Chamar e fale naturalmente.',
    banner: ['i-check-circle', 'Pronto para conversar!', 'Use o microfone para falar com o Claude.'],
  },
  connecting: {
    pill: 'Conectando',
    headline: 'Conectando…',
    caption: 'Preparando a chamada e o microfone.',
    banner: ['i-waveform', 'Conectando a chamada', 'Isso leva só alguns segundos.'],
  },
  live: {
    pill: 'Em chamada',
    headline: 'Aguardando sua voz…',
    caption: 'Fale naturalmente.',
    banner: ['i-waveform', 'Em chamada', 'Peça algo à Ceci. Antes de agir no computador, ela confirma com você.'],
  },
  error: {
    pill: 'Erro',
    headline: 'Algo deu errado',
    caption: '',
    banner: ['i-x-circle', 'A chamada não começou', 'Veja o motivo acima e toque em Chamar de novo.'],
  },
  offline: {
    pill: 'Hub offline',
    headline: 'Sem conexão com o luke-voice',
    caption: 'Ligue o luke-voice no Claude Code e esta janela volta sozinha.',
    banner: ['i-x-circle', 'Hub offline', 'O Claude Code precisa estar com o luke-voice ligado.'],
  },
}
const ENTRY = {
  task: ['i-play-fill', 'Tarefa'],
  result: ['i-check', 'Resultado'],
  sent: ['i-paper-plane-right', 'Enviado ao Claude'],
  stop: ['i-stop', 'Parar'],
  failed: ['i-x-circle', 'Falhou'],
  memory: ['i-chat-circle-dots', 'Memória'],
}
const SESSION_STATE = { attention: 'Precisa de você', working: 'Trabalhando…', idle: 'Pronto' }

let conversation = null
let callState = 'idle'
let mode = 'idle'
let isMuted = false
let roster = []
let focused = null
let pendingActivity = []
// What Ceci says on her own once the user is quiet: { text, id }, id set for a finished task's
// result, which the hub keeps until it is acked here (hub/notices.mjs).
let pendingSpeech = []
// Results already taken in (the hub sends unacked ones again on every connect), and the batches
// handed to the voice by number, so the one the user talks over is the one put back.
const heardNotices = new Set()
const spokenBatches = new Map()
let nextBatch = 0
let silentSince = Date.now()
let connectedAt = 0
// Bumped by every Chamar and Encerrar: a call still connecting when the user ends it (or starts
// another) is ended as soon as its session comes back, instead of going live.
let callGeneration = 0
let entries = 0
let compactRect = null
const gate = createVoiceGate()
const speech = createSpeechFilter()
const quiet = createQuietMode()

// Every "[luke-voice]" line the page logs also goes to the hub's window.log, with its time, in
// batches: the window runs in its own Chrome profile, so this is how a call can be read afterwards.
const logLines = []
for (const level of ['info', 'warn', 'error']) {
  const original = console[level].bind(console)
  console[level] = (...args) => {
    original(...args)
    // A value JSON cannot write (a cycle, a BigInt) is logged as String() would: logging never throws.
    const show = arg => {
      try {
        return JSON.stringify(arg)
      } catch {
        try {
          return String(arg)
        } catch {
          return '[unprintable]'
        }
      }
    }
    const text = args.map(arg => (typeof arg === 'string' ? arg : arg instanceof Error ? arg.message : show(arg))).join(' ')
    if (text.startsWith('[luke-voice]') && logLines.length < 500) logLines.push(`${new Date().toISOString()} ${level} ${text}`)
  }
}
setInterval(() => {
  if (logLines.length === 0 || !KEY) return
  void hub('POST', '/log', { lines: logLines.splice(0, 200) }).catch(() => {})
}, 2000)

// Every word of the call goes to Ceci's permanent memory (hub/memory.mjs), in small batches. A batch
// the hub did not take is kept and sent again, so a hub restart does not lose what was said.
let memoryBatch = []
function rememberSaid(source, message) {
  const text = String(message ?? '').trim()
  if (!text) return
  const kind = source === 'user' ? (text === NOTICE || text === QUIET_NOTICE ? 'notice' : 'user') : 'ceci'
  memoryBatch.push({ kind, text, at: Date.now() })
  if (memoryBatch.length > 2000) memoryBatch = memoryBatch.slice(-2000)
}
async function flushMemory() {
  if (memoryBatch.length === 0 || !KEY) return
  const batch = memoryBatch.splice(0, 200)
  try {
    await hub('POST', '/memory/events', { events: batch })
  } catch {
    memoryBatch = [...batch, ...memoryBatch]
  }
}
setInterval(() => void flushMemory(), 1000)

async function hub(method, path, body) {
  const res = await fetch(path, {
    method,
    headers: { 'content-type': 'application/json', 'x-luke-key': KEY },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const out = await res.json().catch(() => ({}))
  // A window opened by an older hub holds a key the current hub no longer accepts.
  if (out.error === 'key') throw new Error(STALE_WINDOW)
  if (!res.ok && out.error) throw new Error(out.error)
  return out
}

// Builds an element; text goes in through textContent only.
function el(tag, className, text) {
  const node = document.createElement(tag)
  if (className) node.className = className
  if (text !== undefined) node.textContent = text
  return node
}

function icon(id) {
  const svg = document.createElementNS(SVG, 'svg')
  svg.setAttribute('class', 'icon')
  svg.setAttribute('aria-hidden', 'true')
  const use = document.createElementNS(SVG, 'use')
  use.setAttribute('href', `#${id}`)
  svg.append(use)
  return svg
}

const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)')
const EASE_IOS = 'cubic-bezier(0.32, 0.72, 0, 1)'

// Swaps an icon with a short scale-and-blur, the way an SF Symbol replaces another.
function swapIcon(use, id) {
  const href = `#${id}`
  if (use.getAttribute('href') === href) return
  use.setAttribute('href', href)
  if (reduceMotion.matches) return
  use.ownerSVGElement?.animate(
    [
      { transform: 'scale(0.5)', opacity: 0, filter: 'blur(4px)' },
      { transform: 'none', opacity: 1, filter: 'none' },
    ],
    { duration: 380, easing: EASE_IOS },
  )
}

// New text eases in, so a status change is seen, not just swapped.
function setText(node, text) {
  if (node.textContent === text) return
  node.textContent = text
  if (!reduceMotion.matches) {
    node.animate([{ opacity: 0, transform: 'translateY(3px)' }, { opacity: 1, transform: 'none' }], { duration: 260, easing: EASE_IOS })
  }
}

const clock = () => new Date().toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })

/* ---------- Views ---------- */

function showView(name) {
  const apply = () => {
    for (const view of document.querySelectorAll('.view')) view.hidden = view.dataset.name !== name
    for (const item of document.querySelectorAll('.nav-item')) {
      if (item.dataset.target === name) item.setAttribute('aria-current', 'page')
      else item.removeAttribute('aria-current')
    }
    document.body.dataset.view = name
    if (name === 'history') {
      entries = 0
      ui.historyCount.hidden = true
    }
    if (name === 'settings') void renderFacts()
    if (name === 'memory') void loadMemory()
  }
  // The selection pill glides to the new item (a view transition); without one, it just moves.
  if (document.startViewTransition && !reduceMotion.matches && document.body.dataset.view !== name) document.startViewTransition(apply)
  else apply()
}

/* ---------- Call state ---------- */

function setStatus(state) {
  const s = STATES[state] ?? STATES.idle
  ui.status.dataset.state = state
  setText(ui.statusText, s.pill)
  const [bannerIcon, title, text] = s.banner
  ui.banner.dataset.state = state
  swapIcon(ui.bannerIcon, bannerIcon)
  setText(ui.bannerTitle, title)
  ui.bannerText.textContent = text
}

function setCaption(text, isSpeech = false) {
  ui.caption.textContent = text
  ui.caption.classList.toggle('speech', isSpeech)
}

function setOrb(next) {
  ui.orb.dataset.mode = next
  swapIcon(ui.orbIcon, next === 'muted' ? 'i-microphone-slash' : next === 'speaking' ? 'i-waveform-fill' : 'i-microphone-fill')
}

function setMuted(next) {
  isMuted = next
  conversation?.setMicMuted(isMuted || (quiet.manual && !conversation.setPaused))
  // Mutar: only the speaker's microphone. Ceci's silent mode (Silenciar) is separate.
  ui.mic.setAttribute('aria-pressed', String(isMuted))
  ui.micLabel.textContent = isMuted ? 'Desmutar' : 'Mutar'
  swapIcon(ui.micIcon, isMuted ? 'i-microphone' : 'i-microphone-slash')
  if (callState === 'live') setOrb(isMuted ? 'muted' : mode === 'speaking' ? 'speaking' : 'listening')
  // Back from mute the user usually talks first: news held meanwhile waits for a quiet moment again.
  if (!isMuted) silentSince = Date.now()
}

function setCall(state, caption) {
  callState = state
  // The stylesheet pauses the decorative loops while no call runs.
  document.body.dataset.call = state
  setStatus(state)
  const isLive = state === 'live' || state === 'connecting'
  ui.call.dataset.live = String(isLive)
  // One phone icon: the stylesheet turns it down 135° to end, as on an iPhone.
  setText(ui.callLabel, isLive ? 'Encerrar' : 'Chamar')
  ui.mute.disabled = state !== 'live'
  ui.mic.disabled = state !== 'live'
  // The test and the call would fight over the microphone.
  if (micTestBtn) micTestBtn.disabled = isLive || micTesting
  // A greyed button with no reason looks broken: say why while a call runs.
  if (micInCallNote) micInCallNote.hidden = !isLive
  ui.headline.textContent = STATES[state]?.headline ?? ''
  setCaption(caption ?? STATES[state]?.caption ?? '')
  if (state === 'live') setOrb(isMuted ? 'muted' : 'listening')
  else {
    setOrb(state === 'connecting' ? 'connecting' : state === 'error' ? 'error' : 'idle')
    if (isMuted) setMuted(false)
  }
  void hub('POST', '/call', { state }).catch(() => {})
}

/* ---------- Sessions ---------- */

// The session whose end button was pressed once: a second press within ARM_MS ends it.
const ARM_MS = 4000
let armed = { name: null, until: 0 }
let armTimer = null

function sessionRow(session, index) {
  const state = session.needsYou ? 'attention' : session.isBusy ? 'working' : 'idle'
  const row = el('div', 'session')
  row.style.setProperty('--i', String(index))
  row.dataset.state = state
  row.dataset.tone = index % 2 === 0 ? 'blue' : 'violet'
  const pick = el('button', 'session-pick')
  pick.type = 'button'
  pick.setAttribute('aria-current', String(session.name === focused))
  pick.title = session.cwd || session.name
  const avatar = el('span', 'avatar')
  avatar.append(icon(index % 2 === 0 ? 'i-waveform-fill' : 'i-terminal-window'))
  const who = el('span', 'who')
  who.append(el('span', 'name', session.name), el('span', 'state', SESSION_STATE[state]))
  const badge = session.name === focused ? el('span', 'badge', 'Ativo') : el('span', 'badge quiet', 'Falar com esta')
  pick.append(avatar, who, badge)
  pick.addEventListener('click', () => void hub('POST', '/focus', { name: session.name }))
  row.append(pick, endButton(session))
  return row
}

// Ends a session's link with Ceci, even a stuck one. Two presses, no dialog: the first turns the
// button into "Encerrar?", the second (within 4 s) ends it.
function endButton(session) {
  const isArmed = armed.name === session.name && Date.now() < armed.until
  const button = el('button', 'session-end')
  button.type = 'button'
  button.dataset.armed = String(isArmed)
  button.setAttribute('aria-label', isArmed ? `Confirmar: encerrar a sessão ${session.name}` : `Encerrar a sessão ${session.name}`)
  button.title = isArmed ? 'Toque de novo para encerrar' : 'Encerrar esta sessão'
  button.append(icon('i-x'))
  if (isArmed) button.append(el('span', 'label', 'Encerrar?'))
  button.addEventListener('click', event => {
    event.stopPropagation()
    if (armed.name === session.name && Date.now() < armed.until) return void endSession(session.name)
    armed = { name: session.name, until: Date.now() + ARM_MS }
    clearTimeout(armTimer)
    armTimer = setTimeout(() => {
      armed = { name: null, until: 0 }
      renderRoster()
    }, ARM_MS)
    renderRoster()
    // The re-rendered button keeps the keyboard focus, so Enter twice works too.
    document.querySelector(`.session-end[data-armed='true']`)?.focus()
  })
  return button
}

async function endSession(name) {
  armed = { name: null, until: 0 }
  clearTimeout(armTimer)
  const out = await hub('POST', '/session-end', { name }).catch(error => ({ ok: false, error: error.message }))
  addLog(out.ok ? 'stop' : 'failed', out.ok ? `Sessão ${name} encerrada` : `Não consegui encerrar a sessão ${name}`, { who: name })
  // Gone from the list now, without waiting for the hub's next roster.
  if (out.ok) roster = roster.filter(session => session.name !== name)
  renderRoster()
}

function renderRoster() {
  const ordered = [...roster].sort((a, b) => (b.name === focused) - (a.name === focused))
  for (const [target, list] of [
    [ui.recent, ordered.slice(0, RECENT)],
    [ui.all, ordered],
  ]) {
    target.replaceChildren()
    if (list.length === 0) {
      target.append(el('p', 'empty', 'Nenhuma sessão do Claude ligada. Ligue o luke-voice no Claude Code.'))
      continue
    }
    list.forEach((session, i) => target.append(sessionRow(session, i)))
  }
}

const sessionsLine = () =>
  `[sessions] ${roster.map(s => `${s.name}${s.name === focused ? ' (focused)' : ''}: ${s.isBusy ? 'working' : 'idle'}`).join('; ') || 'none'}`

/* ---------- History ---------- */

// One history entry, newest first. A long answer opens in full inside a <details>.
function addLog(kind, title, { body, who } = {}) {
  ui.log.querySelector('.empty')?.remove()
  const [iconId, label] = ENTRY[kind] ?? ENTRY.sent
  const item = el('li', 'entry')
  item.dataset.kind = kind
  const mark = el('span', 'mark')
  mark.append(icon(iconId))
  const meta = el('p', 'meta')
  meta.append(el('strong', '', label), el('span', '', clock()))
  if (who) meta.append(el('span', '', who))
  item.append(mark, meta, el('p', 'what', title))
  if (body) {
    const details = el('details')
    details.append(el('summary', '', 'Ver resposta'), el('p', 'body', body))
    item.append(details)
  }
  ui.log.prepend(item)
  while (ui.log.children.length > MAX_ENTRIES) ui.log.lastChild.remove()
  if (document.body.dataset.view !== 'history') {
    entries += 1
    ui.historyCount.textContent = String(entries)
    ui.historyCount.hidden = false
  }
}

/* ---------- Memory ---------- */

// Ceci's permanent memory: the conversations, newest first, a search, and deleting. A delete asks
// right here in the page (no browser dialog) and says it cannot be undone.
const memoryUi = {
  form: $('memorySearch'),
  query: $('memoryQuery'),
  stats: $('memoryStats'),
  list: $('memoryList'),
  pager: $('memoryPager'),
  size: $('memoryPageSize'),
  prev: $('memoryPrev'),
  next: $('memoryNext'),
  pageText: $('memoryPageText'),
  wipe: $('memoryWipe'),
}
// The list shows one page at a time, and only that page is asked of the hub.
let memoryPage = 1
let memoryPageSize = 10

const longDay = day => {
  const date = new Date(`${day}T12:00:00`)
  return Number.isNaN(date.getTime()) ? day : date.toLocaleDateString('pt-BR', { day: 'numeric', month: 'long', year: 'numeric' })
}
const WHO = { user: 'Você', ceci: 'Ceci', notice: 'Aviso', task: 'Pedido', tool_call: 'Ferramenta', tool_result: 'Resposta', task_result: 'Resultado' }
const whoSaid = item => WHO[item.kind] ?? (item.session ? `Sessão ${item.session}` : 'Sessão')

// "Apagar" turns into a question with two buttons; only the red one deletes.
function confirmDelete(holder, trigger, question, onYes) {
  if (holder.querySelector(':scope > .memory-confirm')) return
  const ask = el('div', 'memory-confirm')
  ask.setAttribute('role', 'group')
  const yes = el('button', 'danger-btn', 'Apagar')
  yes.type = 'button'
  const no = el('button', 'link', 'Cancelar')
  no.type = 'button'
  ask.append(el('p', '', question), yes, no)
  trigger.hidden = true
  holder.append(ask)
  const close = () => {
    ask.remove()
    trigger.hidden = false
  }
  no.addEventListener('click', close)
  yes.addEventListener('click', async () => {
    yes.disabled = true
    await onYes()
    close()
  })
  no.focus()
}

async function deleteFromMemory(scope) {
  const out = await hub('POST', '/memory/delete', { scope, how: 'window' }).catch(error => ({ error: error.message }))
  if (out.error) return addLog('failed', `A memória não mudou: ${out.error}`)
  addLog('memory', `Apaguei ${out.deleted} ${out.deleted === 1 ? 'registro' : 'registros'}.`)
  await loadMemory()
}

function lineRow(item) {
  const row = el('li', 'memory-line')
  row.dataset.kind = item.kind
  const time = new Date(item.at).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit', second: '2-digit' })
  row.append(el('span', 'memory-who', `${whoSaid(item)} · ${time}`), el('p', 'memory-text', item.text))
  return row
}

function memoryMark() {
  const mark = el('span', 'mark')
  mark.append(icon('i-clock-counter-clockwise'))
  return mark
}

function conversationEntry(c, { isOpen = false, showDay = false } = {}) {
  const item = el('li', 'entry memory-entry')
  item.dataset.kind = 'memory'
  const meta = el('p', 'meta')
  meta.append(el('strong', '', showDay ? longDay(c.day) : new Date(c.startedAt).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })), el('span', '', `#${c.id}`), el('span', '', `${c.events} ${c.events === 1 ? 'registro' : 'registros'}`))
  item.append(memoryMark(), meta, el('p', 'what', c.title || c.summary || 'Conversa sem resumo ainda'))
  if (c.title && c.summary) item.append(el('p', 'memory-summary', c.summary))
  const details = el('details')
  const lines = el('ol', 'memory-lines')
  details.append(el('summary', '', 'Ver conversa'), lines)
  const fill = async () => {
    if (lines.childElementCount) return
    const out = await hub('GET', `/memory/conversation?id=${c.id}&limit=1000`).catch(error => ({ error: error.message }))
    if (out.error) return lines.append(el('li', 'empty', out.error))
    lines.append(...out.items.map(lineRow))
  }
  details.addEventListener('toggle', () => {
    if (details.open) void fill()
  })
  const actions = el('div', 'memory-actions')
  const remove = el('button', 'link memory-delete', 'Apagar')
  remove.type = 'button'
  remove.addEventListener('click', () => confirmDelete(actions, remove, `Apagar a conversa de ${longDay(c.day)}, com ${c.events} ${c.events === 1 ? 'registro' : 'registros'}? Não dá para desfazer.`, () => deleteFromMemory({ conversation: c.id })))
  actions.append(remove)
  item.append(details, actions)
  if (isOpen) details.open = true
  return item
}

function hitEntry(hit) {
  const item = el('li', 'entry memory-entry')
  item.dataset.kind = 'memory'
  const meta = el('p', 'meta')
  meta.append(el('strong', '', longDay(hit.day)), el('span', '', `#${hit.conversation}`), el('span', '', whoSaid(hit)), el('span', '', new Date(hit.at).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit', second: '2-digit' })))
  item.append(memoryMark(), meta, el('p', 'what', hit.text))
  const actions = el('div', 'memory-actions')
  const open = el('button', 'link', 'Ver a conversa')
  open.type = 'button'
  open.addEventListener('click', async () => {
    const out = await hub('GET', `/memory/conversation?id=${hit.conversation}&limit=1`).catch(() => null)
    if (!out?.id) return
    memoryUi.list.replaceChildren(conversationEntry(out, { isOpen: true, showDay: true }))
    memoryUi.pager.hidden = true
  })
  actions.append(open)
  item.append(actions)
  return item
}

async function memoryStatsLine() {
  const s = await hub('GET', '/memory/stats').catch(() => null)
  if (!s || s.isAvailable === false) return 'A memória não está disponível agora. O que for dito fica guardado e entra nela depois.'
  if (!s.events) return 'Nenhuma conversa guardada ainda.'
  return `${s.conversations} ${s.conversations === 1 ? 'conversa' : 'conversas'} desde ${longDay(s.firstDay)}.`
}

// The pager under the list: "Página X de Y" and the two buttons, from how many items there are.
function showPager(total) {
  const pages = Math.max(1, Math.ceil(total / memoryPageSize))
  memoryUi.pager.hidden = total <= 10
  memoryUi.pageText.textContent = `Página ${memoryPage} de ${pages}`
  memoryUi.prev.disabled = memoryPage <= 1
  memoryUi.next.disabled = memoryPage >= pages
}

// One page of the memory (the conversations, or a search's hits): only that page is fetched.
// A page left empty by a delete steps back to the last one there is (only back, so it ends).
// Only the newest load draws: an older one still on its way (a fast typist, two clicks) is dropped.
let memoryLoad = 0
async function loadMemory({ page = memoryPage } = {}) {
  const load = ++memoryLoad
  const isOld = () => load !== memoryLoad
  memoryPage = Math.max(1, page)
  const query = memoryUi.query.value.trim()
  const paging = `limit=${memoryPageSize}&offset=${(memoryPage - 1) * memoryPageSize}`
  const stats = await memoryStatsLine()
  if (isOld()) return
  memoryUi.stats.textContent = stats
  const lastPage = total => Math.max(1, Math.ceil(total / memoryPageSize))
  if (query) {
    const out = await hub('GET', `/memory/search?q=${encodeURIComponent(query)}&${paging}`).catch(error => ({ error: error.message, hits: [] }))
    if (isOld()) return
    if (!out.hits?.length && out.total && lastPage(out.total) < memoryPage) return loadMemory({ page: lastPage(out.total) })
    memoryUi.list.replaceChildren(...(out.hits?.length ? out.hits.map(hitEntry) : [el('li', 'empty', out.error ?? `Nada sobre "${query}".`)]))
    showPager(out.total ?? 0)
    return
  }
  const out = await hub('GET', `/memory/conversations?${paging}`).catch(error => ({ error: error.message, conversations: [] }))
  if (isOld()) return
  const rows = out.conversations ?? []
  if (!rows.length && out.total && lastPage(out.total) < memoryPage) return loadMemory({ page: lastPage(out.total) })
  memoryUi.list.replaceChildren()
  // Grouped by day: a heading before each day's first conversation on this page.
  let lastDay = null
  for (const c of rows) {
    if (c.day !== lastDay) {
      lastDay = c.day
      memoryUi.list.append(el('li', 'memory-day', longDay(c.day)))
    }
    memoryUi.list.append(conversationEntry(c))
  }
  if (!rows.length) memoryUi.list.append(el('li', 'empty', out.error ?? 'As conversas com a Ceci aparecem aqui.'))
  showPager(out.total ?? 0)
}

// Changing page brings the top of the list into view.
async function turnMemoryPage(page) {
  await loadMemory({ page })
  memoryUi.stats.scrollIntoView({ block: 'start', behavior: 'smooth' })
}

memoryUi.form.addEventListener('submit', event => {
  event.preventDefault()
  void loadMemory({ page: 1 })
})
memoryUi.query.addEventListener('search', () => void loadMemory({ page: 1 }))
memoryUi.size.addEventListener('change', () => {
  memoryPageSize = Number(memoryUi.size.value) || 10
  void loadMemory({ page: 1 })
})
memoryUi.prev.addEventListener('click', () => void turnMemoryPage(memoryPage - 1))
memoryUi.next.addEventListener('click', () => void turnMemoryPage(memoryPage + 1))
memoryUi.wipe.addEventListener('click', async () => {
  const found = await hub('POST', '/memory/preview', { scope: { all: true } }).catch(() => null)
  const what = found ? `${found.conversations} ${found.conversations === 1 ? 'conversa' : 'conversas'} e ${found.events} ${found.events === 1 ? 'registro' : 'registros'}` : 'todas as conversas'
  confirmDelete(memoryUi.wipe.parentElement, memoryUi.wipe, `Apagar toda a memória da Ceci: ${what}? Não dá para desfazer.`, () => deleteFromMemory({ all: true }))
})

/* ---------- Settings ---------- */

// The voice rows: which voice, and what it needs or runs on.
function voiceFacts(health) {
  if (health.provider !== 'local') {
    return [
      ['Voz', 'ElevenLabs (Roberta)', ''],
      health.keyStatus === 'rejected'
        ? ['Chave da ElevenLabs', 'Recusada pela ElevenLabs', 'bad']
        : ['Chave da ElevenLabs', health.hasKey ? 'Configurada' : 'Faltando', health.hasKey ? 'ok' : 'bad'],
    ]
  }
  const info = engine?.name === 'local' ? engine.getVoiceInfo?.() : null
  const native = health.native ?? {}
  const isNative = info ? info.tts === 'native' : Boolean(native.tts && native.asr)
  const download = health.download
  const profile = download?.error
    ? [`Erro ao preparar: ${download.error}. Rode /luke-voice setup`, 'bad']
    : download?.total
      ? [`Baixando a voz natural: ${Math.min(99, Math.round((download.loaded / download.total) * 100))}%`, '']
      : health.profile === 'gpu'
        ? ['Voz natural, na placa de vídeo', 'ok']
        : health.profile === 'light'
          ? ['Voz leve, no navegador (sem placa de vídeo com 6 GB)', 'ok']
          : ['Ainda não preparado: rode /luke-voice setup', '']
  const model = isNative
    ? 'Qwen3-TTS (voz), Qwen3-ASR (ouvido), Qwen3.5 (respostas rápidas)'
    : info
      ? info.tts === 'piper'
        ? 'Piper (voz leve, para computadores mais lentos)'
        : 'Kokoro (voz), Whisper (ouvido)'
      : null
  const runsOn = isNative
    ? `placa de vídeo, pelo llama.cpp (${['tts', 'asr', 'router'].filter(name => native[name]).length} de 3 servidores rodando)`
    : info
      ? info.device === 'webgpu'
        ? 'placa de vídeo (WebGPU)'
        : `processador (${info.threads} threads)`
      : 'carrega na primeira chamada'
  return [
    ['Voz', `${['Luke', 'Nara'].includes(health.persona?.name) ? health.persona.name : 'Ceci'}, gratuita, no seu computador`, 'ok'],
    ['Perfil', ...profile],
    ...(model ? [['Modelos', model, '']] : []),
    ['Roda em', runsOn, ''],
  ]
}

async function renderFacts() {
  const health = await fetch('/health')
    .then(r => r.json())
    .catch(() => null)
  const rows = health
    ? [
        ['Versão', health.version, ''],
        ...voiceFacts(health),
        ['Sessões ligadas', String(health.sessions), ''],
        ['Chamada', STATES[health.call]?.pill ?? health.call, ''],
      ]
    : [['Hub', 'Offline', 'bad']]
  ui.facts.replaceChildren(
    ...rows.map(([term, value, tone]) => {
      const row = el('div')
      const dd = el('dd', tone, value)
      row.append(el('dt', '', term), dd)
      return row
    }),
  )
}

/* ---------- Voice ---------- */

// Tool calls arrive in bursts: pass them on as one quiet context update.
function flushActivity() {
  if (!conversation || pendingActivity.length === 0) return
  const text = pendingActivity.splice(0).join('\n')
  conversation.sendContextualUpdate(`[activity]\n${quoteUntrusted(text)}`)
}

// Finished work is said out loud once the user is quiet; nothing else speaks on its own.
function speakWhenQuiet() {
  if (!conversation || pendingSpeech.length === 0) return
  // Muted, the mic hears nothing, so the user always looks quiet: a notice spoken now would hold
  // the turn queue (a brain call and its speech) and the user's first words after unmuting wait.
  if (isMuted) return
  // Silenciar paused her: not even "Recebi uma notificação". The news waits for Reativar.
  if (quiet.manual) return
  if (mode === 'speaking' || Date.now() - silentSince < SPEAK_AFTER_SILENCE_MS) return
  // The user is mid-sentence: the news waits until they have been quiet for a moment too.
  if (conversation.isUserSpeaking?.()) {
    silentSince = Date.now()
    return
  }
  flushActivity()
  const items = pendingSpeech.splice(0)
  const batch = ++nextBatch
  spokenBatches.set(batch, items)
  // Only recent batches can still be cut while they are said.
  for (const old of spokenBatches.keys()) if (spokenBatches.size > 5) spokenBatches.delete(old)
  const text = items.map(item => item.text).join('\n')
  // The news goes in as context, never as the user's words; the user message is fixed text.
  conversation.sendContextualUpdate(`[news]\n${quoteUntrusted(text)}`)
  gate.noticeSent()
  // In silent mode the agent only says it got a notification; the result waits as context.
  // The local voice hands `batch` back to onNoticeCut if the user talks over it.
  conversation.sendUserMessage(quiet.on ? QUIET_NOTICE : NOTICE, batch)
  // Handed to the voice: the hub no longer keeps these results for a window that connects later.
  for (const item of items) ackNotice(item.id)
}

function ackNotice(id) {
  if (id) void hub('POST', '/notice-ack', { id }).catch(() => {})
}

// The user talked over Ceci while she told the news (local voice): that batch is told again once
// they are done.
function onNoticeCut(batch) {
  const items = spokenBatches.get(batch) ?? []
  spokenBatches.delete(batch)
  pendingSpeech.unshift(...items)
}

// A finished task with no call running: Ceci starts one and tells it, without being asked.
// Not while a call is connecting or broken, nor with no window key.
function callForNews() {
  if (!conversation && KEY && callState === 'idle') void startCall()
}

function onActivity(session, events) {
  for (const event of events) {
    const kind = safeKind(event.kind)
    const text = String(event.text ?? '')
    const line = `session ${session}: ${kind}: ${text}`
    const id = typeof event.id === 'string' ? event.id : null
    // A result the hub sent again (an unacked one, on reconnect) that this window already took in.
    if (id && heardNotices.has(id)) continue
    if (id) heardNotices.add(id)
    const spoken = speech.shouldSpeak(session, kind, text, id)
    if (kind === 'task_done') {
      // The same result already waiting (sent again with another id) is said once, with the first.
      if (spoken && queueSpeech(pendingSpeech, { text: `task done: ${text}`, id, kind, session, task: taskKey(session, text) })) {
        callForNews()
      } else ackNotice(id)
      const parts = text.match(/^Task: ([\s\S]*?)\nResult: ([\s\S]*)$/)
      addLog('result', parts ? parts[1] : 'Tarefa concluída', { body: parts ? parts[2] : text, who: session })
    } else if (kind === 'task_progress') {
      // In silent mode a progress line is not worth even "Recebi uma notificação".
      // Only the newest progress line of a task waits to be said, never a pile of them.
      if (spoken && !quiet.on) queueSpeech(pendingSpeech, { text: `task progress: ${text}`, id: null, kind, session, task: taskKey(session, text) })
    } else if (spoken) {
      pendingSpeech.push({ text: line, id: null })
    } else {
      pendingActivity.push(line)
    }
  }
}

// The tools that act on the computer need the user's own voice since the last automatic notice.
const clientTools = {
  luke_send_to_claude: async ({ prompt, when, session, plan }) => {
    if (!gate.allows()) return REFUSED
    const out = await hub('POST', '/command', { type: 'send', prompt, when, plan: plan === true, session: session || undefined }).catch(error => ({ ok: false, message: error.message }))
    if (out.ok) speech.expectReply(session || focused)
    addLog(out.ok ? 'sent' : 'failed', prompt, { who: session || focused })
    return out.message || (out.ok ? 'Sent.' : 'It did not go through.')
  },
  luke_stop_claude: async ({ session }) => {
    if (!gate.allows()) return REFUSED
    const out = await hub('POST', '/command', { type: 'stop', session: session || undefined }).catch(error => ({ ok: false, message: error.message }))
    addLog(out.ok ? 'stop' : 'failed', 'Parar o Claude', { who: session || focused })
    return out.message || (out.ok ? 'Stopped.' : 'It did not stop.')
  },
  luke_session_activity: async ({ session }) => {
    const out = await hub('GET', `/activity?session=${encodeURIComponent(session || '')}`).catch(error => ({ text: error.message }))
    return quoteUntrusted(out.text)
  },
  // Ceci's permanent memory. Reading needs no "ok?"; what the sessions wrote comes back quoted.
  luke_memory_search: async ({ query, from, to }) => {
    const params = new URLSearchParams({ q: String(query ?? ''), limit: '8' })
    if (from) params.set('from', String(from))
    if (to) params.set('to', String(to))
    const out = await hub('GET', `/memory/search?${params}`).catch(error => ({ error: error.message }))
    if (out.error) return `Memory search failed: ${out.error}`
    if (!out.hits?.length) return 'Nothing found in the memory for that.'
    return out.hits.map(memoryLine).join('\n')
  },
  luke_memory_conversation: async ({ which, offset }) => {
    const id = String(which ?? 'last').replace(/^#/, '') || 'last'
    const out = await hub('GET', `/memory/conversation?id=${encodeURIComponent(id)}&offset=${Number(offset) || 0}&limit=60`).catch(error => ({ error: error.message }))
    if (out.error) return out.error === 'No such conversation.' ? 'There is no such conversation in the memory.' : `Memory read failed: ${out.error}`
    const head = `Conversation #${out.id}, ${out.startedAtText ?? out.day}${out.endedAtText ? ` to ${out.endedAtText}` : ''}${out.title ? `: ${out.title}` : ''}. ${out.events} lines in all${out.offset ? `, from line ${out.offset + 1}` : ''}.${out.summary ? ` Summary: ${out.summary}` : ''}`
    const more = out.offset + out.items.length < out.events ? `\n(more: offset ${out.offset + out.items.length})` : ''
    return `${head}\n${out.items.map(memoryLine).join('\n')}${more}`
  },
  luke_memory_timeline: async ({ from, to }) => {
    const params = new URLSearchParams()
    if (from) params.set('from', String(from))
    if (to) params.set('to', String(to))
    const out = await hub('GET', `/memory/timeline?${params}`).catch(error => ({ error: error.message }))
    if (out.error) return `Memory read failed: ${out.error}`
    const lines = [...(out.months ?? []).map(m => `${m.period}: ${m.text}`), ...(out.days ?? []).map(d => `${d.period}: ${d.text}`)]
    return lines.length ? lines.join('\n') : 'Nothing in the memory for that period.'
  },
  // Deleting is for good: only after the user's own yes, like the tools that act on the computer.
  luke_memory_delete: async args => {
    if (!gate.allows()) return REFUSED
    const scope = memoryScope(args)
    if (!scope) return 'Say what to delete: a conversation, a day, some words, or all of it.'
    const out = await hub('POST', '/memory/delete', { scope, how: 'voice' }).catch(error => ({ error: error.message }))
    if (out.error) return `The memory was not changed: ${out.error}`
    addLog('memory', `Apaguei ${out.deleted} ${out.deleted === 1 ? 'registro' : 'registros'}.`)
    return out.deleted ? `Deleted ${out.deleted} lines from the memory.` : 'Nothing in the memory matched, so nothing was deleted.'
  },
}

// One remembered line for the brain: when, which conversation, who, and what (quoted if not the user's).
function memoryLine(hit) {
  const who = { user: 'usuário', ceci: 'ceci', notice: 'aviso' }[hit.kind] ?? `${hit.kind}${hit.session ? ` ${hit.session}` : ''}`
  const text = String(hit.text ?? '').replace(/\s+/g, ' ').slice(0, 600)
  return `${hit.when ?? hit.day} #${hit.conversation} ${who}: ${hit.untrusted ? quoteUntrusted(text) : text}`
}

// The scope of a delete the brain asked for: exactly one of conversation, day, search or all.
function memoryScope({ conversation, day, search, all } = {}) {
  if (all === true || all === 'true') return { all: true }
  if (conversation !== undefined && conversation !== '' && Number.isInteger(Number(String(conversation).replace(/^#/, '')))) return { conversation: Number(String(conversation).replace(/^#/, '')) }
  if (/^\d{4}-\d{2}(-\d{2})?$/.test(String(day ?? ''))) return { day: String(day) }
  if (String(search ?? '').trim()) return { search: String(search) }
  return null
}

const MIC_FALLBACK = 'O microfone escolhido em Configurações não está disponível. Nesta chamada, uso o microfone padrão do sistema.'

// The microphone, or a clear error instead of a call stuck at "connecting". Returns the device the call
// opens: the one saved in Configurações, or the system default when that one is not plugged in.
async function microphone() {
  const timeout = new Promise((_, reject) =>
    setTimeout(() => reject(new Error('Microfone indisponível: libere o microfone nesta janela e toque em Chamar.')), MIC_TIMEOUT_MS),
  )
  const stop = stream => stream.getTracks().forEach(track => track.stop())
  const request = navigator.mediaDevices.getUserMedia({ audio: micConstraints(savedMicrophone()) })
  // A stream that arrives after the timeout is stopped too, or the mic stays on with no call.
  const stream = await Promise.race([request, timeout]).catch(error => {
    request.then(stop, () => {})
    throw error
  })
  stop(stream)
  // Names only show once the permission is given.
  listMicrophones()
  // With the permission given, the list holds real ids: is the saved microphone still there?
  const devices = await navigator.mediaDevices.enumerateDevices().catch(() => [])
  return resolveMicrophone(savedMicrophone(), devices)
}

// Who answers: Ceci, or Luke or Nara when the Mac speaks with its own voice (the hub's persona).
function applyPersona(who) {
  const isLuke = who?.name === 'Luke'
  const name = isLuke || who?.name === 'Nara' ? who.name : 'Ceci'
  document.title = name
  const title = document.querySelector('h1.title')
  if (title) title.textContent = name
  const [to, he] = isLuke ? ['ao Luke', 'ele'] : [`à ${name}`, 'ela']
  STATES.live.banner[2] = `Peça algo ${to}. Antes de agir no computador, ${he} confirma com você.`
  const intro = document.getElementById('helpIntro')
  if (intro) intro.textContent = `Fale com ${isLuke ? 'o Luke' : `a ${name}`} como falaria com uma pessoa. Antes de mexer no seu computador, ${he} repete o pedido e espera o seu "sim".`
}

// The voice engine the hub picked: the free local voice, or ElevenLabs. Loaded once per page.
let engine = null
// Asked on every call: /luke-voice voz can switch the voice while this window stays open.
async function voiceEngine() {
  const { provider, persona } = await hub('GET', '/config')
  applyPersona(persona)
  if (engine?.name !== provider) engine = provider === 'elevenlabs' ? await import('/engines/elevenlabs.js') : await import('/engines/local.js')
  return engine
}

async function startCall() {
  if (conversation || callState === 'connecting') return
  const generation = ++callGeneration
  const isCurrent = () => generation === callGeneration
  setCall('connecting')
  try {
    const voice = await voiceEngine()
    if (!isCurrent()) return
    const started = await voice.startSession({
      hub,
      windowKey: KEY,
      // The engine opens the device prepare returns, never a silent stand-in for the saved one.
      prepare: async () => {
        const mic = await microphone()
        if (mic.fellBack && isCurrent()) {
          setCaption(MIC_FALLBACK)
          addLog('failed', MIC_FALLBACK)
        }
        return mic
      },
      inputDeviceId: savedMicrophone() || undefined,
      clientTools,
      onNoticeCut: batch => {
        if (isCurrent()) onNoticeCut(batch)
      },
      onStatus: (text, { isWarning = false } = {}) => {
        if (!isCurrent()) return
        if (callState === 'connecting' || isWarning) setCaption(text)
        // A voice downgrade is kept in the history too: a caption is soon replaced by Ceci's next line.
        if (isWarning) addLog('failed', text)
      },
      onConnect: async () => {
        if (!isCurrent()) return
        connectedAt = Date.now()
        window.focus()
        setCall('live')
        const snapshot = await hub('GET', '/activity').catch(() => ({ text: '' }))
        conversation?.sendContextualUpdate(`${sessionsLine()}\n[activity]\n${quoteUntrusted(snapshot.text)}`)
        // The ElevenLabs agent has no access to the memory otherwise: what it holds goes in now.
        if (engine?.name === 'elevenlabs') {
          const remembered = await hub('GET', '/memory/digest').catch(() => ({ text: '' }))
          if (remembered.text) conversation?.sendContextualUpdate(`[memory]\n${remembered.text}`)
        }
      },
      onDisconnect: details => {
        // A session ended because its call was ended while it connected: nothing to show.
        if (!isCurrent()) return
        const wasEnded = conversation === null
        conversation = null
        // Dropped by the voice (ElevenLabs), not by Encerrar: the same cleanup as endCall.
        clearCall()
        void flushMemory()
        // A call the agent drops in its first seconds never really started: say so, with the reason.
        if (!wasEnded && Date.now() - connectedAt < EARLY_DROP_MS) {
          const reason = details?.message || details?.reason || ''
          setCall('error', engine?.earlyDropMessage(reason) ?? reason)
          return
        }
        setCall('idle', 'Chamada encerrada. Toque em Chamar para falar de novo.')
      },
      onError: message => {
        if (!isCurrent()) return
        // One failed turn does not end a live call: the error is shown and the call, the mic and
        // its mute stay as they are (an error state would unmute the mic while the session runs).
        if (callState === 'live') return setCaption(`Erro na chamada: ${message}`)
        setCall('error', `Erro na chamada: ${message}`)
      },
      onModeChange: ({ mode: next }) => {
        if (!isCurrent()) return
        mode = next
        if (callState === 'live') {
          setOrb(isMuted ? 'muted' : next === 'speaking' ? 'speaking' : 'listening')
          ui.headline.textContent = quiet.manual ? 'Modo silêncio' : next === 'speaking' ? 'Falando…' : quiet.on ? 'Modo silêncio' : STATES.live.headline
        }
        if (next !== 'speaking') silentSince = Date.now()
      },
      onMessage: ({ source, message }) => {
        if (!isCurrent()) return
        rememberSaid(source, message)
        if (source === 'user') {
          gate.userSpoke(message)
          const change = quiet.userSpoke(message)
          if (change) {
            conversation?.sendContextualUpdate(change === 'on' ? QUIET_ON : QUIET_OFF)
            ui.headline.textContent = change === 'on' ? 'Modo silêncio' : STATES.live.headline
            ui.mute.setAttribute('aria-pressed', String(quiet.on))
            ui.muteLabel.textContent = quiet.on ? 'Reativar' : 'Silenciar'
            swapIcon(ui.muteIcon, quiet.on ? 'i-play-fill' : 'i-waveform')
          }
        }
        if (source === 'ai') setCaption(message.replace(/\[[a-z ]+\]\s*/gi, ''), true)
      },
    })
    if (!isCurrent()) {
      await started.endSession().catch(() => {})
      return
    }
    conversation = started
  } catch (error) {
    if (!isCurrent()) return
    conversation = null
    setCall('error', String(error.message ?? error))
  }
}

// Silenciar: Ceci's silent mode, set by hand. It never touches the microphone.
function setSilent(next) {
  const change = quiet.toggle(next)
  ui.mute.setAttribute('aria-pressed', String(quiet.on))
  ui.muteLabel.textContent = quiet.on ? 'Reativar' : 'Silenciar'
  swapIcon(ui.muteIcon, quiet.on ? 'i-play-fill' : 'i-waveform')
  applyPause()
  if (!change) return
  conversation?.sendContextualUpdate(change === 'on' ? QUIET_ON : QUIET_OFF)
  if (callState === 'live') ui.headline.textContent = quiet.on ? 'Modo silêncio' : mode === 'speaking' ? 'Falando…' : STATES.live.headline
  // Back from silence the news held meanwhile waits for a quiet moment again.
  if (!quiet.manual) {
    silentSince = Date.now()
    speakWhenQuiet()
  }
}

// The Silenciar button pauses Ceci for real: she stops speaking (resuming where she stopped) and
// hearing. The voice engine that cannot freeze its audio gets the closest thing: volume and mic off.
function applyPause() {
  if (!conversation) return
  const paused = quiet.manual
  if (conversation.setPaused) return conversation.setPaused(paused)
  conversation.setVolume?.({ volume: paused ? 0 : 1 })
  conversation.setMicMuted(isMuted || paused)
}

// What a call leaves behind when it ends, by the user or dropped by the voice.
function clearCall() {
  pendingActivity = []
  // Finished tasks' results stay: they are told in the next call (the hub keeps them too).
  pendingSpeech = pendingSpeech.filter(item => item.id)
  speech.clear()
  quiet.clear()
  setSilent(false)
}

async function endCall() {
  callGeneration++
  const current = conversation
  conversation = null
  clearCall()
  await current?.endSession().catch(() => {})
  // The last words reach the memory before the call is closed there.
  await flushMemory()
  setCall('idle', 'Chamada encerrada. Toque em Chamar para falar de novo.')
}

function connectStream() {
  const stream = new EventSource(`/stream?k=${encodeURIComponent(KEY)}`)
  stream.onmessage = ({ data }) => {
    const message = JSON.parse(data)
    if (message.type === 'roster') {
      const wasFocused = focused
      roster = message.sessions
      focused = message.focused
      renderRoster()
      if (conversation && wasFocused !== focused) conversation.sendContextualUpdate(sessionsLine())
    } else if (message.type === 'activity') {
      onActivity(message.session, message.events)
    } else if (message.type === 'notices') {
      // Results that came while this window was closed or reconnecting.
      for (const notice of message.notices ?? []) onActivity(notice.session, [{ kind: 'task_done', text: notice.text, id: notice.id }])
    } else if (message.type === 'focus') {
      focused = message.name
      renderRoster()
      if (message.startCall) void startCall()
    } else if (message.type === 'end') {
      void endCall()
    }
  }
  stream.onopen = () => {
    if (ui.status.dataset.state === 'offline') setCall(callState === 'offline' ? 'idle' : callState)
  }
  stream.onerror = () => {
    // A call still connecting keeps its state: it ends or goes live on its own.
    if (!conversation && callState !== 'connecting') {
      callState = 'offline'
      setStatus('offline')
      ui.headline.textContent = STATES.offline.headline
      setCaption(STATES.offline.caption)
      setOrb('idle')
    }
    // The browser retries a dropped stream by itself, but not a refused one (a 403: the hub
    // restarted and no longer takes this window's key). Ask the hub why: a stale key says so,
    // anything else connects again in a moment.
    if (stream.readyState !== EventSource.CLOSED) return
    hub('GET', '/engine').then(
      () => setTimeout(connectStream, STREAM_RETRY_MS),
      error => {
        if (error.message === STALE_WINDOW) setCall('error', STALE_WINDOW)
        else setTimeout(connectStream, STREAM_RETRY_MS)
      },
    )
  }
}

/* ---------- Compact mode ---------- */

// The Chrome app window has its own minimize, maximize and close buttons, so the page draws none.
// Nothing calls this now: the button that did is gone, and the compact styles wait for a new one.
function toggleCompact() {
  const next = document.body.dataset.compact !== 'true'
  document.body.dataset.compact = String(next)
  if (next) {
    showView('home')
    compactRect = { w: window.outerWidth, h: window.outerHeight }
    window.resizeTo(...COMPACT_SIZE)
  } else if (compactRect) {
    window.resizeTo(compactRect.w, compactRect.h)
    compactRect = null
  }
}

/* ---------- Wiring ---------- */

ui.call.addEventListener('click', () => void (conversation || callState === 'connecting' ? endCall() : startCall()))
ui.mute.addEventListener('click', () => setSilent(!quiet.on))
ui.mic.addEventListener('click', () => setMuted(!isMuted))
for (const control of document.querySelectorAll('[data-target]')) {
  control.addEventListener('click', () => showView(control.dataset.target))
}
window.addEventListener('beforeunload', () => void conversation?.endSession())

// The orb follows the agent's voice: every frame while she speaks, and only four times a second
// otherwise (the level is 0 then), so an idle window does not run a loop at the display's rate.
let shownLevel = ''
function animate() {
  const isSpeaking = Boolean(conversation) && mode === 'speaking' && !document.hidden
  const level = (isSpeaking ? Math.min(1, conversation.getOutputVolume() * 2.5) : 0).toFixed(3)
  if (level !== shownLevel) ui.orb.style.setProperty('--level', (shownLevel = level))
  if (isSpeaking) requestAnimationFrame(animate)
  else setTimeout(animate, 250)
}
const syncHidden = () => (document.body.dataset.hidden = String(document.hidden))
document.addEventListener('visibilitychange', syncHidden)
syncHidden()

ui.log.append(el('li', 'empty', 'Nada por aqui ainda. O que você pedir por voz aparece nesta lista.'))

// Chrome reopens the app window at the size it last had. A narrow one from an older version
// hides the rail, so give it the size this layout is made for, once per load.
if (window.outerWidth < 640 && window.outerHeight > 0 && document.body.dataset.compact !== 'true') {
  try {
    window.resizeTo(760, 900)
  } catch {
    // A normal browser tab cannot be resized; the narrow layout still works there.
  }
}

setCall(KEY ? 'idle' : 'error', KEY ? undefined : STALE_WINDOW)
renderRoster()
if (KEY) connectStream()
setInterval(flushActivity, ACTIVITY_FLUSH_MS)
setInterval(speakWhenQuiet, 500)
requestAnimationFrame(animate)
if (params.get('call') === '1') void startCall()
