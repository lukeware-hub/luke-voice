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
  quoteUntrusted,
  safeKind,
} from '/guard.js'

const params = new URLSearchParams(location.search)
const KEY = params.get('k') ?? ''
const STALE_WINDOW = 'Esta janela ficou desatualizada. Feche-a e digite /luke-voice window no Claude Code.'
const SPEAK_AFTER_SILENCE_MS = 1500
const ACTIVITY_FLUSH_MS = 3000
const MIC_TIMEOUT_MS = 10_000
const EARLY_DROP_MS = 4000
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
  callIcon: $('callIcon'),
  callLabel: $('callLabel'),
  mute: $('muteButton'),
  muteIcon: $('muteIcon'),
  muteLabel: $('muteLabel'),
  recent: $('recentSessions'),
  all: $('allSessions'),
  log: $('log'),
  historyCount: $('historyCount'),
  banner: $('banner'),
  bannerIcon: $('bannerIcon'),
  bannerTitle: $('bannerTitle'),
  bannerText: $('bannerText'),
  facts: $('facts'),
  winCompact: $('winCompact'),
  winMax: $('winMax'),
  winMaxIcon: $('winMaxIcon'),
  winClose: $('winClose'),
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
}
const SESSION_STATE = { attention: 'Precisa de você', working: 'Trabalhando…', idle: 'Pronto' }

let conversation = null
let callState = 'idle'
let mode = 'idle'
let isMuted = false
let roster = []
let focused = null
let pendingActivity = []
let pendingSpeech = []
let silentSince = Date.now()
let connectedAt = 0
let entries = 0
let restoreRect = null
let compactRect = null
const gate = createVoiceGate()
const speech = createSpeechFilter()
const quiet = createQuietMode()

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

const clock = () => new Date().toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })

/* ---------- Views ---------- */

function showView(name) {
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
}

/* ---------- Call state ---------- */

function setStatus(state) {
  const s = STATES[state] ?? STATES.idle
  ui.status.dataset.state = state
  ui.statusText.textContent = s.pill
  const [bannerIcon, title, text] = s.banner
  ui.banner.dataset.state = state
  ui.bannerIcon.setAttribute('href', `#${bannerIcon}`)
  ui.bannerTitle.textContent = title
  ui.bannerText.textContent = text
}

function setCaption(text, isSpeech = false) {
  ui.caption.textContent = text
  ui.caption.classList.toggle('speech', isSpeech)
}

function setOrb(next) {
  ui.orb.dataset.mode = next
  ui.orbIcon.setAttribute('href', next === 'muted' ? '#i-microphone-slash' : next === 'speaking' ? '#i-waveform-fill' : '#i-microphone-fill')
}

function setMuted(next) {
  isMuted = next
  conversation?.setMicMuted(isMuted)
  ui.mute.setAttribute('aria-pressed', String(isMuted))
  ui.muteLabel.textContent = isMuted ? 'Ativar som' : 'Silenciar'
  ui.muteIcon.setAttribute('href', isMuted ? '#i-microphone' : '#i-microphone-slash')
  if (callState === 'live') setOrb(isMuted ? 'muted' : mode === 'speaking' ? 'speaking' : 'listening')
}

function setCall(state, caption) {
  callState = state
  setStatus(state)
  const isLive = state === 'live' || state === 'connecting'
  ui.call.dataset.live = String(isLive)
  ui.callIcon.setAttribute('href', isLive ? '#i-phone-x' : '#i-phone-fill')
  ui.callLabel.textContent = isLive ? 'Encerrar' : 'Chamar'
  ui.mute.disabled = state !== 'live'
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

function sessionRow(session, index) {
  const state = session.needsYou ? 'attention' : session.isBusy ? 'working' : 'idle'
  const row = el('button', 'session')
  row.type = 'button'
  row.style.setProperty('--i', String(index))
  row.dataset.state = state
  row.dataset.tone = index % 2 === 0 ? 'blue' : 'violet'
  row.setAttribute('aria-current', String(session.name === focused))
  row.title = session.cwd || session.name
  const avatar = el('span', 'avatar')
  avatar.append(icon(index % 2 === 0 ? 'i-waveform-fill' : 'i-terminal-window'))
  const who = el('span', 'who')
  who.append(el('span', 'name', session.name), el('span', 'state', SESSION_STATE[state]))
  const badge = session.name === focused ? el('span', 'badge', 'Ativo') : el('span', 'badge quiet', 'Falar com esta')
  row.append(avatar, who, badge)
  row.addEventListener('click', () => void hub('POST', '/focus', { name: session.name }))
  return row
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

/* ---------- Settings ---------- */

async function renderFacts() {
  const health = await fetch('/health')
    .then(r => r.json())
    .catch(() => null)
  const rows = health
    ? [
        ['Versão', health.version, ''],
        health.keyStatus === 'rejected'
          ? ['Chave da ElevenLabs', 'Recusada pela ElevenLabs', 'bad']
          : ['Chave da ElevenLabs', health.hasKey ? 'Configurada' : 'Faltando', health.hasKey ? 'ok' : 'bad'],
        ['Voz', 'Roberta, português do Brasil', ''],
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
  if (mode === 'speaking' || Date.now() - silentSince < SPEAK_AFTER_SILENCE_MS) return
  flushActivity()
  const text = pendingSpeech.splice(0).join('\n')
  // The news goes in as context, never as the user's words; the user message is fixed text.
  conversation.sendContextualUpdate(`[news]\n${quoteUntrusted(text)}`)
  gate.noticeSent()
  // In silent mode the agent only says it got a notification; the result waits as context.
  conversation.sendUserMessage(quiet.on ? QUIET_NOTICE : NOTICE)
}

function onActivity(session, events) {
  for (const event of events) {
    const kind = safeKind(event.kind)
    const text = String(event.text ?? '')
    const line = `session ${session}: ${kind}: ${text}`
    const spoken = speech.shouldSpeak(session, kind, text)
    if (kind === 'task_done') {
      if (spoken) pendingSpeech.push(`task done: ${text}`)
      const parts = text.match(/^Task: ([\s\S]*?)\nResult: ([\s\S]*)$/)
      addLog('result', parts ? parts[1] : 'Tarefa concluída', { body: parts ? parts[2] : text, who: session })
    } else if (spoken) {
      pendingSpeech.push(line)
    } else {
      pendingActivity.push(line)
    }
  }
}

// The tools that act on the computer need the user's own voice since the last automatic notice.
const clientTools = {
  luke_run_task: async ({ task, session }) => {
    if (!gate.allows()) return REFUSED
    const out = await hub('POST', '/command', { type: 'task', task, session: session || undefined }).catch(error => ({ ok: false, message: error.message }))
    addLog(out.ok ? 'task' : 'failed', task, { who: session || focused })
    return out.message || (out.ok ? 'Started.' : 'It did not start.')
  },
  luke_send_to_claude: async ({ prompt, when, session }) => {
    if (!gate.allows()) return REFUSED
    const out = await hub('POST', '/command', { type: 'send', prompt, when, session: session || undefined }).catch(error => ({ ok: false, message: error.message }))
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
}

// The microphone, or a clear error instead of a call stuck at "connecting".
async function microphone() {
  const timeout = new Promise((_, reject) =>
    setTimeout(() => reject(new Error('Microfone indisponível: libere o microfone nesta janela e toque em Chamar.')), MIC_TIMEOUT_MS),
  )
  const stream = await Promise.race([navigator.mediaDevices.getUserMedia({ audio: true }), timeout])
  for (const track of stream.getTracks()) track.stop()
}

// The voice engine the hub picked: the free local voice, or ElevenLabs. Loaded once per page.
let engine = null
async function voiceEngine() {
  if (engine) return engine
  const { provider } = await hub('GET', '/config')
  engine = provider === 'elevenlabs' ? await import('/engines/elevenlabs.js') : await import('/engines/local.js')
  return engine
}

async function startCall() {
  if (conversation || callState === 'connecting') return
  setCall('connecting')
  try {
    const voice = await voiceEngine()
    conversation = await voice.startSession({
      hub,
      prepare: microphone,
      clientTools,
      onStatus: text => {
        if (callState === 'connecting') setCaption(text)
      },
      onConnect: async () => {
        connectedAt = Date.now()
        window.focus()
        setCall('live')
        const snapshot = await hub('GET', '/activity').catch(() => ({ text: '' }))
        conversation?.sendContextualUpdate(`${sessionsLine()}\n[activity]\n${quoteUntrusted(snapshot.text)}`)
      },
      onDisconnect: details => {
        const wasEnded = conversation === null
        conversation = null
        // A call the agent drops in its first seconds never really started: say so, with the reason.
        if (!wasEnded && Date.now() - connectedAt < EARLY_DROP_MS) {
          const reason = details?.message || details?.reason || ''
          setCall('error', engine?.earlyDropMessage(reason) ?? reason)
          return
        }
        setCall('idle', 'Chamada encerrada. Toque em Chamar para falar de novo.')
      },
      onError: message => setCall('error', `Erro na chamada: ${message}`),
      onModeChange: ({ mode: next }) => {
        mode = next
        if (callState === 'live') {
          setOrb(isMuted ? 'muted' : next === 'speaking' ? 'speaking' : 'listening')
          ui.headline.textContent = next === 'speaking' ? 'Falando…' : quiet.on ? 'Modo silêncio' : STATES.live.headline
        }
        if (next !== 'speaking') silentSince = Date.now()
      },
      onMessage: ({ source, message }) => {
        if (source === 'user') {
          gate.userSpoke(message)
          const change = quiet.userSpoke(message)
          if (change) {
            conversation?.sendContextualUpdate(change === 'on' ? QUIET_ON : QUIET_OFF)
            ui.headline.textContent = change === 'on' ? 'Modo silêncio' : STATES.live.headline
          }
        }
        if (source === 'ai') setCaption(message.replace(/\[[a-z ]+\]\s*/gi, ''), true)
      },
    })
  } catch (error) {
    conversation = null
    setCall('error', String(error.message ?? error))
  }
}

async function endCall() {
  const current = conversation
  conversation = null
  pendingActivity = []
  pendingSpeech = []
  speech.clear()
  quiet.clear()
  await current?.endSession().catch(() => {})
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
    if (!conversation) {
      callState = 'offline'
      setStatus('offline')
      ui.headline.textContent = STATES.offline.headline
      setCaption(STATES.offline.caption)
      setOrb('idle')
    }
  }
}

/* ---------- Window controls ---------- */

// The Chrome app window keeps its own title bar; these controls do what a page can do.
function isMaximized() {
  return window.outerWidth >= screen.availWidth - 8 && window.outerHeight >= screen.availHeight - 8
}

function syncMaxIcon() {
  const max = isMaximized()
  ui.winMaxIcon.setAttribute('href', max ? '#i-corners-in' : '#i-corners-out')
  ui.winMax.setAttribute('aria-label', max ? 'Restaurar tamanho' : 'Maximizar')
}

function toggleMaximize() {
  if (isMaximized() && restoreRect) {
    window.resizeTo(restoreRect.w, restoreRect.h)
    window.moveTo(restoreRect.x, restoreRect.y)
    restoreRect = null
  } else {
    restoreRect = { x: window.screenX, y: window.screenY, w: window.outerWidth, h: window.outerHeight }
    window.moveTo(screen.availLeft ?? 0, screen.availTop ?? 0)
    window.resizeTo(screen.availWidth, screen.availHeight)
  }
  setTimeout(syncMaxIcon, 150)
}

function toggleCompact() {
  const next = document.body.dataset.compact !== 'true'
  document.body.dataset.compact = String(next)
  ui.winCompact.setAttribute('aria-pressed', String(next))
  ui.winCompact.setAttribute('aria-label', next ? 'Sair do modo compacto' : 'Modo compacto')
  if (next) {
    showView('home')
    compactRect = { w: window.outerWidth, h: window.outerHeight }
    window.resizeTo(...COMPACT_SIZE)
  } else if (compactRect) {
    window.resizeTo(compactRect.w, compactRect.h)
    compactRect = null
  }
}

async function closeWindow() {
  await endCall()
  window.close()
  // A tab the page did not open stays open: say how to close it.
  setTimeout(() => setCaption('Chamada encerrada. Feche esta janela pela barra do Windows.'), 300)
}

/* ---------- Wiring ---------- */

ui.call.addEventListener('click', () => void (conversation || callState === 'connecting' ? endCall() : startCall()))
ui.mute.addEventListener('click', () => setMuted(!isMuted))
for (const control of document.querySelectorAll('[data-target]')) {
  control.addEventListener('click', () => showView(control.dataset.target))
}
ui.winCompact.addEventListener('click', toggleCompact)
ui.winMax.addEventListener('click', toggleMaximize)
ui.winClose.addEventListener('click', () => void closeWindow())
window.addEventListener('resize', syncMaxIcon)
window.addEventListener('beforeunload', () => void conversation?.endSession())

// The orb follows the agent's voice.
function animate() {
  const level = conversation && mode === 'speaking' ? Math.min(1, conversation.getOutputVolume() * 2.5) : 0
  ui.orb.style.setProperty('--level', level.toFixed(3))
  requestAnimationFrame(animate)
}

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

setCall('idle')
renderRoster()
syncMaxIcon()
connectStream()
setInterval(flushActivity, ACTIVITY_FLUSH_MS)
setInterval(speakWhenQuiet, 500)
requestAnimationFrame(animate)
if (params.get('call') === '1') void startCall()
