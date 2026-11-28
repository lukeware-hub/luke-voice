// The local engine: a free voice that runs on this computer. The mic goes through a level-based
// voice detector, Whisper writes down what the user said, the brain decides what to do and say,
// and Kokoro speaks it. Only the brain leaves the machine (through the hub, to Claude).
// It gives the window the same session the ElevenLabs engine does.
import { PLAN_ASK, REPEAT, askedAgain, decide, liveAction, needsPlanAsk, planAsked, unsureAnswer, withPlan } from '/engines/confirm.js'
import { ACKS, pickAck } from '/engines/acks.js'
import { pickGreeting } from '/engines/greetings.js'
import { isConfirm, isDeny, stopTarget } from '/engines/fast-path.js'
import { speechChunks } from '/engines/speech-text.js'
import { isReadyToStart, pauseAfter, sentenceLeft, trimEdges } from '/engines/phrase-audio.js'
import { contextEntry, trimContext } from '/engines/context.js'
import { createCutReply, createTurnJoiner, createTurnLog } from '/engines/turn-join.js'
import { risingPercent } from '/engines/progress.js'
import { isEcho, isNotSpeech } from '/engines/transcript.js'
import { FRAME, RATE, createVad, rms } from '/engines/vad.js'
import { normalizeSpeech } from '/engines/gain.js'
import { micConstraints } from '/engines/microphone.js'

export const name = 'local'

const BRAIN_FAILED = 'Não consegui pensar numa resposta agora. Tente de novo.'
const STOPPED = 'Parei o Claude.'
const NOT_STOPPED = 'O Claude não está trabalhando agora.'
// Said when a tool worked but the brain gave no words.
const DONE_SAY = {
  luke_send_to_claude: 'Refinei a ordem e mandei para o Claude Code.',
  luke_stop_claude: STOPPED,
  luke_memory_delete: 'Apaguei da memória.',
}
const DENIED = 'Tá bom, deixei pra lá.'
// Said at once when the brain takes longer than ACK_AFTER_MS on a request, so the user knows
// Ceci heard (acks.js). Synthesized when the call starts, so they play with no wait.
const ACK_AFTER_MS = 600
// With the end-of-turn model: a ~380 ms pause asks it whether the user is done, and it is asked
// again every ~190 ms while the pause goes on; a "done" (0.6) ends the turn there, and ~0.6 s of
// silence ends it anyway. Without the model, ~0.8 s (vad.js). A breath mid-sentence that still
// ends the turn is not lost: speech that resumes before Ceci answers is joined (turn-join.js).
const TURN_CANDIDATE_FRAMES = 12
const TURN_CANDIDATE_EVERY = 6
const TURN_END_FRAMES = 20
const TURN_DONE = 0.6
// While the user may be talking over her, Ceci goes on at this volume instead of stopping: her
// own echo set off most interruptions, and a false one used to cut her off mid-sentence. She
// stops once the turn turns out to be the user's words, and goes back to full volume if not.
const DUCK_GAIN = 0.2
// How loud her voice comes back in the mic, as a share of her output: learned while she speaks
// and nobody talks, from this start. The detector's bar while she speaks is this much of her
// output, times ECHO_MARGIN.
const ECHO_START = 0.15
const ECHO_MAX = 0.5
const ECHO_MARGIN = 2
// Tool answers that mean it worked; anything else goes back to the brain to explain.
const TOOL_OK = /^(Started|Claude started|Added as a note|Queued|Stopped|Sent|Deleted)/i

// The acknowledgements, made once per voice and kept for the page: a second call in the same window
// plays them with no new synthesis. voice (engine and persona) -> text -> audio. The persona is part
// of the key: the native voice clones whoever answers, so Ceci's "Certo." kept from an earlier call
// must never play in Luke's call after the user picked Luke in Configurações.
const ackCache = new Map()

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
  worker.onerror = event => stopWorker(new Error(event.message || 'The voice worker stopped.'))
  return worker
}

// Ends the worker (one that failed may still be running) and fails what still waits on it, so no
// caller waits forever for an answer it will never send.
function stopWorker(error) {
  worker?.terminate()
  worker = null
  workerLoad = null
  for (const waiting of pending.values()) waiting.reject(error)
  pending.clear()
}

function ask(type, data = {}, transfer = []) {
  // The worker crashed and a new one starts empty: load its models again before anything else.
  if (type !== 'load' && !workerLoad && workerKind) return loadVoice(workerKind).then(() => ask(type, data, transfer))
  const id = nextId++
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject })
    voiceWorker().postMessage({ id, type, ...data }, transfer)
  })
}

// ?voice-device=wasm, ?voice-dtype= and ?voice-threads= override the defaults, to measure a machine.
const query = new URLSearchParams(location.search)
const isDebug = query.get('voice-debug') === '1'
// The hub picks, for a yes/no question, the take whose end rises like a Brazilian question
// (hub/question-pick.mjs); ?voice-question=0 turns that off.
const isQuestionPick = query.get('voice-question') !== '0'
const overrides = Object.fromEntries(
  [['device', query.get('voice-device')], ['dtype', query.get('voice-dtype')], ['threads', Number(query.get('voice-threads')) || null], ['sttDtype', query.get('voice-stt-dtype')], ['tts', query.get('voice-tts')], ['sttDevice', query.get('voice-stt-device')]].filter(([, v]) => v),
)
// The worker loads either the whole browser voice, or (with the native engine) only the end-of-turn
// models. A worker loaded one way is replaced when the next call needs the other.
let workerKind = null
// Kokoro's voice for the browser (light) voice: set per call from the hub's persona.
let kokoroVoice = 'pf_dora'
const loadVoice = kind => {
  if (workerLoad && workerKind !== kind) stopWorker(new Error('The voice worker was replaced.'))
  workerKind = kind
  if (!workerLoad) {
    // A failed load is forgotten, unless a newer one already replaced it (a replaced worker fails its own).
    const load = ask('load', kind === 'native' ? { ...overrides, native: true } : { voice: kokoroVoice, ...overrides }).catch(error => {
      if (workerLoad === load) workerLoad = null
      return Promise.reject(error)
    })
    workerLoad = load
  }
  return workerLoad
}

// The window key, for the hub's /tts and /stt; the window hands it to startSession.
let KEY = ''

// 16 kHz mono PCM16 WAV, what the hub's /stt takes.
function wavBytes(audio, rate = RATE) {
  const buffer = new ArrayBuffer(44 + audio.length * 2)
  const view = new DataView(buffer)
  const text = (at, value) => [...value].forEach((c, i) => view.setUint8(at + i, c.charCodeAt(0)))
  text(0, 'RIFF')
  view.setUint32(4, 36 + audio.length * 2, true)
  text(8, 'WAVEfmt ')
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true)
  view.setUint16(22, 1, true)
  view.setUint32(24, rate, true)
  view.setUint32(28, rate * 2, true)
  view.setUint16(32, 2, true)
  view.setUint16(34, 16, true)
  text(36, 'data')
  view.setUint32(40, audio.length * 2, true)
  for (let i = 0; i < audio.length; i++) view.setInt16(44 + i * 2, Math.max(-1, Math.min(1, audio[i])) * 0x7fff, true)
  return new Uint8Array(buffer)
}

// Where the samples start in a WAV stream, and at what rate; null until the header has arrived.
export function wavHeader(bytes) {
  if (bytes.length < 12) return null
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  let rate = 24_000
  for (let at = 12; at + 8 <= bytes.length; ) {
    const id = String.fromCharCode(bytes[at], bytes[at + 1], bytes[at + 2], bytes[at + 3])
    const size = view.getUint32(at + 4, true)
    if (id === 'fmt ' && at + 16 <= bytes.length) rate = view.getUint32(at + 12, true)
    if (id === 'data') return { rate, dataOffset: at + 8 }
    at += 8 + size + (size % 2)
  }
  return null
}

const joinBytes = (a, b) => {
  const out = new Uint8Array(a.length + b.length)
  out.set(a)
  out.set(b, a.length)
  return out
}

const pcm16ToFloat = bytes => {
  const samples = new Int16Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length))
  const out = new Float32Array(samples.length)
  for (let i = 0; i < samples.length; i++) out[i] = samples[i] / 32768
  return out
}

// Reads a streamed WAV from the hub, handing over Float32 pieces as they arrive.
async function readWavStream(response, onPiece, isCancelled) {
  const reader = response.body.getReader()
  let head = new Uint8Array(0)
  let header = null
  let carry = null
  for (;;) {
    const { done, value } = await reader.read().catch(() => ({ done: true }))
    if (isCancelled()) {
      reader.cancel().catch(() => {})
      return null
    }
    if (done) return header?.rate ?? 24_000
    let bytes = value
    if (!header) {
      head = joinBytes(head, bytes)
      header = wavHeader(head)
      if (!header) continue
      bytes = head.subarray(header.dataOffset)
    }
    if (carry) bytes = joinBytes(carry, bytes)
    carry = bytes.length % 2 ? bytes.slice(bytes.length - 1) : null
    if (carry) bytes = bytes.subarray(0, bytes.length - 1)
    if (bytes.length) onPiece(pcm16ToFloat(bytes), header.rate)
  }
}

// One line per step in the console, to see where the time goes on a slow machine.
const timing = (step, ms, extra = '') => console.info(`[luke-voice] ${step} ${ms} ms${extra ? ` ${extra}` : ''}`)

// What the loaded voice runs on, for the settings page; null until the first call loads it.
let voiceInfo = null
export const getVoiceInfo = () => voiceInfo

listeners.add(data => {
  if (data.type !== 'ready') return
  voiceInfo = { device: data.device, threads: data.threads, tts: data.tts, stt: data.stt, turn: data.turn, fallback: data.fallback ?? null }
  timing('voice ready', data.warmMs ?? 0, `(${data.tts}, ${data.stt}, ${data.device}, ${data.threads} threads, warm-up)`)
})

const percent = ({ loaded, total }) => Math.min(99, Math.round((loaded / total) * 100))

// How long a call waits for the native engine the hub is starting, before using the light voice.
const NATIVE_WAIT_MS = 90_000
const MAC_VOICE_HINT = 'Para a voz soar mais natural neste Mac, escolha a Siri Voz 1 em Ajustes do Sistema › Acessibilidade › Conteúdo Falado › Voz do Sistema (ela baixa uma vez, numa rede que não seja a internet do celular). Com a Siri Voz 1 a assistente é o Luke; com a Siri Voz 2, a Nara. Ela vale a partir da próxima chamada.'
// A native /stt or /tts request past these is dropped (that turn, or that chunk), so a hung
// llama-server never holds the turn queue forever.
const STT_TIMEOUT_MS = 20_000
const TTS_TIMEOUT_MS = 30_000
const NATIVE_DOWN = 'A voz natural não respondeu; usando a voz leve nesta chamada.'

export async function startSession({
  hub,
  windowKey = '',
  native: forceNative = query.get('voice-native'),
  prepare = async () => {},
  inputDeviceId = '',
  clientTools = {},
  brain = query.get('voice-echo') === '1' ? echoBrain : request => hub('POST', '/brain', request),
  // The instant layer of the hybrid brain (native engine only): small talk answered on this machine.
  router = query.get('voice-echo') === '1' ? null : request => hub('POST', '/route', request),
  onConnect = () => {},
  onDisconnect = () => {},
  onError = () => {},
  onModeChange = () => {},
  onMessage = () => {},
  onStatus = () => {},
  // The user talked over a notice (the news of a finished task): the window tells it again.
  onNoticeCut = () => {},
}) {
  KEY = windowKey
  const downloaded = risingPercent()
  const showProgress = data => {
    if (data.type === 'progress') onStatus(`Baixando a voz gratuita (só na primeira vez): ${downloaded(data)}%`)
    if (data.type === 'status') onStatus(data.stage === 'warming' ? 'Aquecendo a voz…' : 'Carregando a voz…')
  }
  listeners.add(showProgress)
  // The native engine (gpu profile) speaks and listens when both its servers are up; otherwise this
  // call uses the browser voice, and says so while the native one is still downloading.
  let config = await hub('GET', '/config').catch(() => ({}))
  // The hub is still starting the native engine (it loads in ~20 s after the hub starts): wait for
  // it, rather than spend the whole call on the light voice. A download takes minutes: no wait then.
  const waitUntil = Date.now() + NATIVE_WAIT_MS
  while (forceNative !== '0' && config.engine === 'starting' && !config.download?.total && Date.now() < waitUntil) {
    onStatus(`Aquecendo a voz natural ${['Luke', 'João'].includes(config.persona?.name) ? 'do' : 'da'} ${config.persona?.name ?? 'Ceci'}…`)
    await new Promise(resolve => setTimeout(resolve, 1000))
    config = await hub('GET', '/config').catch(() => ({}))
  }
  const isNative = forceNative === '0' ? false : Boolean(config.native?.tts && config.native?.asr)
  // No natural voice on this Mac, but a Premium voice of macOS: the hub speaks with it, the page still listens.
  const isMacVoice = !isNative && forceNative !== '0' && Boolean(config.macVoice)
  // Who answers is the hub's persona: Ceci, Luke or João (the user's choice in Configurações), or Nara on a Mac's own voice.
  const herName = typeof config.persona?.name === 'string' && config.persona.name.trim() ? config.persona.name.trim() : 'Ceci'
  const isMale = config.persona?.gender === 'male'
  // The light voice (Kokoro) is a male one for Luke and João; the native one clones the hub's reference clip.
  kokoroVoice = ['pf_dora', 'pm_alex', 'pm_santa'].includes(config.persona?.light) ? config.persona.light : isMale ? 'pm_alex' : 'pf_dora'
  if (!isNative && config.download?.total) onStatus(`Preparando a voz natural: ${percent(config.download)}%. Por enquanto, a voz leve.`)
  // The natural voice was expected (this machine has the gpu profile, or the hub was starting it)
  // but failed or did not come up in time: the user is told, never left guessing why she sounds different.
  else if (!isNative && forceNative !== '0' && (config.profile === 'gpu' || ['starting', 'failed'].includes(config.engine))) onStatus(NATIVE_DOWN, { isWarning: true })
  // prepare may name the device to open (the saved one, or '' when it is unplugged and the default stands in).
  let deviceId = inputDeviceId
  try {
    const ready = await prepare()
    if (typeof ready?.inputDeviceId === 'string') deviceId = ready.inputDeviceId
    await loadVoice(isNative ? 'native' : 'browser')
  } finally {
    listeners.delete(showProgress)
  }
  if (voiceInfo) voiceInfo = { ...voiceInfo, tts: isNative ? 'native' : isMacVoice ? `mac:${config.macVoice}` : voiceInfo.tts, stt: isNative ? 'native' : voiceInfo.stt, device: isNative ? 'native' : voiceInfo.device }
  // The browser voice switched from Kokoro to the lighter Piper (Kokoro too slow here, or it did not load).
  if (!isNative && voiceInfo?.fallback) onStatus(voiceInfo.fallback, { isWarning: true })
  else if (!isNative && !isMacVoice && config.macVoiceHint) onStatus(MAC_VOICE_HINT, { isWarning: true })

  const stream = await navigator.mediaDevices.getUserMedia({
    // No automatic gain: it raised whatever was left of Ceci's echo after the echo canceller,
    // and the raised echo interrupted her.
    audio: micConstraints(deviceId, { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: false }),
  })
  let micContext = null
  let outContext = null
  let frames
  let analyser
  let outGain
  let levels
  try {
    micContext = new AudioContext({ sampleRate: RATE })
    await micContext.audioWorklet.addModule('/engines/mic-worklet.js')
    const source = micContext.createMediaStreamSource(stream)
    frames = new AudioWorkletNode(micContext, 'luke-mic-frames')
    source.connect(frames)

    outContext = new AudioContext()
    analyser = outContext.createAnalyser()
    analyser.fftSize = 512
    // Her volume (lowered while the user may be talking over her) is set after the analyser, so
    // the window's level meter and the echo estimate see what she says, not how loud.
    outGain = outContext.createGain()
    analyser.connect(outGain)
    outGain.connect(outContext.destination)
    levels = new Float32Array(analyser.fftSize)
  } catch (error) {
    // The call does not start: let go of the microphone (its indicator would stay on) and the audio.
    for (const track of stream.getTracks()) track.stop()
    await Promise.allSettled([micContext?.close(), outContext?.close()])
    throw error
  }
  // Chrome may start an audio context suspended (no click on the page yet): the next click resumes it.
  const resumeAudio = () => {
    for (const audio of [micContext, outContext]) if (audio.state === 'suspended' && !(isPaused && audio === outContext)) audio.resume().catch(() => {})
  }
  document.addEventListener('click', resumeAudio)

  const vad = createVad(voiceInfo?.turn ? { candidateFrames: TURN_CANDIDATE_FRAMES, candidateEvery: TURN_CANDIDATE_EVERY, endFrames: TURN_END_FRAMES } : {})
  const context = []
  const turns = createTurnLog()
  let isMuted = false
  // Silenciar is on: she neither speaks nor hears until it is turned off.
  let isPaused = false
  let isEnded = false
  let mode = 'listening'
  let speech = 0 // bumped to cancel what is being said
  let saying = 0 // the speech whose audio is being made now (0: none)
  let sayingText = '' // its words
  // A reply cut off by sound that may be no speech: said again if it was (turn-join.js).
  const cutReply = createCutReply()
  let playing = new Set()
  let playhead = 0
  let busy = Promise.resolve()
  // The action Ceci asked "ok?" about: a plain yes runs it with no brain call.
  let pendingAction = null
  // Speech that resumes right after a turn closed is joined with it (turn-join.js). `turnNow` is
  // the user turn the running job answers, or null for jobs that are not a user turn.
  const joiner = createTurnJoiner()
  let turnNow = null
  const isStale = () => turnNow !== null && !joiner.isCurrent(turnNow)
  const ackVoice = `${isNative ? 'native' : isMacVoice ? `mac:${config.macVoice}` : `browser:${voiceInfo?.tts ?? ''}:${kokoroVoice}`}|${config.persona?.key ?? herName}`
  if (!ackCache.has(ackVoice)) ackCache.set(ackVoice, new Map())
  const ackAudio = ackCache.get(ackVoice)
  let lastAck = ''
  // Jobs in the turn queue (user turns and notices), and the acknowledgement being made now.
  let jobs = 0
  // User turns queued or running: until each is written down and answered, a notice waits (app.js).
  let userJobs = 0
  let ackWarm = null

  // Aborts the native voice's stream when Ceci is cut off.
  let nativeStop = null
  // The speech playing lowered while a barge-in is checked (0: none), and whether the turn being
  // heard started over her voice.
  let ducked = 0
  let isBargeTurn = false
  // The speech telling news on Ceci's own (a notice), so a barge-in over it can have it told again.
  let noticeSpeech = 0
  let isNoticeLine = false
  // The window's news batch that notice tells (handed back to onNoticeCut), and the one the line
  // about to be said tells.
  let noticeBatch = null
  let noticeLineBatch = null
  // What Ceci said lately, to tell her echo from the user's words.
  let recentSaid = []
  // Her output level, held a moment (the echo arrives a little after), and how much of it the mic hears.
  let outPeak = 0
  let echoShare = ECHO_START

  // The native voice for one piece of text, whole (the acknowledgements).
  async function nativeSynth(text, signal = null) {
    const started = performance.now()
    const timeout = AbortSignal.timeout(TTS_TIMEOUT_MS)
    const response = await fetch('/tts', { method: 'POST', headers: { 'content-type': 'application/json', 'x-luke-key': KEY }, body: JSON.stringify({ text }), signal: signal ? AbortSignal.any([signal, timeout]) : timeout }).catch(() => null)
    if (!response?.ok) return { audio: new Float32Array(0), sampleRate: 24_000, isBroken: true, ms: 0 }
    const pieces = []
    const sampleRate = await readWavStream(response, piece => pieces.push(piece), () => Boolean(signal?.aborted))
    if (sampleRate === null) return { audio: new Float32Array(0), sampleRate: 24_000, isBroken: true, ms: 0 }
    const audio = new Float32Array(pieces.reduce((n, p) => n + p.length, 0))
    let at = 0
    for (const piece of pieces) {
      audio.set(piece, at)
      at += piece.length
    }
    return { audio, sampleRate, isBroken: audio.length === 0, ms: Math.round(performance.now() - started) }
  }

  // Speech to text on the native engine, after Silero (in the worker) confirms there is speech.
  // `isAnswer`: a "ok?" waits, and a soft short "sim" passes a lower bar (speech-check.js).
  async function nativeTranscribe(audio, isAnswer) {
    const check = await ask('check', { audio, isAnswer })
    if (!check.isSpeech) return { text: '', noSpeech: true, ms: check.ms }
    let out
    try {
      const response = await fetch('/stt', { method: 'POST', headers: { 'content-type': 'audio/wav', 'x-luke-key': KEY }, body: wavBytes(audio), signal: AbortSignal.timeout(STT_TIMEOUT_MS) })
      if (!response.ok) throw new Error(`The native speech engine answered ${response.status}.`)
      out = await response.json()
    } catch (error) {
      // A hung engine: this turn is dropped, and the user hears nothing back, so say why.
      if (error?.name === 'TimeoutError') throw new Error(`${isMale ? 'O' : 'A'} ${herName} não conseguiu ouvir a tempo. Fale de novo.`)
      throw error
    }
    return { text: String(out.text ?? ''), ms: (out.ms ?? 0) + check.ms }
  }

  // The voice backend: the native engine through the hub, or the in-page worker.
  // The Mac voice falls back to the browser voice for a line `say` could not make.
  const macSynth = text => nativeSynth(text).then(made => (made.isBroken ? ask('speak', { text }) : made))
  const synth = text => (isNative ? nativeSynth(text) : isMacVoice ? macSynth(text) : ask('speak', { text }))
  // A soft voice is raised to a steady level first (gain.js), for Silero and the ears alike: on
  // recorded turns at a very low level it halved the word errors, and left normal turns as they were.
  // While a "ok?" waits for its answer, the speech check lets a soft short "sim" through.
  const transcribe = audio => {
    const { audio: level, gain } = normalizeSpeech(audio)
    if (gain > 1) console.info(`[luke-voice] quiet speech raised ${gain.toFixed(1)}x for the ears`)
    const isAnswer = Boolean(liveAction(pendingAction, Date.now()))
    return isNative ? nativeTranscribe(level, isAnswer) : ask('transcribe', { audio: level, isAnswer }, [level.buffer])
  }

  const setMode = next => {
    if (next === mode) return
    mode = next
    onModeChange({ mode })
  }

  function setVolume(gain) {
    outGain.gain.setTargetAtTime(gain, outContext.currentTime, 0.03)
  }

  // The user may be talking over Ceci: lower her voice until their turn is heard.
  function duck() {
    if (playing.size === 0 && saying === 0) return
    ducked = speech
    setVolume(DUCK_GAIN)
  }

  function unduck() {
    if (!ducked) return
    ducked = 0
    setVolume(1)
  }

  function cancelSpeech() {
    speech++
    ducked = 0
    setVolume(1)
    nativeStop?.abort()
    nativeStop = null
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
    // A new line: the one lowered for a barge-in is over, and this one plays at full volume.
    if (ducked && mine !== ducked) unduck()
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
      // Back to listening when her last audio ends, or when nothing plays and no line is being made
      // (a line that was replaced, an acknowledgement whose reply had nothing to say).
      if (playing.size === 0 && ((mine === speech && (isLast || node.isLast)) || saying === 0)) setMode('listening')
    }
    return node
  }

  // The native voice says a reply chunk by chunk: whole sentences packed together (speech-text.js). The
  // engine sends a chunk's audio in one burst at its end (measured: streaming brought it no sooner),
  // so each chunk is read whole. Cut at every comma instead, each piece came back with
  // the falling end of a sentence and a fixed pause after it, and the owner heard Ceci as robotic;
  // said whole, the melody carries through the commas as a person's does.
  async function speakNative(text) {
    const parts = speechChunks(text, { isNative: true })
    if (parts.length === 0) return
    const mine = ++speech
    saying = mine
    try {
      await speakNativeParts(text, parts, mine)
    } finally {
      if (saying === mine) saying = 0
    }
  }

  async function speakNativeParts(text, parts, mine) {
    onMessage({ source: 'ai', message: text })
    const stop = new AbortController()
    nativeStop = stop
    let lastNode = null
    // Phrases made but not yet playing, and how fast the voice has made them so far.
    const held = []
    let isStarted = false
    let madeS = 0
    let madeChars = 0
    const replyStarted = performance.now()
    // What is ready to play: the held phrases with their pauses, and what still plays.
    const readyS = () => held.reduce((s, h) => s + h.audio.length / h.rate + h.pause, 0) + (playing.size ? Math.max(0, playhead - outContext.currentTime) : 0)
    const startHeld = () => {
      if (!isStarted && held.length) timing('speak', Math.round(performance.now() - replyStarted), 'to first audio (native)')
      isStarted = true
      for (const h of held.splice(0)) {
        if (h.audio.length) lastNode = play(h.audio, h.rate, mine, false)
        if (playing.size) playhead += h.pause
      }
    }
    for (let i = 0; i < parts.length; i++) {
      if (mine !== speech || isEnded) return
      const started = performance.now()
      // How long what is queued still plays: the hub may use that time for more takes of a
      // question, so picking one never makes Ceci wait.
      const budget = playing.size ? Math.max(0, Math.round((playhead - outContext.currentTime) * 1000)) : 0
      const request = () =>
        fetch('/tts', {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-luke-key': KEY },
          body: JSON.stringify({ text: parts[i], budget, ...(isQuestionPick ? {} : { pick: false }) }),
          // Cut off by the user, or the engine hung: this chunk is dropped either way.
          signal: AbortSignal.any([stop.signal, AbortSignal.timeout(TTS_TIMEOUT_MS)]),
        }).catch(() => null)
      let response = await request()
      if (mine !== speech || isEnded) return
      // One failed chunk (the engine restarting, a timeout) is asked once more before it is skipped.
      if (!response?.ok) {
        response = await request()
        if (mine !== speech || isEnded) return
      }
      if (!response?.ok) {
        console.warn(`[luke-voice] the native voice could not say: ${parts[i]}`)
        continue
      }
      const pieces = []
      const sampleRate = await readWavStream(response, piece => pieces.push(piece), () => mine !== speech || isEnded)
      // Cut off meanwhile: what is held back is stale and must not play (nor set 'speaking' again).
      if (mine !== speech || isEnded) return
      if (sampleRate === null) continue
      const whole = new Float32Array(pieces.reduce((n, p) => n + p.length, 0))
      let at = 0
      for (const piece of pieces) {
        whole.set(piece, at)
        at += piece.length
      }
      madeS += (performance.now() - started) / 1000
      madeChars += parts[i].length
      // The phrase's own silence is cut, and the page puts a steady pause after it (phrase-audio.js).
      held.push({ audio: trimEdges(whole, sampleRate, { start: true, end: true }), rate: sampleRate, pause: i < parts.length - 1 ? pauseAfter(parts[i]) : 0 })
      // A sentence waits until the audio ready covers what is left of it to make, so no pause
      // inside it turns into a gap; the next sentence is made while this one plays.
      if (isReadyToStart({ readyS: readyS(), madeS, madeChars, leftChars: sentenceLeft(parts, i) })) startHeld()
    }
    if (mine !== speech || isEnded) return
    startHeld()
    // Back to listening when the last piece ends (or now, if nothing played).
    if (lastNode && playing.has(lastNode)) lastNode.isLast = true
    else if (playing.size === 0) setMode('listening')
  }

  // Speaks chunk by chunk: the next chunk is synthesized while the current one plays.
  async function speak(text) {
    // The speech this line becomes (speak and speakNative bump `speech` once), when it tells news.
    if (isNoticeLine) {
      noticeSpeech = speech + 1
      noticeBatch = noticeLineBatch
    }
    isNoticeLine = false
    sayingText = text
    recentSaid = [...recentSaid, text].slice(-3)
    if (isNative) return speakNative(text)
    const parts = speechChunks(text)
    if (parts.length === 0) return
    const mine = ++speech
    saying = mine
    try {
      await speakParts(text, parts, mine)
    } finally {
      if (saying === mine) saying = 0
    }
  }

  async function speakParts(text, parts, mine) {
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

  // Nothing is being heard, answered or made: the voice is free for background work.
  const isIdle = () => !isEnded && jobs === 0 && saying === 0 && !vad.inSpeech

  // The short acknowledgements, made once per voice (kept for the page) so they play with no wait.
  // Only while the call is idle: on the native engine they would take the voice's single slot from
  // the first reply, and in the browser they would share the worker with it. A user turn that
  // starts meanwhile cancels the one being made; what is missing is made at the next idle moment.
  let isWarming = false
  async function warmAcks() {
    if (isWarming) return
    isWarming = true
    try {
      for (const text of [...ACKS, ...Object.values(DONE_SAY)]) {
        if (ackAudio.has(text)) continue
        if (!isIdle()) return
        const stop = new AbortController()
        ackWarm = stop
        try {
          const line = speechChunks(text, { isNative })[0] ?? text
          const made = await (isNative ? nativeSynth(line, stop.signal) : synth(line))
          if (!made.isBroken && made.audio.length) ackAudio.set(text, made)
        } catch {
          // No acknowledgement for that line; the turn still works.
        } finally {
          if (ackWarm === stop) ackWarm = null
        }
        if (stop.signal.aborted) return
      }
    } finally {
      isWarming = false
    }
  }
  const cancelAckWarm = () => ackWarm?.abort()

  // A line made ahead of time (an acknowledgement, or "Comecei..." for a yes), said with no wait.
  // False when it is not made yet, or Ceci is talking: the caller says it the usual way.
  // The order to Claude is refined first and said only after it was sent ("Refinei a ordem e mandei..."): no early
  // line for it. Other tools say theirs at once.
  const announce = name => (name === 'luke_send_to_claude' ? false : sayMade(DONE_SAY[name]))

  function sayMade(text) {
    const made = ackAudio.get(text)
    if (!made || isEnded || isStale() || mode === 'speaking' || saying !== 0) return false
    commitTurn()
    turns.said(text)
    onMessage({ source: 'ai', message: text })
    recentSaid = [...recentSaid, text].slice(-3)
    play(made.audio, made.sampleRate, ++speech, true)
    return true
  }

  // "Entendi." while the brain thinks, picked by how long the user's turn was. Not over Ceci's own
  // voice or the user's, and never added to the conversation.
  function sayAck(heard) {
    // `saying`: a line (the greeting) is still being made; an ack now would cut it off.
    if (isEnded || isStale() || mode === 'speaking' || saying !== 0 || vad.inSpeech || ackAudio.size === 0) return
    const text = (lastAck = pickAck(heard, lastAck))
    const made = ackAudio.get(text)
    if (!made) return
    timing('ack', 0, `"${text}"`)
    // On screen too, or the caption would show Ceci's previous line while she says "Certo.".
    onMessage({ source: 'ai', message: text })
    recentSaid = [...recentSaid, text].slice(-3)
    play(made.audio, made.sampleRate, ++speech, true)
  }

  // News the window put in the context for a notice still queued: kept until a notice reads it, so
  // activity flushed meanwhile cannot push it out first.
  const unreadNews = new Set()
  function remember(text) {
    const entry = contextEntry(text)
    if (entry.startsWith('[news]')) unreadNews.add(entry)
    trimContext(context, entry, kept => unreadNews.has(kept))
    for (const news of unreadNews) if (!context.includes(news)) unreadNews.delete(news)
  }

  // One turn with the brain: what to do (a tool) and what to say.
  async function askBrain(request) {
    const started = performance.now()
    // A notice reads the news in the context now: from here on it ages out like any other entry.
    if (request.kind === 'notice') unreadNews.clear()
    try {
      const reply = await brain({ ...request, context: [...context], turns: turns.history() })
      timing('brain', Math.round(performance.now() - started))
      return reply ?? { say: '', tool: null, pending: null }
    } catch (error) {
      console.warn(`[luke-voice] brain failed: ${error?.message ?? error}`)
      return { say: BRAIN_FAILED, tool: null, pending: null }
    }
  }

  // The user turn being answered stands from here on: it can no longer be joined, its words enter
  // the history and the "ok?" it answered is let go (turn-join.js).
  function commitTurn() {
    if (turnNow !== null) joiner.commit(turnNow)
    turns.commit()
  }

  async function say(text) {
    if (!text || isEnded || isStale()) return
    commitTurn()
    turns.said(text)
    await speak(text)
  }

  // Runs a tool and says how it went. A tool that failed, or one that only reads (activity), goes
  // back to the brain once, so the user hears what it means.
  // `isAnnounced`: Ceci already said it started (a yes on the fast path), so a success says nothing more.
  async function runTool(tool, said, isAnnounced = false) {
    if (isStale()) return
    if (typeof clientTools[tool.name] !== 'function') return say(said)
    commitTurn()
    const result = String(await clientTools[tool.name](tool.args ?? {}))
    remember(`[tool ${tool.name}] ${result}`)
    // The brain sometimes acts without a word; the user still needs to hear that it worked.
    if (tool.name !== 'luke_session_activity' && TOOL_OK.test(result)) return isAnnounced ? undefined : say(said || DONE_SAY[tool.name] || '')
    const followUp = await askBrain({ kind: 'tool_result', text: `${tool.name}: ${result}` })
    return say(followUp.say)
  }

  // One turn with the brain: what to say, what to run now, and what to run on a "sim".
  // `asked` is the brain's answer when it was asked already (beside the router).
  // `answering` is the live "ok?" this user turn answers, if any (confirm.js).
  // `batch`: for a notice, the window's news batch it tells (see onNoticeCut).
  async function think(request, asked = null, answering = null, batch = null) {
    // On a request, "Entendi." plays if the brain is slow, so the user knows Ceci heard.
    const ack = request.kind === 'user' ? setTimeout(sayAck, ACK_AFTER_MS, request.text) : null
    const reply = await (asked ?? askBrain(request))
    clearTimeout(ack)
    if (isEnded || isStale()) return
    // An acting tool never runs from here: it waits for the user's "sim" (confirm.js).
    const next = decide({ kind: request.kind, reply, now: Date.now(), answering })
    if (request.kind === 'user') commitTurn()
    pendingAction = next.pending
    if (next.action !== 'run') {
      // speak() reads this as it starts, in the same tick; a line with no words leaves it unread.
      isNoticeLine = request.kind === 'notice'
      noticeLineBatch = batch
      const said = say(next.say)
      isNoticeLine = false
      return said
    }
    return runTool(next.tool, next.say)
  }

  // The answer to "ok?" could not be heard for sure (confirm.js, unsureAnswer): Ceci says "Pode
  // repetir para mim, por favor?" and the "ok?" stays open, so the repeated "sim" still runs it.
  // Null when the answer was clear enough, there is no "ok?", or she already asked enough.
  function askAgain(heard) {
    const action = liveAction(pendingAction, Date.now())
    const why = unsureAnswer(action, heard)
    if (!why || isEnded || isStale()) return null
    timing('ask again', 0, why)
    // What was heard does not enter the history, and does not let the "ok?" go.
    turns.drop()
    pendingAction = askedAgain(action, Date.now())
    return say(REPEAT)
  }

  async function stopNow() {
    const result = String(await clientTools.luke_stop_claude?.({}))
    return say(TOOL_OK.test(result) ? STOPPED : NOT_STOPPED)
  }

  // Turns run one at a time, in order. `turn` marks a user turn, so its steps can be dropped when
  // the user goes on talking (see turn-join.js); other jobs (notices) are never dropped.
  // A job waiting here also stops an acknowledgement being made, and the queue running dry lets
  // the missing ones be made.
  const queue = (job, turn = null) => {
    jobs++
    cancelAckWarm()
    return (busy = busy
      .then(() => {
        turnNow = turn
        return job()
      })
      .catch(error => onError(String(error?.message ?? error)))
      .finally(() => {
        if (--jobs === 0) void warmAcks()
      }))
  }

  // A turn ended (or a carried part came back): transcribe and answer it. `heard` is its
  // transcript when it was already written down (a barge-in, checked at once).
  function onTurnEnd(ended, heard = null) {
    if (!ended) return
    if (ended.isJoined) console.info('[luke-voice] resumed: joined with the previous part')
    userJobs++
    queue(() => onUtterance(ended.audio, ended.isJoined ? null : heard).finally(() => userJobs--), ended.turn)
  }

  // A turn that started over Ceci's voice ended. It is written down at once, outside the queue
  // (the reply she is saying holds the queue until its last chunk is made): her own echo, or no
  // speech, lets her go on at full volume; the user's words stop her and are answered.
  function onBargeEnd(audio) {
    userJobs++
    transcribe(audio.slice())
      .then(heard => {
        if (isEnded) return
        if (heard.noSpeech || isNotSpeech(heard.text) || isEcho(heard.text, recentSaid.join(' '))) {
          timing('dropped', heard.ms ?? 0, `a barge-in that was Ceci's own echo or no speech: "${heard.text ?? ''}"`)
          unduck()
          // A part carried for joining comes back as its own turn.
          return onTurnEnd(joiner.dropped())
        }
        console.info('[luke-voice] barge-in: the user spoke over Ceci')
        if (ducked) {
          const wasNotice = ducked === noticeSpeech
          cancelSpeech()
          if (wasNotice) onNoticeCut(noticeBatch)
        }
        onTurnEnd(joiner.ended(audio), heard)
      })
      .catch(error => {
        unduck()
        onError(String(error?.message ?? error))
      })
      .finally(() => userJobs--)
  }

  async function onUtterance(audio, heard = null) {
    const seconds = (audio.length / RATE).toFixed(1)
    // A reply this sound cut off comes back only if the sound was no speech.
    const cut = cutReply.take()
    const { text, ms, noSpeech } = heard ?? (await transcribe(audio))
    if (noSpeech) {
      timing('dropped', ms, `${seconds} s of sound with no speech in it`)
      // A sound with no speech is never joined with what the user says next: a soft "sim" dropped
      // here, then said again, must be heard alone, not as noise in front of the second one.
      if (turnNow !== null) joiner.noSpeech(turnNow)
      if (cut && !isEnded) await speak(cut)
      // A part carried for joining comes back when what followed was no speech.
      const back = joiner.dropped()
      if (cut || back) return onTurnEnd(back)
      // A sound right after "ok?" that the speech check could not hear as words: the answer
      // may have been lost in it, so Ceci asks for it again instead of staying silent.
      return askAgain({ noSpeech: true })
    }
    timing('transcribe', ms, `for ${seconds} s of speech`)
    if (isEnded || isStale()) return
    if (!text || isNotSpeech(text)) {
      // No words, or words the ears made up from noise: as with a sound with no speech, the reply
      // it cut off is said again, before any "Pode repetir?" (that reply may be the "ok?" itself).
      if (cut) return speak(cut)
      return askAgain({ text })
    }
    // The window's voice gate and quiet mode hear the user now, before the brain is asked: a notice
    // that arrives while the brain thinks must not pass for the user's word.
    onMessage({ source: 'user', message: text })
    // Any words answer the last "ok?": a plain yes runs it, a plain no drops it, anything else
    // goes to the brain, which may ask again. It is let go only once this turn stands: a turn
    // joined with what the user says next ("é..." then "sim, pode") still answers it.
    const action = liveAction(pendingAction, Date.now())
    turns.hold(text, () => {
      pendingAction = null
    })
    // An answer that cannot be told for sure, like a yes and a no at once ("sim, não", "não, ok":
    // two voices, or a word lost in the noise), neither runs nor drops the action: Ceci asks again.
    const asked = action ? askAgain({ text }) : null
    if (asked) return asked
    if (action?.planAsked && isDeny(text)) {
      // "Não" to "planejo antes?": the order goes as it is, with no plan.
      timing('fast path', 0, 'no to "plan first?"')
      return runTool(withPlan(action, false), '', announce(action.tool.name))
    }
    if (action && isDeny(text)) {
      timing('fast path', 0, 'no to "ok?"')
      return say(DENIED)
    }
    // A bare "para" or "cancela" is for Ceci (she already stopped, or was quiet). Claude's work is
    // stopped only when the user names it ("para o Claude", "cancela a tarefa", "para tudo").
    const stop = stopTarget(text)
    if (stop === 'ceci') {
      // The turn stands: it is not joined with what the user says next.
      commitTurn()
      return timing('fast path', 0, 'stop: Ceci only')
    }
    if (stop === 'claude') return stopNow()
    if (action && needsPlanAsk(action) && isConfirm(text, recentSaid.join(' '))) {
      // The order is confirmed; before it goes, Ceci asks whether to plan first. The action waits again.
      timing('fast path', 0, 'yes to "ok?": asking plan first')
      commitTurn()
      pendingAction = planAsked(action, Date.now())
      return say(PLAN_ASK)
    }
    if (action && isConfirm(text, recentSaid.join(' '))) {
      timing('fast path', 0, `yes to "ok?": ${action.tool.name}`)
      if (action.planAsked) return runTool(withPlan(action, true), '', announce(action.tool.name))
      // "Comecei..." plays at once, made ahead of time, while the tool starts; a failure is still
      // explained after it.
      return runTool(action.tool, '', announce(action.tool.name))
    }
    // An answer to "ok?" the fast path did not take: written to the log, so a missed short yes
    // can be found and added.
    if (action) timing('no fast path', 0, `answer to "ok?": "${text.slice(0, 80)}"`)
    if (isNative && router) {
      // The brain is asked at once, beside the router: when the router passes, its answer is
      // already on the way instead of starting only now. A reply the router gave makes the
      // brain's answer unused (it only says and proposes; nothing runs without this turn).
      const request = { kind: 'user', text }
      const asked = askBrain(request)
      const lastSaid = turns.lastSaid
      const routed = await router({ text, lastSaid }).catch(() => null)
      if (isStale()) return
      if (routed?.say) {
        timing('router', routed.ms ?? 0, routed.intent)
        return say(routed.say)
      }
      return think(request, asked, action)
    }
    await think({ kind: 'user', text }, null, action)
  }

  // The level of what Ceci is playing now (before her volume).
  function outputLevel() {
    if (playing.size === 0) return 0
    analyser.getFloatTimeDomainData(levels)
    let sum = 0
    for (const v of levels) sum += v * v
    return Math.sqrt(sum / levels.length)
  }

  function endTurn(audio) {
    const wasBarge = isBargeTurn
    isBargeTurn = false
    if (wasBarge) onBargeEnd(audio)
    else onTurnEnd(joiner.ended(audio))
  }

  let frameCount = 0
  let isAskingTurn = false
  frames.port.onmessage = ({ data: frame }) => {
    if (isEnded || isMuted || isPaused || frame.length !== FRAME) return
    // Her audio is playing now. Not `mode`: that stays 'speaking' while a reply is still being made
    // (held for its comma pauses) or after an acknowledgement, with nothing coming out of the
    // speakers, and the detector's higher bar for her voice then kept a normal voice from being heard.
    const isSpeaking = playing.size > 0
    const level = rms(frame)
    // Her voice as it leaves the speakers (after the volume), held ~200 ms for the echo's delay.
    outPeak = Math.max(isSpeaking ? outputLevel() * outGain.gain.value : 0, outPeak * 0.85)
    // While she speaks and nobody talks, the mic hears only her echo (and the room): learn how much
    // of her it hears, slowly. A frame much louder than her expected echo is the user, not her: it
    // is not learned, or a user talking softly over her would raise the bar until nobody got through.
    // And never past ECHO_MAX: an echo canceller leaves far less of her than that.
    if (isSpeaking && !vad.inSpeech && outPeak > 0.02 && level <= echoShare * outPeak * 3) {
      const share = Math.min(level / outPeak, echoShare * 1.5 + 0.01)
      echoShare = Math.min(ECHO_MAX, Math.max(0.02, echoShare + (share - echoShare) * 0.02))
    }
    // While a "ok?" waits, a soft short answer starts a turn more easily (vad.js).
    const isAnswer = !isSpeaking && Boolean(liveAction(pendingAction, Date.now()))
    const event = vad.push(frame, { isSpeaking, echo: echoShare * outPeak * ECHO_MARGIN, isAnswer })
    // ?voice-debug=1: the mic level and the learned room level twice a second, to tune the detector.
    if (isDebug && ++frameCount % 16 === 0) console.info(`[luke-voice] mic ${level.toFixed(4)} room ${vad.floor.toFixed(4)} echo ${(echoShare * outPeak).toFixed(4)} ${mode}`)
    if (!event) return
    // The user is talking: an acknowledgement being made would compete with their turn.
    if (event.type === 'start' || event.type === 'barge') cancelAckWarm()
    // Maybe the user, maybe her echo: she goes on, lower, until the turn is heard (onBargeEnd).
    if (event.type === 'barge') {
      console.info('[luke-voice] barge-in? lowering Ceci until the turn is heard')
      isBargeTurn = true
      duck()
    }
    // A reply whose first audio is still being made: the user talking first wins, as if they had
    // talked over her, instead of the reply then playing over them.
    if (event.type === 'start' && saying !== 0 && saying === speech) {
      console.info('[luke-voice] the user spoke before Ceci\'s reply played')
      const wasNotice = saying === noticeSpeech
      cancelSpeech()
      // News goes back to the window, which tells it again once the user is done (a cough or words
      // alike), as on a barge-in. Not also as a cut reply, or a cough would have it told twice.
      if (wasNotice) onNoticeCut(noticeBatch)
      // Its turn already stands: if this was a cough, the reply is said again (onUtterance, below).
      else cutReply.cut(sayingText)
    }
    // The user goes on talking before Ceci answered: the last turn waits to be joined.
    if ((event.type === 'start' || event.type === 'barge') && joiner.resumed()) {
      turns.drop()
      cancelSpeech()
      // A newer turn is being answered again: an older reply cut here is out of date.
      cutReply.clear()
    }
    if (event.type === 'end') endTurn(event.audio)
    if (event.type === 'drop') {
      isBargeTurn = false
      unduck()
      onTurnEnd(joiner.dropped())
      // Too short to be speech: the reply it cut off is said again, in its turn in the queue.
      if (cutReply.isCut) queue(() => (cutReply.isCut && !isEnded ? speak(cutReply.take()) : null))
    }
    // A short pause: the turn model says whether the user is done, so Ceci need not wait for the
    // full silence. One question at a time: a pause asked about while the last answer is pending
    // waits for the next ask.
    if (event.type === 'candidate' && !isAskingTurn) {
      isAskingTurn = true
      ask('endpoint', { audio: event.audio }, [event.audio.buffer])
        .finally(() => (isAskingTurn = false))
        .then(({ done, ms }) => {
          timing('end of turn', ms, `p=${done.toFixed(2)}`)
          if (done < TURN_DONE || isEnded) return
          const end = vad.endNow(event.id)
          if (end?.type === 'end') endTurn(end.audio)
          if (end?.type === 'drop') {
            isBargeTurn = false
            unduck()
            onTurnEnd(joiner.dropped())
          }
        })
        .catch(() => {})
    }
  }

  const session = {
    sendContextualUpdate: text => remember(String(text ?? '')),
    // The window's fixed notice: the brain turns the news in the context into a short spoken update.
    // `batch` names the news it tells, handed back to onNoticeCut if the user cuts it.
    sendUserMessage: (text, batch = null) => queue(() => think({ kind: 'notice', text: String(text ?? '') }, null, null, batch)),
    setMicMuted: next => {
      isMuted = Boolean(next)
      if (isMuted) {
        vad.reset()
        cutReply.clear()
        isBargeTurn = false
        unduck()
      }
    },
    // Silenciar: Ceci stops saying and hearing. Her audio is frozen where it is (the output clock
    // stops, so what is queued plays on from the same point) and nothing the mic picks up is taken
    // in. News and replies still in the queue wait: they are said after the pause ends.
    setPaused: next => {
      isPaused = Boolean(next)
      if (isPaused) {
        vad.reset()
        cutReply.clear()
        isBargeTurn = false
        unduck()
        outContext.suspend().catch(() => {})
      } else {
        outContext.resume().catch(() => {})
      }
    },
    // The user is mid-utterance, or what they said is still being written down or answered: the
    // window holds its spoken notices until they finish.
    isUserSpeaking: () => vad.inSpeech || userJobs > 0,
    getOutputVolume: outputLevel,
    endSession: async () => {
      if (isEnded) return
      isEnded = true
      cancelSpeech()
      frames.port.onmessage = null
      document.removeEventListener('click', resumeAudio)
      for (const track of stream.getTracks()) track.stop()
      await Promise.allSettled([micContext.close(), outContext.close()])
      onDisconnect({ reason: 'user' })
    },
    // For tests and the help page: say something without the brain.
    speak,
  }

  // A headset unplugged mid-call: Ceci can no longer hear, and the user is told so.
  for (const track of stream.getAudioTracks()) {
    track.onended = () => {
      if (!isEnded) onError('O microfone foi desconectado. Conecte-o, encerre a chamada e chame de novo.')
    }
  }

  onConnect()
  // Ceci greets from the same lines as the ElevenLabs agent (greetings.js), a different one each
  // call, so the user knows she is listening. Then, while nobody talks, the acknowledgements.
  // A failed greeting is only logged.
  void say(pickGreeting({ name: herName, gender: isMale ? 'male' : 'female' }))
    .catch(error => console.warn(`[luke-voice] the greeting failed: ${error?.message ?? error}`))
    .then(warmAcks)
  return session
}

// ?voice-echo=1: repeats what it heard, to judge the transcription and the voice without the brain.
async function echoBrain(request) {
  return { say: request.kind === 'user' ? `Você disse: ${request.text}` : '', tool: null }
}

export function earlyDropMessage(reason) {
  return `A chamada local caiu logo no início${reason && reason !== 'user' ? `: ${reason}` : ''}. Toque em Chamar para tentar de novo.`
}
