// The call window: one voice call for every subscribed Claude session.
// The ElevenLabs key never reaches this page; the hub hands it a per-call token.
import { Conversation } from 'https://cdn.jsdelivr.net/npm/@elevenlabs/client@1.26.0/+esm'

const params = new URLSearchParams(location.search)
const KEY = params.get('k') ?? ''
const SPEAK_AFTER_SILENCE_MS = 1500
const ACTIVITY_FLUSH_MS = 3000
const MIC_TIMEOUT_MS = 10_000

const $ = id => document.getElementById(id)
const ui = {
  status: $('status'),
  orb: $('orb'),
  caption: $('caption'),
  call: $('callButton'),
  mute: $('muteButton'),
  sessions: $('sessions'),
  log: $('log'),
}

let conversation = null
let callState = 'idle'
let mode = 'idle'
let isMuted = false
let roster = []
let focused = null
let pendingActivity = []
let pendingSpeech = []
let silentSince = Date.now()

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

function setCall(state, caption) {
  callState = state
  ui.status.dataset.state = state
  ui.status.textContent = { idle: 'ready', connecting: 'connecting', live: 'on call', error: 'error' }[state]
  ui.call.textContent = state === 'live' || state === 'connecting' ? 'End call' : 'Call'
  ui.call.dataset.live = String(state === 'live' || state === 'connecting')
  ui.mute.disabled = state !== 'live'
  if (state !== 'live') ui.orb.dataset.mode = 'idle'
  if (caption) ui.caption.textContent = caption
  void hub('POST', '/call', { state }).catch(() => {})
}

function addLog(text, isFailed = false) {
  ui.log.querySelector('.empty')?.remove()
  const item = document.createElement('li')
  item.textContent = text
  if (isFailed) item.classList.add('failed')
  ui.log.prepend(item)
  while (ui.log.children.length > 20) ui.log.lastChild.remove()
}

function renderRoster() {
  ui.sessions.replaceChildren()
  if (roster.length === 0) {
    const empty = document.createElement('li')
    empty.className = 'empty'
    empty.textContent = 'No Claude session. Turn luke-voice on in Claude Code.'
    ui.sessions.append(empty)
    return
  }
  for (const session of roster) {
    const item = document.createElement('li')
    item.dataset.focused = String(session.name === focused)
    item.title = session.cwd
    const name = document.createElement('span')
    name.textContent = session.name
    const state = document.createElement('span')
    state.className = 'state'
    state.dataset.attention = String(session.needsYou)
    state.textContent = session.needsYou ? 'needs you' : session.isBusy ? 'working' : 'idle'
    item.append(name, state)
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
  conversation.sendContextualUpdate(`[activity]\n${text}`)
}

// A finished turn or a permission wait is worth saying out loud, once the user is quiet.
function speakWhenQuiet() {
  if (!conversation || pendingSpeech.length === 0) return
  if (mode === 'speaking' || Date.now() - silentSince < SPEAK_AFTER_SILENCE_MS) return
  flushActivity()
  const text = pendingSpeech.splice(0).join('\n')
  conversation.sendUserMessage(`[activity] ${text}\nTell me about this briefly.`)
}

function onActivity(session, events) {
  for (const event of events) {
    const line = `session ${session}: ${event.kind}: ${event.text}`
    if (event.kind === 'done' || event.kind === 'attention') pendingSpeech.push(line)
    else pendingActivity.push(line)
  }
}

const clientTools = {
  luke_send_to_claude: async ({ prompt, when, session }) => {
    const out = await hub('POST', '/command', { type: 'send', prompt, when, session: session || undefined }).catch(error => ({ ok: false, message: error.message }))
    addLog(`${session || focused}: ${prompt}`, !out.ok)
    return out.message || (out.ok ? 'Sent.' : 'It did not go through.')
  },
  luke_stop_claude: async ({ session }) => {
    const out = await hub('POST', '/command', { type: 'stop', session: session || undefined }).catch(error => ({ ok: false, message: error.message }))
    addLog(`${session || focused}: stop`, !out.ok)
    return out.message || (out.ok ? 'Stopped.' : 'It did not stop.')
  },
  luke_session_activity: async ({ session }) => {
    const out = await hub('GET', `/activity?session=${encodeURIComponent(session || '')}`).catch(error => ({ text: error.message }))
    return out.text
  },
}

// The microphone, or a clear error instead of a call stuck at "connecting".
async function microphone() {
  const timeout = new Promise((_, reject) =>
    setTimeout(() => reject(new Error('Microphone not available: allow it for this window and press Call.')), MIC_TIMEOUT_MS),
  )
  const stream = await Promise.race([navigator.mediaDevices.getUserMedia({ audio: true }), timeout])
  for (const track of stream.getTracks()) track.stop()
}

async function startCall() {
  if (conversation || callState === 'connecting') return
  setCall('connecting', 'Connecting…')
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
        setCall('live', 'Listening. Talk it through.')
        const snapshot = await hub('GET', '/activity').catch(() => ({ text: '' }))
        conversation?.sendContextualUpdate(`${sessionsLine()}\n${snapshot.text}`)
      },
      onDisconnect: () => {
        conversation = null
        setCall('idle', 'Call ended.')
      },
      onError: message => setCall('error', `Call error: ${message}`),
      onModeChange: ({ mode: next }) => {
        mode = next
        ui.orb.dataset.mode = next
        if (next !== 'speaking') silentSince = Date.now()
      },
      onMessage: ({ source, message }) => {
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
  setCall('idle', 'Call ended.')
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
  stream.onerror = () => {
    ui.status.textContent = 'hub offline'
  }
}

ui.call.addEventListener('click', () => void (conversation || callState === 'connecting' ? endCall() : startCall()))
ui.mute.addEventListener('click', () => {
  isMuted = !isMuted
  conversation?.setMicMuted(isMuted)
  ui.mute.textContent = isMuted ? 'Unmute' : 'Mute'
})
window.addEventListener('beforeunload', () => void conversation?.endSession())

// The orb follows the agent's voice.
function animate() {
  const level = conversation && mode === 'speaking' ? Math.min(1, conversation.getOutputVolume() * 2.5) : 0
  ui.orb.style.setProperty('--level', level.toFixed(3))
  requestAnimationFrame(animate)
}

const empty = document.createElement('li')
empty.className = 'empty'
empty.textContent = 'Nothing sent yet.'
ui.log.append(empty)

setCall('idle')
renderRoster()
connectStream()
setInterval(flushActivity, ACTIVITY_FLUSH_MS)
setInterval(speakWhenQuiet, 500)
requestAnimationFrame(animate)
if (params.get('call') === '1') void startCall()
