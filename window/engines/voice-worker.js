// The local voice, off the page's main thread: Whisper turns speech into text, and Kokoro
// (with pt-BR phonemes from espeak-ng) turns text into speech. Piper is the light fallback voice:
// it speaks when Kokoro cannot load, or when this computer is too slow for Kokoro.
// All code comes from /vendor/, which the hub verified by hash; the model weights come from
// Hugging Face and the browser caches them.
import { AutoTokenizer, StyleTextToSpeech2Model, Tensor, WhisperFeatureExtractor, env, pipeline } from '/vendor/transformers/transformers.min.js'
import { getPhonemes, initialize, setVoice } from '/vendor/espeak/dist/espeak.mjs'
import { phonemeIds } from '/engines/piper-ids.js'

const KOKORO = 'onnx-community/Kokoro-82M-v1.0-ONNX'
const WHISPER = { base: 'onnx-community/whisper-base', small: 'onnx-community/whisper-small' }
const VOICES = `https://huggingface.co/${KOKORO}/resolve/main/voices`
// Pinned to a revision of rhasspy/piper-voices, so the voice never changes under us.
const PIPER = 'https://huggingface.co/rhasspy/piper-voices/resolve/42301ec547bc2939386cf0ae9f9050ca05b1d3af/pt/pt_BR/faber/medium/pt_BR-faber-medium'
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

// A file from Hugging Face, kept in the browser's Cache Storage after the first download.
async function cachedBytes(url, label) {
  let cache = null
  try {
    cache = await caches.open('luke-voice-voices')
    const hit = await cache.match(url)
    if (hit) return hit.arrayBuffer()
  } catch {
    cache = null
  }
  const res = await fetch(url)
  if (!res.ok) throw new Error(`${label} did not download (${res.status}).`)
  const bytes = await res.arrayBuffer()
  await cache?.put(url, new Response(bytes.slice(0)))
  return bytes
}

async function loadKokoro({ device, dtype, voice }) {
  const [model, tokenizer, voiceBytes] = await Promise.all([
    StyleTextToSpeech2Model.from_pretrained(KOKORO, { dtype, device, progress_callback: progress }),
    AutoTokenizer.from_pretrained(KOKORO, { progress_callback: progress }),
    cachedBytes(`${VOICES}/${voice}.bin`, `Voice ${voice}`),
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
// Turn's reference code does: zero mean and unit variance, padded with silence at the end.
async function endOfTurn(audio) {
  const tail = audio.length > TURN_SAMPLES ? audio.subarray(audio.length - TURN_SAMPLES) : audio
  let mean = 0
  for (const v of tail) mean += v
  mean /= tail.length || 1
  let variance = 0
  for (const v of tail) variance += (v - mean) ** 2
  const std = Math.sqrt(variance / (tail.length || 1) + 1e-7)
  const input = new Float32Array(TURN_SAMPLES)
  for (let i = 0; i < tail.length; i++) input[i] = (tail[i] - mean) / std
  const { input_features: x } = await turn.features(input)
  const out = await turn.smart.run({ input_features: new turn.ort.Tensor('float32', x.data, x.dims) })
  return out.logits.data[0]
}

// How many 32 ms frames of the utterance Silero hears as speech.
async function speechFrames(audio) {
  const { ort, silero } = turn
  const sr = new ort.Tensor('int64', BigInt64Array.from([16_000n]), [])
  let state = new ort.Tensor('float32', new Float32Array(2 * 128), [2, 1, 128])
  let context = new Float32Array(64)
  let count = 0
  for (let i = 0; i + 512 <= audio.length; i += 512) {
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
    cachedBytes(`${PIPER}.onnx`, 'The Piper voice'),
    cachedBytes(`${PIPER}.onnx.json`, 'The Piper voice settings').then(bytes => JSON.parse(new TextDecoder().decode(bytes))),
  ])
  const session = await ort.InferenceSession.create(new Uint8Array(model), { executionProviders: ['wasm'] })
  piper = { ort, session, config }
}

async function load({ voice = 'pf_dora', language = 'pt-br', device: forced, dtype, threads, stt: sttSize, sttDtype, sttDevice: sttDeviceChoice, tts: ttsChoice } = {}) {
  if (threads) env.backends.onnx.wasm.numThreads = threads
  const gpu = forced ? forced === 'webgpu' : await hasWebGpu()
  const device = gpu ? 'webgpu' : 'wasm'
  post('status', { stage: 'loading', device })
  // Kokoro: fp32 on WebGPU (fp16 there gives NaN audio); fp16 on the CPU, as fast as fp32 at half the download.
  const kokoroType = dtype ?? (gpu ? 'fp32' : 'fp16')
  // Whisper base q8 on the CPU everywhere: 77 MB instead of 291 MB for fp32 on WebGPU, ~1.4 s
  // per 4 s of speech. On WebGPU only fp32 works (q8 and fp16 give nonsense there), and Whisper
  // small is ~1 GB in fp32 or ~5 s per 4 s on the CPU, so base stays.
  const sttDevice = sttDeviceChoice ?? 'wasm'
  const whisperType = sttDtype
    ? { encoder_model: sttDtype, decoder_model_merged: sttDtype }
    : sttDevice === 'webgpu'
      ? { encoder_model: 'fp32', decoder_model_merged: 'fp32' }
      : { encoder_model: 'q8', decoder_model_merged: 'q8' }
  sttName = `whisper-${WHISPER[sttSize] ? sttSize : 'base'}`
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
      engine = 'piper'
      await loadPiper()
    }
  }
  const [recognizer] = await Promise.all([
    pipeline('automatic-speech-recognition', WHISPER[sttSize] ?? WHISPER.base, { dtype: whisperType, device: sttDevice, progress_callback: progress }),
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
  if (engine === 'kokoro' && !gpu && ttsChoice !== 'kokoro') {
    const probeStart = performance.now()
    const { audio, sampleRate } = await speakChunk(RTF_PROBE)
    const rtf = (performance.now() - probeStart) / 1000 / Math.max(0.1, audio.length / sampleRate)
    if (rtf > MAX_KOKORO_RTF) {
      console.warn(`[luke-voice] Kokoro is slower than real time here (RTF ${rtf.toFixed(2)}), using Piper`)
      post('status', { stage: 'loading', device })
      await loadPiper()
      engine = 'piper'
      await kokoro?.model?.dispose?.()
      kokoro = null
      await speakChunk('Oi.')
    }
  }
  post('ready', { device, threads: env.backends.onnx.wasm.numThreads, warmMs: Math.round(performance.now() - started), tts: engine, stt: sttName, turn: Boolean(turn) })
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
  const out = await stt(audio, { language, task: 'transcribe', max_new_tokens: 128 })
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
        const frames = await speechFrames(data.audio)
        if (frames < MIN_SPEECH_FRAMES) return post('text', { id, text: '', noSpeech: true, ms: Math.round(performance.now() - started) })
      }
      const text = await transcribe(data.audio, data.language)
      return post('text', { id, text, ms: Math.round(performance.now() - started) })
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
