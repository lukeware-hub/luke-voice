// The call window: one voice call for every subscribed Claude session.
// The ElevenLabs key never reaches this page; the hub hands it a per-call token.
// The ElevenLabs client comes from a pinned CDN file that index.html loads with an integrity hash.
import { NOTICE, REFUSED, createVoiceGate, quoteUntrusted, safeKind } from '/guard.js'

const { Conversation } = window.ElevenLabsClient

const params = new URLSearchParams(location.search)
const KEY = params.get('k') ?? ''
const SPEAK_AFTER_SILENCE_MS = 1500
const ACTIVITY_FLUSH_MS = 3000
const MIC_TIMEOUT_MS = 10_000

const $ = id => document.getElementById(id)
const ui = {
  status: $('status'),
  statusText: $('statusText'),
  orb: $('orb'),
  caption: $('caption'),
  call: $('callButton'),
  callIcon: $('callIcon'),
  callLabel: $('callLabel'),
  mute: $('muteButton'),
  muteIcon: $('muteIcon'),
  muteLabel: $('muteLabel'),
  sessions: $('sessions'),
  log: $('log'),
}
const MAX_ENTRIES = 50
const SVG = 'http://www.w3.org/2000/svg'
const STATE_TEXT = { idle: 'pronto', connecting: 'conectando', live: 'em chamada', error: 'erro', offline: 'hub offline' }
const ICONS = { task: 'i-play', result: 'i-check', sent: 'i-send', stop: 'i-stop', failed: 'i-x' }
const KIND_TEXT = { task: 'Tarefa', result: 'Resultado', sent: 'Enviado ao Claude', stop: 'Parar', failed: 'Falhou' }
const CHIP_TEXT = { attention: 'precisa de você', working: 'trabalhando', idle: 'ocioso' }

let conversation = null
let callState = 'idle'
let mode = 'idle'
let isMuted = false
let roster = []
let focused = null
let pendingActivity = []
let pendingSpeech = []
let silentSince = Date.now()
const gate = createVoiceGate()

async function hub(method, path, body) {
  const res = await fetch(path, {
    method,
    headers: { 'content-type': 'application/json', 'x-luke-key': KEY },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const out = await res.json().catch(() => ({}))
  if (!res.ok && out.error) throw new Error(out.error)
  return out
}

function setStatus(state) {
  ui.status.dataset.state = state
  ui.statusText.textContent = STATE_TEXT[state] ?? state
}

function setMuted(next) {
  isMuted = next
  conversation?.setMicMuted(isMuted)
  ui.mute.setAttribute('aria-pressed', String(isMuted))
  ui.muteIcon.setAttribute('href', isMuted ? '#i-mic-off' : '#i-mic')
  ui.muteLabel.textContent = isMuted ? 'Ativar som' : 'Silenciar'
}

function setCall(state, caption) {
  callState = state
  setStatus(state)
  const isLive = state === 'live' || state === 'connecting'
  ui.call.dataset.live = String(isLive)
  ui.callIcon.setAttribute('href', isLive ? '#i-hangup' : '#i-phone')
  ui.callLabel.textContent = isLive ? 'Encerrar' : 'Ligar'
  ui.mute.disabled = state !== 'live'
  if (state !== 'live') {
    ui.orb.dataset.mode = 'idle'
    setMuted(false)
  }
  if (caption) ui.caption.textContent = caption
  void hub('POST', '/call', { state }).catch(() => {})
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

// One activity entry, newest first. A long answer opens in full inside a <details>.
function addLog(kind, title, { body, who } = {}) {
  ui.log.querySelector('.empty')?.remove()
  const item = el('li', 'entry')
  item.dataset.kind = kind
  const badge = el('span', 'badge')
  badge.append(icon(ICONS[kind] ?? 'i-send'))
  const meta = el('p', 'meta')
  meta.append(el('strong', '', KIND_TEXT[kind] ?? kind), el('span', '', clock()))
  if (who) meta.append(el('span', '', who))
  item.append(badge, meta, el('p', 'title', title))
  if (body) {
    const details = el('details')
    details.append(el('summary', '', 'Ver resposta'), el('p', 'body', body))
    item.append(details)
  }
  ui.log.prepend(item)
  while (ui.log.children.length > MAX_ENTRIES) ui.log.lastChild.remove()
}

function renderRoster() {
  ui.sessions.replaceChildren()
  if (roster.length === 0) {
    ui.sessions.append(el('p', 'empty', 'Nenhuma sessão do Claude. Ligue o luke-voice no Claude Code.'))
    return
  }
  for (const session of roster) {
    const item = el('button', 'session')
    item.type = 'button'
    item.setAttribute('aria-current', String(session.name === focused))
    item.title = session.cwd || session.name
    const state = session.needsYou ? 'attention' : session.isBusy ? 'working' : 'idle'
    const chip = el('span', 'chip', CHIP_TEXT[state])
    chip.dataset.state = state
    item.append(el('span', 'name', session.name), chip, el('span', 'cwd', session.cwd || ''))
    item.addEventListener('click', () => void hub('POST', '/focus', { name: session.name }))
    ui.sessions.append(item)
  }
}

const sessionsLine = () =>
  `[sessions] ${roster.map(s => `${s.name}${s.name === focused ? ' (focused)' : ''}: ${s.isBusy ? 'working' : 'idle'}`).join('; ') || 'none'}`

// Tool calls arrive in bursts: pass them on as one quiet context update.
function flushActivity() {
  if (!conversation || pendingActivity.length === 0) return
  const text = pendingActivity.splice(0).join('\n')
  conversation.sendContextualUpdate(`[activity]\n${quoteUntrusted(text)}`)
}

// A finished turn or a permission wait is worth saying out loud, once the user is quiet.
function speakWhenQuiet() {
  if (!conversation || pendingSpeech.length === 0) return
  if (mode === 'speaking' || Date.now() - silentSince < SPEAK_AFTER_SILENCE_MS) return
  flushActivity()
  const text = pendingSpeech.splice(0).join('\n')
  // The news goes in as context, never as the user's words; the user message is fixed text.
  conversation.sendContextualUpdate(`[news]\n${quoteUntrusted(text)}`)
  gate.noticeSent()
  conversation.sendUserMessage(NOTICE)
}

function onActivity(session, events) {
  for (const event of events) {
    const kind = safeKind(event.kind)
    const text = String(event.text ?? '')
    const line = `session ${session}: ${kind}: ${text}`
    if (kind === 'task_done') {
      pendingSpeech.push(`task done: ${text}`)
      const parts = text.match(/^Task: ([\s\S]*?)\nResult: ([\s\S]*)$/)
      addLog('result', parts ? parts[1] : 'Tarefa concluída', { body: parts ? parts[2] : text, who: session })
    } else if (kind === 'done' || kind === 'attention') {
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
    setTimeout(() => reject(new Error('Microfone indisponível: libere o microfone nesta janela e toque em Ligar.')), MIC_TIMEOUT_MS),
  )
  const stream = await Promise.race([navigator.mediaDevices.getUserMedia({ audio: true }), timeout])
  for (const track of stream.getTracks()) track.stop()
}

async function startCall() {
  if (conversation || callState === 'connecting') return
  setCall('connecting', 'Conectando…')
  try {
    // The token first: it also sets up the agent, and its errors say what is missing.
    const { token } = await hub('POST', '/token')
    await microphone()
    conversation = await Conversation.startSession({
      conversationToken: token,
      connectionType: 'webrtc',
      clientTools,
      onConnect: async () => {
        window.focus()
        setCall('live', 'Estou ouvindo. Pode falar.')
        const snapshot = await hub('GET', '/activity').catch(() => ({ text: '' }))
        conversation?.sendContextualUpdate(`${sessionsLine()}\n[activity]\n${quoteUntrusted(snapshot.text)}`)
      },
      onDisconnect: () => {
        conversation = null
        setCall('idle', 'Chamada encerrada.')
      },
      onError: message => setCall('error', `Erro na chamada: ${message}`),
      onModeChange: ({ mode: next }) => {
        mode = next
        ui.orb.dataset.mode = next
        if (next !== 'speaking') silentSince = Date.now()
      },
      onMessage: ({ source, message }) => {
        if (source === 'user') gate.userSpoke(message)
        if (source === 'ai') ui.caption.textContent = message.replace(/\[[a-z ]+\]\s*/gi, '')
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
  await current?.endSession().catch(() => {})
  setCall('idle', 'Chamada encerrada.')
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
  stream.onopen = () => setStatus(callState)
  stream.onerror = () => setStatus('offline')
}

ui.call.addEventListener('click', () => void (conversation || callState === 'connecting' ? endCall() : startCall()))
ui.mute.addEventListener('click', () => setMuted(!isMuted))
window.addEventListener('beforeunload', () => void conversation?.endSession())

// The orb follows the agent's voice.
function animate() {
  const level = conversation && mode === 'speaking' ? Math.min(1, conversation.getOutputVolume() * 2.5) : 0
  ui.orb.style.setProperty('--level', level.toFixed(3))
  requestAnimationFrame(animate)
}

ui.log.append(el('li', 'empty', 'Nada por aqui ainda. O que você pedir aparece nesta lista.'))

setCall('idle')
renderRoster()
connectStream()
setInterval(flushActivity, ACTIVITY_FLUSH_MS)
setInterval(speakWhenQuiet, 500)
requestAnimationFrame(animate)
if (params.get('call') === '1') void startCall()
