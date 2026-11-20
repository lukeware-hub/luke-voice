// The local engine: a free voice that runs on this computer. The mic goes through a level-based
// voice detector, Whisper writes down what the user said, the brain decides what to do and say,
// and Kokoro speaks it. Only the brain leaves the machine (through the hub, to Claude).
// It gives the window the same session the ElevenLabs engine does.
import { isConfirm, isDeny, isStopOnly } from '/engines/fast-path.js'
import { speechChunks } from '/engines/speech-text.js'
import { FRAME, RATE, createVad, rms } from '/engines/vad.js'

export const name = 'local'

// The brain reads the latest context on every turn: keep it short, it is paid in tokens.
const MAX_CONTEXT = 8
const MAX_CONTEXT_CHARS = 3000
const GREETING = 'Oi! Eu sou a Ceci. O que vamos fazer hoje?'
const BRAIN_FAILED = 'Não consegui pensar numa resposta agora. Tente de novo.'
const STOPPED = 'Parei o Claude.'
const NOT_STOPPED = 'O Claude não está trabalhando agora.'
// Said when a tool worked but the brain gave no words.
const DONE_SAY = {
  luke_run_task: 'Comecei, te aviso quando terminar.',
  luke_send_to_claude: 'Mandei para o Claude.',
  luke_stop_claude: STOPPED,
}
const DENIED = 'Tá bom, deixei pra lá.'
// Said at once when the brain takes longer than ACK_AFTER_MS on a request, so the user knows
// Ceci heard. Synthesized when the call starts, so they play with no wait.
const ACKS = ['Certo.', 'Deixa eu ver.', 'Hum, tá bom.']
const ACK_AFTER_MS = 600
// With the end-of-turn model: a 400 ms pause asks it whether the user is done; if it says no,
// 1.2 s of silence still ends the turn. Without it, 800 ms of silence, as before.
const TURN_CANDIDATE_FRAMES = 12
const TURN_END_FRAMES = 38
const TURN_DONE = 0.5
// A "posso?" waits this long for its "sim".
const PENDING_TTL_MS = 90_000
// Tool answers that mean it worked; anything else goes back to the brain to explain.
const TOOL_OK = /^(Started|Claude started|Added as a note|Queued|Stopped|Sent)/i

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
const isDebug = query.get('voice-debug') === '1'
const overrides = Object.fromEntries(
  [['device', query.get('voice-device')], ['dtype', query.get('voice-dtype')], ['threads', Number(query.get('voice-threads')) || null], ['stt', query.get('voice-stt')], ['sttDtype', query.get('voice-stt-dtype')], ['tts', query.get('voice-tts')], ['sttDevice', query.get('voice-stt-device')]].filter(([, v]) => v),
)
const loadVoice = () => (workerLoad ??= ask('load', overrides).catch(error => ((workerLoad = null), Promise.reject(error))))

// One line per step in the console, to see where the time goes on a slow machine.
const timing = (step, ms, extra = '') => console.info(`[luke-voice] ${step} ${ms} ms${extra ? ` ${extra}` : ''}`)

// What the loaded voice runs on, for the settings page; null until the first call loads it.
let voiceInfo = null
export const getVoiceInfo = () => voiceInfo

listeners.add(data => {
  if (data.type !== 'ready') return
  voiceInfo = { device: data.device, threads: data.threads, tts: data.tts, stt: data.stt, turn: data.turn }
  timing('voice ready', data.warmMs ?? 0, `(${data.tts}, ${data.stt}, ${data.device}, ${data.threads} threads, warm-up)`)
})

const percent = ({ loaded, total }) => Math.min(99, Math.round((loaded / total) * 100))

export async function startSession({
  hub,
  prepare = async () => {},
  clientTools = {},
  brain = query.get('voice-echo') === '1' ? echoBrain : request => hub('POST', '/brain', request),
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

  const vad = createVad(voiceInfo?.turn ? { candidateFrames: TURN_CANDIDATE_FRAMES, endFrames: TURN_END_FRAMES } : {})
  const context = []
  const turns = []
  let isMuted = false
  let isEnded = false
  let mode = 'listening'
  let speech = 0 // bumped to cancel what is being said
  let playing = new Set()
  let playhead = 0
  let busy = Promise.resolve()
  // The action Ceci asked "posso?" about: a plain yes runs it with no brain call.
  let pendingAction = null
  const ackAudio = new Map()
  let nextAck = 0

  // The voice backend: today the in-page worker.
  const synth = text => ask('speak', { text })
  const transcribe = audio => ask('transcribe', { audio }, [audio.buffer])

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

  // Queues one piece of audio after whatever is playing.
  function play(audio, sampleRate, mine, isLast) {
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
      if (playing.size === 0 && mine === speech && isLast) setMode('listening')
    }
  }

  // Speaks chunk by chunk: the next chunk is synthesized while the current one plays.
  async function speak(text) {
    const parts = speechChunks(text)
    if (parts.length === 0) return
    const mine = ++speech
    onMessage({ source: 'ai', message: text })
    let next = synth(parts[0])
    for (let i = 0; i < parts.length; i++) {
      const { audio, sampleRate, ms, isBroken, retried } = await next
      timing('speak', ms, `for ${(audio.length / sampleRate).toFixed(1)} s of audio${retried ? ' (retried after NaN audio)' : ''}`)
      if (mine !== speech || isEnded) return
      if (i + 1 < parts.length) next = synth(parts[i + 1])
      // A chunk the voice could not make is skipped, so the rest of the answer is still said.
      if (isBroken || audio.length === 0) {
        console.warn(`[luke-voice] the voice could not say: ${parts[i]}`)
        if (i === parts.length - 1 && playing.size === 0) setMode('listening')
        continue
      }
      play(audio, sampleRate, mine, i === parts.length - 1)
    }
  }

  // The short acknowledgements, made once so they play with no wait.
  async function warmAcks() {
    for (const text of ACKS) {
      if (isEnded) return
      try {
        const made = await synth(speechChunks(text)[0] ?? text)
        if (!made.isBroken && made.audio.length) ackAudio.set(text, made)
      } catch {
        // No acknowledgement for that line; the turn still works.
      }
    }
  }

  // "Certo." while the brain thinks. Not over Ceci's own voice, and never added to the conversation.
  function sayAck() {
    if (isEnded || mode === 'speaking' || ackAudio.size === 0) return
    const text = ACKS[nextAck++ % ACKS.length]
    const made = ackAudio.get(text)
    if (!made) return
    timing('ack', 0, `"${text}"`)
    play(made.audio, made.sampleRate, ++speech, true)
  }

  function remember(text) {
    context.push(text)
    while (context.length > MAX_CONTEXT || context.join('\n').length > MAX_CONTEXT_CHARS) context.shift()
  }

  // One turn with the brain: what to do (a tool) and what to say.
  async function askBrain(request) {
    const started = performance.now()
    try {
      const reply = await brain({ ...request, context: [...context], turns: turns.slice(-12) })
      timing('brain', Math.round(performance.now() - started))
      return reply ?? { say: '', tool: null, pending: null }
    } catch (error) {
      console.warn(`[luke-voice] brain failed: ${error?.message ?? error}`)
      return { say: BRAIN_FAILED, tool: null, pending: null }
    }
  }

  async function say(text) {
    if (!text || isEnded) return
    turns.push({ role: 'luke', text })
    await speak(text)
  }

  // Runs a tool and says how it went. A tool that failed, or one that only reads (activity), goes
  // back to the brain once, so the user hears what it means.
  async function runTool(tool, said) {
    if (typeof clientTools[tool.name] !== 'function') return say(said)
    const result = String(await clientTools[tool.name](tool.args ?? {}))
    remember(`[tool ${tool.name}] ${result}`)
    // The brain sometimes acts without a word; the user still needs to hear that it worked.
    if (tool.name !== 'luke_session_activity' && TOOL_OK.test(result)) return say(said || DONE_SAY[tool.name] || '')
    const followUp = await askBrain({ kind: 'tool_result', text: `${tool.name}: ${result}` })
    return say(followUp.say)
  }

  // One turn with the brain: what to say, what to run now, and what to run on a "sim".
  async function think(request) {
    // On a request, "Certo." plays if the brain is slow, so the user knows Ceci heard.
    const ack = request.kind === 'user' ? setTimeout(sayAck, ACK_AFTER_MS) : null
    const reply = await askBrain(request)
    clearTimeout(ack)
    if (isEnded) return
    if (request.kind === 'user') pendingAction = reply.pending ? { tool: reply.pending, at: Date.now() } : null
    if (!reply.tool) return say(reply.say)
    return runTool(reply.tool, reply.say)
  }

  async function stopNow() {
    const result = String(await clientTools.luke_stop_claude?.({}))
    return say(TOOL_OK.test(result) ? STOPPED : NOT_STOPPED)
  }

  // Turns run one at a time, in order.
  const queue = job => (busy = busy.then(job).catch(error => onError(String(error?.message ?? error))))

  async function onUtterance(audio) {
    const seconds = (audio.length / RATE).toFixed(1)
    const { text, ms, noSpeech } = await transcribe(audio)
    if (noSpeech) return timing('dropped', ms, `${seconds} s of sound with no speech in it`)
    timing('transcribe', ms, `for ${seconds} s of speech`)
    if (!text || isEnded || /^\W*$/.test(text)) return
    turns.push({ role: 'user', text })
    onMessage({ source: 'user', message: text })
    // Any words answer the last "posso?": a plain yes runs it, a plain no drops it, anything else
    // goes to the brain, which may ask again.
    const action = pendingAction && Date.now() - pendingAction.at < PENDING_TTL_MS ? pendingAction : null
    pendingAction = null
    if (action && isDeny(text)) {
      timing('fast path', 0, 'no to "posso?"')
      return say(DENIED)
    }
    if (isStopOnly(text)) return stopNow()
    if (action && isConfirm(text)) {
      timing('fast path', 0, `yes to "posso?": ${action.tool.name}`)
      return runTool(action.tool, '')
    }
    await think({ kind: 'user', text })
  }

  let frameCount = 0
  frames.port.onmessage = ({ data: frame }) => {
    if (isEnded || isMuted || frame.length !== FRAME) return
    const event = vad.push(frame, { isSpeaking: mode === 'speaking' })
    // ?voice-debug=1: the mic level and the learned room level twice a second, to tune the detector.
    if (isDebug && ++frameCount % 16 === 0) console.info(`[luke-voice] mic ${rms(frame).toFixed(4)} room ${vad.floor.toFixed(4)} ${mode}`)
    if (!event) return
    if (event.type === 'barge') {
      console.info('[luke-voice] barge-in: the user spoke over Ceci')
      cancelSpeech()
    }
    if (event.type === 'end') queue(() => onUtterance(event.audio))
    // A short pause: the turn model says whether the user is done, so Ceci need not wait 800 ms.
    if (event.type === 'candidate') {
      ask('endpoint', { audio: event.audio }, [event.audio.buffer])
        .then(({ done, ms }) => {
          timing('end of turn', ms, `p=${done.toFixed(2)}`)
          if (done < TURN_DONE || isEnded) return
          const end = vad.endNow(event.id)
          if (end?.type === 'end') queue(() => onUtterance(end.audio))
        })
        .catch(() => {})
    }
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
  // Ceci greets like the ElevenLabs agent does (agent/agent.json first_message), so a call
  // sounds the same with either voice and the user knows she is listening.
  void say(GREETING).then(warmAcks)
  return session
}

// ?voice-echo=1: repeats what it heard, to judge the transcription and the voice without the brain.
async function echoBrain(request) {
  return { say: request.kind === 'user' ? `Você disse: ${request.text}` : '', tool: null }
}

export function earlyDropMessage(reason) {
  return `A chamada local caiu logo no início${reason && reason !== 'user' ? `: ${reason}` : ''}. Toque em Chamar para tentar de novo.`
}
