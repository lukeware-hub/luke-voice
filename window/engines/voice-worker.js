// The local voice, off the page's main thread: Whisper turns speech into text, and Kokoro
// (with pt-BR phonemes from espeak-ng) turns text into speech. All code comes from /vendor/,
// which the hub verified by hash; the model weights come from Hugging Face and the browser caches them.
import { AutoTokenizer, StyleTextToSpeech2Model, Tensor, env, pipeline } from '/vendor/transformers/transformers.min.js'
import { getPhonemes, initialize, setVoice } from '/vendor/espeak/dist/espeak.mjs'

const KOKORO = 'onnx-community/Kokoro-82M-v1.0-ONNX'
const WHISPER = { base: 'onnx-community/whisper-base', small: 'onnx-community/whisper-small' }
const VOICES = `https://huggingface.co/${KOKORO}/resolve/main/voices`
const STYLE = 256
const SAMPLE_RATE = 24_000

env.allowLocalModels = false
env.backends.onnx.wasm.wasmPaths = '/vendor/transformers/'
// Threads speed up the CPU path ~25% from 4 to 8; leave one core for the rest of the machine.
env.backends.onnx.wasm.numThreads = self.crossOriginIsolated ? Math.max(1, Math.min(8, (navigator.hardwareConcurrency || 2) - 1)) : 1

let tts = null // { model, tokenizer, voice: Float32Array, voiceName }
let stt = null // the Whisper speech recognition pipeline
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

async function voiceData(name) {
  const url = `${VOICES}/${name}.bin`
  let cache = null
  try {
    cache = await caches.open('luke-voice-voices')
    const hit = await cache.match(url)
    if (hit) return new Float32Array(await hit.arrayBuffer())
  } catch {
    cache = null
  }
  const res = await fetch(url)
  if (!res.ok) throw new Error(`Voice ${name} did not download (${res.status}).`)
  const bytes = await res.arrayBuffer()
  await cache?.put(url, new Response(bytes.slice(0)))
  return new Float32Array(bytes)
}

async function load({ voice = 'pf_dora', language = 'pt-br', device: forced, dtype, threads, stt: sttSize, sttDtype } = {}) {
  if (threads) env.backends.onnx.wasm.numThreads = threads
  const gpu = forced ? forced === 'webgpu' : await hasWebGpu()
  const device = gpu ? 'webgpu' : 'wasm'
  post('status', { stage: 'loading', device })
  // On the CPU, fp16 is as fast as fp32 at half the download, and q8 is ~2x slower. WebGPU runs fp32.
  const kokoroType = dtype ?? (gpu ? 'fp32' : 'fp16')
  const whisperType = sttDtype
    ? { encoder_model: sttDtype, decoder_model_merged: sttDtype }
    : gpu
      ? { encoder_model: 'fp32', decoder_model_merged: 'fp32' }
      : { encoder_model: 'q8', decoder_model_merged: 'q8' }
  const [model, tokenizer, voiceArray, recognizer] = await Promise.all([
    StyleTextToSpeech2Model.from_pretrained(KOKORO, { dtype: kokoroType, device, progress_callback: progress }),
    AutoTokenizer.from_pretrained(KOKORO, { progress_callback: progress }),
    voiceData(voice),
    pipeline('automatic-speech-recognition', WHISPER[sttSize] ?? WHISPER.base, { dtype: whisperType, device, progress_callback: progress }),
    initialize('/vendor/espeak/dist').then(() => setVoice(language)),
  ])
  tts = { model, tokenizer, voice: voiceArray, voiceName: voice }
  stt = recognizer
  // The first run of each model is several times slower (shader and kernel setup): pay it now, not on the first reply.
  post('status', { stage: 'warming', device })
  const started = performance.now()
  await synthesize('Oi.')
  await transcribe(new Float32Array(16_000))
  post('ready', { device, threads: env.backends.onnx.wasm.numThreads, warmMs: Math.round(performance.now() - started) })
}

const hasNaN = audio => {
  for (let i = 0; i < audio.length; i++) if (!Number.isFinite(audio[i])) return true
  return false
}

// Kokoro sometimes returns NaN audio for an input (seen with fp16 on the CPU). A slightly
// different speed changes the internal lengths and avoids it; if not, the chunk is silent
// and the caller is told, instead of playing garbage.
async function speakChunk(text, speed = 1) {
  for (const s of [speed, speed * 0.96, speed * 1.04]) {
    const audio = await synthesize(text, s)
    if (!hasNaN(audio)) return { audio, isBroken: false, retried: s !== speed }
  }
  return { audio: new Float32Array(0), isBroken: true, retried: true }
}

// One chunk of text to 24 kHz audio. The style vector depends on the token count, as in Kokoro's reference code.
async function synthesize(text, speed = 1) {
  const phonemes = getPhonemes(text)
    .map(p => p.phonemes + (p.terminator || ''))
    .join(' ')
  const { input_ids } = tts.tokenizer(phonemes, { truncation: true })
  const tokens = input_ids.dims.at(-1)
  const row = Math.min(Math.max(tokens - 2, 0), 509)
  const style = tts.voice.slice(row * STYLE, row * STYLE + STYLE)
  const { waveform } = await tts.model({
    input_ids,
    style: new Tensor('float32', style, [1, STYLE]),
    speed: new Tensor('float32', [speed], [1]),
  })
  return waveform.data
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
      const { audio, isBroken, retried } = await speakChunk(data.text, data.speed)
      return post('audio', { id, audio, isBroken, retried, sampleRate: SAMPLE_RATE, ms: Math.round(performance.now() - started) }, [audio.buffer])
    }
    if (type === 'transcribe') {
      const started = performance.now()
      const text = await transcribe(data.audio, data.language)
      return post('text', { id, text, ms: Math.round(performance.now() - started) })
    }
    post('error', { id, message: `Unknown request: ${type}` })
  } catch (error) {
    if (type === 'load') ready = null
    post('error', { id, message: String(error?.message ?? error) })
  }
}
