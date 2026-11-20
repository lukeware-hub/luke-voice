// Model files for the free voice, pinned by revision and sha256. They are downloaded once into
// ~/.luke-voice/models (at install time by setup.mjs, or on first use), resumed when a download is
// cut, and checked before use. The hub serves them to the call window at /models/.
import { createHash } from 'node:crypto'
import { createReadStream, createWriteStream, existsSync, mkdirSync, renameSync, rmSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'

import { stateDir } from './paths.mjs'

const HF = 'https://huggingface.co'
const SMART_TURN = `${HF}/pipecat-ai/smart-turn-v3/resolve/f766f81d3cfdf7737ac64aad813d91bbfd56bf93`
const SILERO = `${HF}/onnx-community/silero-vad/resolve/e71cae966052b992a7eca6b17738916ce0eca4ec`
const QWEN_TTS = `${HF}/mradermacher/Qwen3-TTS-12Hz-0.6B-Base-GGUF/resolve/0762b31e9cd99274d49dca4e895bd81863134f08`
const QWEN_ASR = `${HF}/ggml-org/Qwen3-ASR-0.6B-GGUF/resolve/928ab958557df9aa2ef1c93e0e83c7ad0933fae2`
// Files converted for luke-voice and published on its own GitHub release (see the release notes).
const LUKE_MODELS = 'https://github.com/lukeware-hub/luke-voice/releases/download/voice-models-v1'
const ROUTER = `${HF}/unsloth/Qwen3.5-0.8B-GGUF/resolve/6ab461498e2023f6e3c1baea90a8f0fe38ab64d0`

// Served path (under /models/) -> source, sha256 and size. `group` says which feature needs it.
export const MODELS = {
  // Pipecat Smart Turn v3.2 (BSD-2-Clause): is the user done talking? 23 languages, Portuguese included.
  'turn/smart-turn-v3.2-cpu.onnx': {
    url: `${SMART_TURN}/smart-turn-v3.2-cpu.onnx`,
    sha256: '2bb026316b14a660486a75b1733cd3fbab8c2fd0314dc9af7be49f8cca967e4f',
    size: 8679182,
    group: 'turn',
  },
  // Silero VAD v5 (MIT): is there speech at all? Noise without speech never reaches Whisper.
  'turn/silero-vad.onnx': {
    url: `${SILERO}/onnx/model.onnx`,
    sha256: 'a4a068cd6cf1ea8355b84327595838ca748ec29a25bc91fc82e6c299ccdc5808',
    size: 2243022,
    group: 'turn',
  },

  // The native engine (gpu profile), all run by llama.cpp's llama-server (hub/engine.mjs).
  // Qwen3-TTS 0.6B Base (Apache-2.0): Ceci's voice, cloned from agent/ceci-voice.wav, streamed.
  'native/qwen3-tts-0.6b-base-q8_0.gguf': {
    url: `${QWEN_TTS}/Qwen3-TTS-12Hz-0.6B-Base.Q8_0.gguf`,
    sha256: '59b28b4ab6a1c4e24e6701fc871a427c1fb3e8333f0ed5cebec3bb67a699ae8e',
    size: 646211264,
    group: 'native',
  },
  // Its projector with the speech tokenizer's reference encoder (converted with llama.cpp b12556):
  // cloning from the reference clip AND its transcript keeps Ceci's accent Brazilian; the public
  // projector clones from the speaker embedding only, which pulled her toward European Portuguese.
  'native/qwen3-tts-0.6b-base-mmproj-icl-q8_0.gguf': {
    url: `${LUKE_MODELS}/qwen3-tts-0.6b-base-mmproj-icl-q8_0.gguf`,
    sha256: 'a49882472bb035b349ade86821a4c7999852d8f6d51f2f2681b0ce653fa0baaf',
    size: 587081344,
    group: 'native',
  },
  // Qwen3-ASR 0.6B (Apache-2.0): what the user said, ~90 ms per sentence on a mid-range GPU.
  'native/qwen3-asr-0.6b-q8_0.gguf': {
    url: `${QWEN_ASR}/Qwen3-ASR-0.6B-Q8_0.gguf`,
    sha256: 'bca259818b50ca7c4c05e9bdb35a5dc04fa039653a6d6f3f0f331f96f6aa1971',
    size: 804749248,
    group: 'native',
  },
  'native/qwen3-asr-0.6b-mmproj-q8_0.gguf': {
    url: `${QWEN_ASR}/mmproj-Qwen3-ASR-0.6B-Q8_0.gguf`,
    sha256: '41a342b5e4c514e968cb756de6cd1b7be39eff43c44c57a2ef5fc6522e36603d',
    size: 214392480,
    group: 'native',
  },
  // Qwen3.5 0.8B (Apache-2.0), on the CPU: the instant local router of the hybrid brain.
  'native/qwen3.5-0.8b-q4_k_m.gguf': {
    url: `${ROUTER}/Qwen3.5-0.8B-Q4_K_M.gguf`,
    sha256: 'bd258782e35f7f458f8aced1adc053e6e92e89bc735ba3be89d38a06121dc517',
    size: 532517120,
    group: 'native',
  },
}

export const modelsDir = () => join(stateDir(), 'models')

// Files whose hash was already checked by this process, so a big model is not hashed on every request.
const verified = new Set()
// One download per file at a time, shared by every caller meanwhile.
const inFlight = new Map()

async function sha256Of(file) {
  const hash = createHash('sha256')
  await pipeline(createReadStream(file), hash)
  return hash.digest('hex')
}

const sizeOf = file => (existsSync(file) ? statSync(file).size : 0)

// Downloads into `${file}.part`, resuming from what is already there, then checks and moves it in place.
async function download(entry, file, { request, onProgress }) {
  const part = `${file}.part`
  mkdirSync(dirname(file), { recursive: true })
  let have = sizeOf(part)
  if (have > entry.size) {
    rmSync(part, { force: true })
    have = 0
  }
  if (have < entry.size) {
    const res = await request(entry.url, have ? { headers: { range: `bytes=${have}-` } } : undefined)
    if (!res.ok) throw new Error(`Download failed (${res.status}): ${entry.url}`)
    // A server that ignores the range sends the whole file again.
    if (have && res.status !== 206) have = 0
    let loaded = have
    const counted = Readable.fromWeb(res.body)
    counted.on('data', chunk => {
      loaded += chunk.length
      onProgress?.(loaded, entry.size)
    })
    await pipeline(counted, createWriteStream(part, { flags: have ? 'a' : 'w' }))
  }
  if ((await sha256Of(part)) !== entry.sha256) {
    rmSync(part, { force: true })
    throw new Error(`Integrity check failed: ${entry.url}`)
  }
  renameSync(part, file)
  verified.add(file)
  return file
}

// A verified file at `file` for `entry` ({ url, sha256, size }), downloading it if needed.
export async function ensureFile(entry, file, { request = fetch, onProgress } = {}) {
  if (verified.has(file) && sizeOf(file) === entry.size) return file
  if (sizeOf(file) === entry.size && (await sha256Of(file)) === entry.sha256) {
    verified.add(file)
    return file
  }
  if (!inFlight.has(file)) {
    rmSync(file, { force: true })
    inFlight.set(file, download(entry, file, { request, onProgress }).finally(() => inFlight.delete(file)))
  }
  return inFlight.get(file)
}

// The local path of a verified model file, downloading it if needed. Null for an unknown path.
export async function ensureModel(path, { dir = modelsDir(), request = fetch, onProgress } = {}) {
  const entry = MODELS[path]
  if (!entry) return null
  return ensureFile(entry, join(dir, ...path.split('/')), { request, onProgress })
}

// What is on disk for a group of models (or all): how many files and bytes, of how many.
export function modelsStatus({ dir = modelsDir(), group } = {}) {
  const entries = Object.entries(MODELS).filter(([, e]) => !group || e.group === group)
  let present = 0
  let bytes = 0
  let total = 0
  for (const [path, entry] of entries) {
    total += entry.size
    const size = sizeOf(join(dir, ...path.split('/')))
    if (size === entry.size) present++
    bytes += Math.min(size, entry.size)
  }
  return { files: entries.length, present, bytes, total }
}
