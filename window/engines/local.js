// The local engine: a free voice that runs on this computer. The mic goes through a level-based
// voice detector, Whisper writes down what the user said, the brain decides what to do and say,
// and Kokoro speaks it. Only the brain leaves the machine (through the hub, to Claude).
// It gives the window the same session the ElevenLabs engine does.
import { speechChunks } from '/engines/speech-text.js'
import { FRAME, RATE, createVad } from '/engines/vad.js'

export const name = 'local'

const MAX_CONTEXT = 20
const MAX_CONTEXT_CHARS = 6000
const NO_BRAIN = 'Ainda não consigo pensar sozinho nesta versão. Use a voz da ElevenLabs por enquanto.'
const BRAIN_FAILED = 'Não consegui pensar numa resposta agora. Tente de novo.'

// One worker for the whole page: the models stay loaded between calls.
let worker = null
let workerLoad = null
let nextId = 1
const pending = new Map()
const listeners = new Set()

function voiceWorker() {
  if (worker) return worker
  worker = new Worker('/engines/voice-worker.js', { type: 'module' })
  worker.onmessage = ({ data }) => {
    for (const listen of listeners) listen(data)
    const waiting = pending.get(data.id)
    if (!waiting) return
    pending.delete(data.id)
    if (data.type === 'error') waiting.reject(new Error(data.message))
    else waiting.resolve(data)
  }
  worker.onerror = event => {
    const error = new Error(event.message || 'The voice worker stopped.')
    for (const waiting of pending.values()) waiting.reject(error)
    pending.clear()
    worker = null
    workerLoad = null
  }
  return worker
}

function ask(type, data = {}, transfer = []) {
  const id = nextId++
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject })
    voiceWorker().postMessage({ id, type, ...data }, transfer)
  })
}

// ?voice-device=wasm, ?voice-dtype= and ?voice-threads= override the defaults, to measure a machine.
const query = new URLSearchParams(location.search)
const overrides = Object.fromEntries(
  [['device', query.get('voice-device')], ['dtype', query.get('voice-dtype')], ['threads', Number(query.get('voice-threads')) || null]].filter(([, v]) => v),
)
const loadVoice = () => (workerLoad ??= ask('load', overrides).catch(error => ((workerLoad = null), Promise.reject(error))))

// One line per step in the console, to see where the time goes on a slow machine.
const timing = (step, ms, extra = '') => console.info(`[luke-voice] ${step} ${ms} ms${extra ? ` ${extra}` : ''}`)

listeners.add(data => {
  if (data.type === 'ready') timing('voice ready', data.warmMs ?? 0, `(${data.device}, ${data.threads} threads, warm-up)`)
})

const percent = ({ loaded, total }) => Math.min(99, Math.round((loaded / total) * 100))

export async function startSession({
  hub,
  prepare = async () => {},
  clientTools = {},
  brain = request => hub('POST', '/brain', request),
  onConnect = () => {},
  onDisconnect = () => {},
  onError = () => {},
  onModeChange = () => {},
  onMessage = () => {},
  onStatus = () => {},
}) {
  const showProgress = data => {
    if (data.type === 'progress') onStatus(`Baixando a voz gratuita (só na primeira vez): ${percent(data)}%`)
    if (data.type === 'status') onStatus(data.stage === 'warming' ? 'Aquecendo a voz…' : 'Carregando a voz…')
  }
  listeners.add(showProgress)
  try {
    await prepare()
    await loadVoice()
  } finally {
    listeners.delete(showProgress)
  }

  const stream = await navigator.mediaDevices.getUserMedia({
    audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
  })
  const micContext = new AudioContext({ sampleRate: RATE })
  await micContext.audioWorklet.addModule('/engines/mic-worklet.js')
  const source = micContext.createMediaStreamSource(stream)
  const frames = new AudioWorkletNode(micContext, 'luke-mic-frames')
  source.connect(frames)

  const outContext = new AudioContext()
  const analyser = outContext.createAnalyser()
  analyser.fftSize = 512
  analyser.connect(outContext.destination)
  const levels = new Float32Array(analyser.fftSize)

  const vad = createVad()
  const context = []
  const turns = []
  let isMuted = false
  let isEnded = false
  let mode = 'listening'
  let speech = 0 // bumped to cancel what is being said
  let playing = new Set()
  let playhead = 0
  let busy = Promise.resolve()

  const setMode = next => {
    if (next === mode) return
    mode = next
    onModeChange({ mode })
  }

  function cancelSpeech() {
    speech++
    for (const node of playing) {
      try {
        node.stop()
      } catch {
        // already stopped
      }
    }
    playing = new Set()
    playhead = 0
    setMode('listening')
  }

  // Speaks chunk by chunk: the next chunk is synthesized while the current one plays.
  async function speak(text) {
    const parts = speechChunks(text)
    if (parts.length === 0) return
    const mine = ++speech
    onMessage({ source: 'ai', message: text })
    let next = ask('speak', { text: parts[0] })
    for (let i = 0; i < parts.length; i++) {
      const { audio, sampleRate, ms } = await next
      timing('speak', ms, `for ${(audio.length / sampleRate).toFixed(1)} s of audio`)
      if (mine !== speech || isEnded) return
      if (i + 1 < parts.length) next = ask('speak', { text: parts[i + 1] })
      const buffer = outContext.createBuffer(1, audio.length, sampleRate)
      buffer.copyToChannel(audio, 0)
      const node = outContext.createBufferSource()
      node.buffer = buffer
      node.connect(analyser)
      const at = Math.max(outContext.currentTime + 0.02, playhead)
      node.start(at)
      playhead = at + buffer.duration
      playing.add(node)
      setMode('speaking')
      node.onended = () => {
        playing.delete(node)
        if (playing.size === 0 && mine === speech && i === parts.length - 1) setMode('listening')
      }
    }
  }

  function remember(text) {
    context.push(text)
    while (context.length > MAX_CONTEXT || context.join('\n').length > MAX_CONTEXT_CHARS) context.shift()
  }

  // One turn with the brain: what to do (a tool) and what to say.
  async function think(request) {
    let reply
    const started = performance.now()
    try {
      reply = await brain({ ...request, context: [...context], turns: turns.slice(-12) })
      timing('brain', Math.round(performance.now() - started))
    } catch (error) {
      reply = { say: /not found/i.test(String(error?.message)) ? NO_BRAIN : BRAIN_FAILED }
    }
    if (isEnded) return
    let said = reply?.say ?? ''
    const tool = reply?.tool
    if (tool && typeof clientTools[tool.name] === 'function') {
      const result = await clientTools[tool.name](tool.args ?? {})
      remember(`[tool ${tool.name}] ${result}`)
      if (reply.sayOnFailure && !/^(Started|Sent|Stopped|Queued)/i.test(String(result))) said = reply.sayOnFailure
    }
    if (said) {
      turns.push({ role: 'luke', text: said })
      await speak(said)
    }
  }

  // Turns run one at a time, in order.
  const queue = job => (busy = busy.then(job).catch(error => onError(String(error?.message ?? error))))

  async function onUtterance(audio) {
    const seconds = (audio.length / RATE).toFixed(1)
    const { text, ms } = await ask('transcribe', { audio }, [audio.buffer])
    timing('transcribe', ms, `for ${seconds} s of speech`)
    if (!text || isEnded || /^\W*$/.test(text)) return
    turns.push({ role: 'user', text })
    onMessage({ source: 'user', message: text })
    await think({ kind: 'user', text })
  }

  frames.port.onmessage = ({ data: frame }) => {
    if (isEnded || isMuted || frame.length !== FRAME) return
    const event = vad.push(frame, { isSpeaking: mode === 'speaking' })
    if (!event) return
    if (event.type === 'barge') cancelSpeech()
    if (event.type === 'end') queue(() => onUtterance(event.audio))
  }

  const session = {
    sendContextualUpdate: text => remember(String(text ?? '')),
    // The window's fixed notice: the brain turns the news in the context into a short spoken update.
    sendUserMessage: text => queue(() => think({ kind: 'notice', text: String(text ?? '') })),
    setMicMuted: next => {
      isMuted = Boolean(next)
      if (isMuted) vad.reset()
    },
    getOutputVolume: () => {
      if (playing.size === 0) return 0
      analyser.getFloatTimeDomainData(levels)
      let sum = 0
      for (const v of levels) sum += v * v
      return Math.sqrt(sum / levels.length)
    },
    endSession: async () => {
      if (isEnded) return
      isEnded = true
      cancelSpeech()
      frames.port.onmessage = null
      for (const track of stream.getTracks()) track.stop()
      await Promise.allSettled([micContext.close(), outContext.close()])
      onDisconnect({ reason: 'user' })
    },
    // For tests and the help page: say something without the brain.
    speak,
  }

  onConnect()
  return session
}

export function earlyDropMessage(reason) {
  return `A chamada local caiu logo no início${reason && reason !== 'user' ? `: ${reason}` : ''}. Toque em Chamar para tentar de novo.`
}
