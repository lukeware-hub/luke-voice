// The local voice, off the page's main thread: Whisper turns speech into text, and Kokoro
// (with pt-BR phonemes from espeak-ng) turns text into speech. Piper is the light fallback voice:
// it speaks when Kokoro cannot load, or when this computer is too slow for Kokoro.
// All code comes from /vendor/ and every model file from /models/: the hub downloaded them (at
// install time, or on first use), checked them by sha256 and serves them from disk.
import { AutoTokenizer, StyleTextToSpeech2Model, Tensor, WhisperFeatureExtractor, env, pipeline } from '/vendor/transformers/transformers.min.js'
import { getPhonemes, initialize, setVoice } from '/vendor/espeak/dist/espeak.mjs'
import { phonemeIds } from '/engines/piper-ids.js'

const KOKORO = 'onnx-community/Kokoro-82M-v1.0-ONNX'
const WHISPER = 'onnx-community/whisper-base'
// The hub's copies of the pinned Hugging Face files (hub/models.mjs, group light).
const MODELS = `${self.location.origin}/models/light/`
const VOICES = `${MODELS}${KOKORO}/voices`
const PIPER = `${MODELS}rhasspy/piper-voices/pt/pt_BR/faber/medium/pt_BR-faber-medium`
const STYLE = 256
const KOKORO_RATE = 24_000
// Kokoro slower than real time on this computer means gaps while Ceci speaks: use Piper instead.
const MAX_KOKORO_RTF = 1
// Smart Turn reads the last 8 s at 16 kHz.
const TURN_SAMPLES = 128_000
// At least ~200 ms that Silero hears as speech, or the utterance is noise.
const MIN_SPEECH_FRAMES = 6
const RTF_PROBE = 'Tudo certo, já estou pronta para ajudar você agora.'

env.allowLocalModels = false
// transformers.js asks the hub, as {host}{model}/{file}, for the files a model needs.
env.remoteHost = MODELS
env.remotePathTemplate = '{model}/'
// The hub already keeps them on disk: no second copy in the browser.
env.useBrowserCache = false
env.backends.onnx.wasm.wasmPaths = '/vendor/transformers/'
// Threads speed up the CPU path ~25% from 4 to 8; leave one core for the rest of the machine.
env.backends.onnx.wasm.numThreads = self.crossOriginIsolated ? Math.max(1, Math.min(8, (navigator.hardwareConcurrency || 2) - 1)) : 1

let engine = 'kokoro' // the voice that speaks: 'kokoro' or 'piper'
let kokoro = null // { model, tokenizer, voice: Float32Array }
let piper = null // { ort, session, config }
let stt = null // the Whisper speech recognition pipeline
let turn = null // { ort, smart, silero, features }: end-of-turn and speech checks; null if they did not load
let sttName = ''
let ready = null

const post = (type, data = {}, transfer = []) => self.postMessage({ type, ...data }, transfer)

// Download progress for every file, summed, so the window can show one percentage.
const files = new Map()
function progress(info) {
  if (info.status !== 'progress' && info.status !== 'done') return
  const total = info.total || files.get(info.file)?.total || 0
  files.set(info.file, { loaded: info.status === 'done' ? total : info.loaded || 0, total })
  let loaded = 0
  let sum = 0
  for (const f of files.values()) {
    loaded += f.loaded
    sum += f.total
  }
  if (sum > 0) post('progress', { loaded, total: sum })
}

async function hasWebGpu() {
  try {
    return Boolean(await navigator.gpu?.requestAdapter())
  } catch {
    return false
  }
}

// A model file from the hub.
async function modelBytes(url, label) {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`${label} did not load (${res.status}).`)
  return res.arrayBuffer()
}

async function loadKokoro({ device, dtype, voice }) {
  const [model, tokenizer, voiceBytes] = await Promise.all([
    StyleTextToSpeech2Model.from_pretrained(KOKORO, { dtype, device, progress_callback: progress }),
    AutoTokenizer.from_pretrained(KOKORO, { progress_callback: progress }),
    modelBytes(`${VOICES}/${voice}.bin`, `Voice ${voice}`),
  ])
  kokoro = { model, tokenizer, voice: new Float32Array(voiceBytes) }
}

// Piper, Smart Turn and Silero run on the CPU with their own copy of onnxruntime (the same
// version transformers.js uses, so the same .jsep.wasm).
let ortModule = null
async function loadOrt() {
  if (ortModule) return ortModule
  const ort = await import('/vendor/onnxruntime/ort.webgpu.bundle.min.mjs')
  ort.env.wasm.wasmPaths = '/vendor/transformers/'
  ort.env.wasm.numThreads = env.backends.onnx.wasm.numThreads
  ortModule = ort
  return ort
}

// Smart Turn v3.2 (is the user done?) and Silero VAD (is it speech at all?), from the hub's /models/.
async function loadTurn() {
  const ort = await loadOrt()
  const options = { executionProviders: ['wasm'] }
  const [smart, silero] = await Promise.all([
    ort.InferenceSession.create('/models/turn/smart-turn-v3.2-cpu.onnx', options),
    ort.InferenceSession.create('/models/turn/silero-vad.onnx', options),
  ])
  // The Whisper front end Smart Turn was trained on: 8 s windows, 80 mel bins.
  const features = new WhisperFeatureExtractor({
    feature_size: 80,
    sampling_rate: 16_000,
    hop_length: 160,
    chunk_length: 8,
    n_fft: 400,
    padding_value: 0,
    n_samples: TURN_SAMPLES,
    nb_max_frames: 800,
  })
  turn = { ort, smart, silero, features }
}

// Probability that the user finished their turn, from the last 8 s of the utterance, as Smart
// Turn's reference code does: zero mean and unit variance, padded with silence at the start so
// the speech sits at the end of the window.
async function endOfTurn(audio) {
  const tail = audio.length > TURN_SAMPLES ? audio.subarray(audio.length - TURN_SAMPLES) : audio
  let mean = 0
  for (const v of tail) mean += v
  mean /= tail.length || 1
  let variance = 0
  for (const v of tail) variance += (v - mean) ** 2
  const std = Math.sqrt(variance / (tail.length || 1) + 1e-7)
  const input = new Float32Array(TURN_SAMPLES)
  const offset = TURN_SAMPLES - tail.length
  for (let i = 0; i < tail.length; i++) input[offset + i] = (tail[i] - mean) / std
  const { input_features: x } = await turn.features(input)
  const out = await turn.smart.run({ input_features: new turn.ort.Tensor('float32', x.data, x.dims) })
  return out.logits.data[0]
}

// How many 32 ms frames of the utterance Silero hears as speech, stopping once it reaches `limit`.
async function speechFrames(audio, limit = Infinity) {
  const { ort, silero } = turn
  const sr = new ort.Tensor('int64', BigInt64Array.from([16_000n]), [])
  let state = new ort.Tensor('float32', new Float32Array(2 * 128), [2, 1, 128])
  let context = new Float32Array(64)
  let count = 0
  for (let i = 0; i + 512 <= audio.length && count < limit; i += 512) {
    const frame = audio.subarray(i, i + 512)
    const input = new Float32Array(576)
    input.set(context)
    input.set(frame, 64)
    const out = await silero.run({ input: new ort.Tensor('float32', input, [1, 576]), state, sr })
    state = out.stateN
    if (out.output.data[0] > 0.5) count++
    context = frame.slice(448)
  }
  return count
}

async function loadPiper() {
  if (piper) return
  const ort = await loadOrt()
  const [model, config] = await Promise.all([
    modelBytes(`${PIPER}.onnx`, 'The Piper voice'),
    modelBytes(`${PIPER}.onnx.json`, 'The Piper voice settings').then(bytes => JSON.parse(new TextDecoder().decode(bytes))),
  ])
  const session = await ort.InferenceSession.create(new Uint8Array(model), { executionProviders: ['wasm'] })
  piper = { ort, session, config }
}

async function load({ voice = 'pf_dora', language = 'pt-br', device: forced, dtype, threads, sttDtype, sttDevice: sttDeviceChoice, tts: ttsChoice, native = false } = {}) {
  if (threads) env.backends.onnx.wasm.numThreads = threads
  // The native engine speaks and listens in the hub: here only the end-of-turn and speech checks.
  if (native) {
    post('status', { stage: 'loading', device: 'native' })
    await loadTurn().catch(error => console.warn(`[luke-voice] end-of-turn models did not load: ${error?.message ?? error}`))
    engine = 'native'
    sttName = 'native'
    return post('ready', { device: 'native', threads: env.backends.onnx.wasm.numThreads, warmMs: 0, tts: 'native', stt: 'native', turn: Boolean(turn) })
  }
  const gpu = forced ? forced === 'webgpu' : await hasWebGpu()
  const device = gpu ? 'webgpu' : 'wasm'
  post('status', { stage: 'loading', device })
  // Kokoro: fp32 on WebGPU (fp16 there gives NaN audio); fp16 on the CPU, as fast as fp32 at half the download.
  const kokoroType = dtype ?? (gpu ? 'fp32' : 'fp16')
  // Whisper base q8 on the CPU everywhere: 77 MB instead of 291 MB for fp32 on WebGPU, ~1.4 s
  // per 4 s of speech. On WebGPU only fp32 works (q8 and fp16 give nonsense there).
  const sttDevice = sttDeviceChoice ?? 'wasm'
  const whisperType = sttDtype
    ? { encoder_model: sttDtype, decoder_model_merged: sttDtype }
    : sttDevice === 'webgpu'
      ? { encoder_model: 'fp32', decoder_model_merged: 'fp32' }
      : { encoder_model: 'q8', decoder_model_merged: 'q8' }
  sttName = 'whisper-base'
  // Why the voice is Piper when Kokoro was the plan: said to the user (local.js), never hidden.
  let fallback = null
  const loadVoice = async () => {
    if (ttsChoice === 'piper') {
      engine = 'piper'
      return loadPiper()
    }
    try {
      await loadKokoro({ device, dtype: kokoroType, voice })
      engine = 'kokoro'
    } catch (error) {
      // Kokoro did not load (memory, download, GPU): Ceci still speaks, with the lighter voice.
      console.warn(`[luke-voice] Kokoro did not load, using Piper: ${error?.message ?? error}`)
      fallback = 'A voz Kokoro não carregou neste computador; usando a voz Piper, mais leve.'
      engine = 'piper'
      await loadPiper()
    }
  }
  const [recognizer] = await Promise.all([
    pipeline('automatic-speech-recognition', WHISPER, { dtype: whisperType, device: sttDevice, progress_callback: progress }),
    loadVoice(),
    initialize('/vendor/espeak/dist').then(() => setVoice(language)),
    // The turn models are a bonus: without them the level detector ends turns as before.
    loadTurn().catch(error => console.warn(`[luke-voice] end-of-turn models did not load: ${error?.message ?? error}`)),
  ])
  stt = recognizer

  // The first run of each model is several times slower (shader and kernel setup): pay it now, not on the first reply.
  post('status', { stage: 'warming', device })
  const started = performance.now()
  await speakChunk('Oi.')
  await transcribe(new Float32Array(16_000))
  // Kokoro slower than real time here: switch to Piper, unless Kokoro was asked for by name.
  // One run can be slow by chance (a background task, a first-run cost left over): up to three
  // runs, until two agree, and the median decides.
  if (engine === 'kokoro' && !gpu && ttsChoice !== 'kokoro') {
    const rtfs = []
    while (rtfs.length < 3) {
      const probeStart = performance.now()
      const { audio, sampleRate } = await speakChunk(RTF_PROBE)
      rtfs.push((performance.now() - probeStart) / 1000 / Math.max(0.1, audio.length / sampleRate))
      const slow = rtfs.filter(r => r > MAX_KOKORO_RTF).length
      if (slow >= 2 || rtfs.length - slow >= 2) break
    }
    const rtf = median(rtfs)
    if (rtf > MAX_KOKORO_RTF) {
      console.warn(`[luke-voice] Kokoro is slower than real time here (RTF ${rtfs.map(r => r.toFixed(2)).join(', ')}), using Piper`)
      fallback = 'A voz Kokoro está lenta neste computador; usando a voz Piper, mais leve.'
      post('status', { stage: 'loading', device })
      await loadPiper()
      engine = 'piper'
      await kokoro?.model?.dispose?.()
      kokoro = null
      await speakChunk('Oi.')
    }
  }
  post('ready', { device, threads: env.backends.onnx.wasm.numThreads, warmMs: Math.round(performance.now() - started), tts: engine, stt: sttName, turn: Boolean(turn), fallback })
}

// The middle value (the mean of the two middle ones for an even count).
const median = values => {
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2
}

const hasNaN = audio => {
  for (let i = 0; i < audio.length; i++) if (!Number.isFinite(audio[i])) return true
  return false
}

// Kokoro sometimes returns NaN audio for an input (seen with fp16 on the CPU). A slightly
// different speed changes the internal lengths and avoids it; if not, the chunk is silent
// and the caller is told, instead of playing garbage.
async function speakChunk(text, speed = 1) {
  const synthesize = engine === 'piper' ? synthesizePiper : synthesizeKokoro
  const sampleRate = engine === 'piper' ? piper.config.audio?.sample_rate ?? 22_050 : KOKORO_RATE
  for (const s of [speed, speed * 0.96, speed * 1.04]) {
    const audio = await synthesize(text, s)
    if (!hasNaN(audio)) return { audio, sampleRate, isBroken: false, retried: s !== speed }
  }
  return { audio: new Float32Array(0), sampleRate, isBroken: true, retried: true }
}

const phonemesOf = text =>
  getPhonemes(text)
    .map(p => p.phonemes + (p.terminator || ''))
    .join(' ')

// One chunk of text to 24 kHz audio. The style vector depends on the token count, as in Kokoro's reference code.
async function synthesizeKokoro(text, speed = 1) {
  const { input_ids } = kokoro.tokenizer(phonemesOf(text), { truncation: true })
  const tokens = input_ids.dims.at(-1)
  const row = Math.min(Math.max(tokens - 2, 0), 509)
  const style = kokoro.voice.slice(row * STYLE, row * STYLE + STYLE)
  const { waveform } = await kokoro.model({
    input_ids,
    style: new Tensor('float32', style, [1, STYLE]),
    speed: new Tensor('float32', [speed], [1]),
  })
  return waveform.data
}

// One chunk of text to audio at the Piper voice's rate (22.05 kHz for faber).
async function synthesizePiper(text, speed = 1) {
  const { ort, session, config } = piper
  const ids = phonemeIds(phonemesOf(text), config.phoneme_id_map)
  const { noise_scale: noise = 0.667, length_scale: length = 1, noise_w: noiseW = 0.8 } = config.inference ?? {}
  const out = await session.run({
    input: new ort.Tensor('int64', BigInt64Array.from(ids, BigInt), [1, ids.length]),
    input_lengths: new ort.Tensor('int64', BigInt64Array.from([BigInt(ids.length)]), [1]),
    scales: new ort.Tensor('float32', Float32Array.from([noise, length / speed, noiseW]), [3]),
  })
  return out.output.data
}

async function transcribe(audio, language = 'portuguese') {
  const out = await stt(audio, { language, task: 'transcribe', max_new_tokens: 224 })
  return String(out?.text ?? '').trim()
}

self.onmessage = async ({ data }) => {
  const { id, type } = data
  try {
    if (type === 'load') {
      ready ??= load(data)
      await ready
      return post('done', { id })
    }
    await ready
    if (type === 'speak') {
      const started = performance.now()
      const { audio, sampleRate, isBroken, retried } = await speakChunk(data.text, data.speed)
      return post('audio', { id, audio, isBroken, retried, sampleRate, ms: Math.round(performance.now() - started) }, [audio.buffer])
    }
    if (type === 'transcribe') {
      const started = performance.now()
      // Noise with no speech in it (a fan, typing) never reaches Whisper, which would invent words.
      if (turn) {
        const frames = await speechFrames(data.audio, MIN_SPEECH_FRAMES)
        if (frames < MIN_SPEECH_FRAMES) return post('text', { id, text: '', noSpeech: true, ms: Math.round(performance.now() - started) })
      }
      const text = await transcribe(data.audio, data.language)
      return post('text', { id, text, ms: Math.round(performance.now() - started) })
    }
    // For the native engine: how many frames Silero hears as speech, before the audio leaves the page.
    if (type === 'check') {
      const started = performance.now()
      const frames = turn ? await speechFrames(data.audio) : MIN_SPEECH_FRAMES
      return post('check', { id, frames, isSpeech: frames >= MIN_SPEECH_FRAMES, ms: Math.round(performance.now() - started) })
    }
    if (type === 'endpoint') {
      const started = performance.now()
      const done = turn ? await endOfTurn(data.audio) : 1
      return post('endpoint', { id, done, ms: Math.round(performance.now() - started) })
    }
    post('error', { id, message: `Unknown request: ${type}` })
  } catch (error) {
    if (type === 'load') ready = null
    post('error', { id, message: String(error?.message ?? error) })
  }
}
