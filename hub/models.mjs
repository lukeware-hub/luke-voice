// Model files for the free voice, pinned by revision and sha256. They are downloaded once into
// ~/.luke-voice/models (at install time by setup.mjs, or on first use), resumed when a download is
// cut, and checked before use. The hub serves them to the call window at /models/.
import { createHash } from 'node:crypto'
import { createReadStream, createWriteStream, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { statfs } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'

import { stateDir } from './paths.mjs'

const HF = 'https://huggingface.co'
const SMART_TURN = `${HF}/pipecat-ai/smart-turn-v3/resolve/f766f81d3cfdf7737ac64aad813d91bbfd56bf93`
const SILERO = `${HF}/onnx-community/silero-vad/resolve/e71cae966052b992a7eca6b17738916ce0eca4ec`
const QWEN_ASR = `${HF}/ggml-org/Qwen3-ASR-0.6B-GGUF/resolve/928ab958557df9aa2ef1c93e0e83c7ad0933fae2`
// Files converted for luke-voice and published on its own GitHub release (see the release notes).
const LUKE_MODELS = 'https://github.com/lukeware-hub/luke-voice/releases/download/voice-models-v2'
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

  // The light profile (no GPU with 6 GB): the browser voice, served by the hub so the call never
  // waits on Hugging Face. Kokoro 82M (Apache-2.0): fp16 on the CPU (light-cpu), fp32 on WebGPU (light-webgpu).
  'light/onnx-community/Kokoro-82M-v1.0-ONNX/config.json': {
    url: 'https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX/resolve/1939ad2a8e416c0acfeecc08a694d14ef25f2231/config.json',
    sha256: 'df34b4f930b23447cd4dc410fabfb42eb3f24e803e6c3f97d618fb359380a36f',
    size: 44,
    group: 'light',
  },
  'light/onnx-community/Kokoro-82M-v1.0-ONNX/tokenizer.json': {
    url: 'https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX/resolve/1939ad2a8e416c0acfeecc08a694d14ef25f2231/tokenizer.json',
    sha256: '77a02c8e164413299b4b4c403b14f8e0e1c1b727db4d46a09d6327b861060a34',
    size: 3497,
    group: 'light',
  },
  'light/onnx-community/Kokoro-82M-v1.0-ONNX/tokenizer_config.json': {
    url: 'https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX/resolve/1939ad2a8e416c0acfeecc08a694d14ef25f2231/tokenizer_config.json',
    sha256: 'be1cb066d6ef6b074b3f15e6a6dd21ac88ff3cdaedf325f0aaed686c70f75d20',
    size: 113,
    group: 'light',
  },
  'light/onnx-community/Kokoro-82M-v1.0-ONNX/onnx/model_fp16.onnx': {
    url: 'https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX/resolve/1939ad2a8e416c0acfeecc08a694d14ef25f2231/onnx/model_fp16.onnx',
    sha256: 'ba4527a874b42b21e35f468c10d326fdff3c7fc8cac1f85e9eb6c0dfc35c334a',
    size: 163234740,
    group: 'light-cpu',
  },
  'light/onnx-community/Kokoro-82M-v1.0-ONNX/onnx/model.onnx': {
    url: 'https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX/resolve/1939ad2a8e416c0acfeecc08a694d14ef25f2231/onnx/model.onnx',
    sha256: '8fbea51ea711f2af382e88c833d9e288c6dc82ce5e98421ea61c058ce21a34cb',
    size: 325532232,
    group: 'light-webgpu',
  },
  'light/onnx-community/Kokoro-82M-v1.0-ONNX/voices/pf_dora.bin': {
    url: 'https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX/resolve/1939ad2a8e416c0acfeecc08a694d14ef25f2231/voices/pf_dora.bin',
    sha256: '3da7b5b2d91847ebf5646f57631af6ececae3c29a89cd300f06edf9aa6cfe9ee',
    size: 522240,
    group: 'light',
  },
  // The light voice's male voices, for Luke (pm_alex) and João (pm_santa): the same Kokoro voices as Ceci's pf_dora.
  'light/onnx-community/Kokoro-82M-v1.0-ONNX/voices/pm_alex.bin': {
    url: 'https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX/resolve/1939ad2a8e416c0acfeecc08a694d14ef25f2231/voices/pm_alex.bin',
    sha256: '0175c753f59c54e7fd5a995bedef0c5ff2fb67e0043dd3dcb2ae74ec2acbeb2a',
    size: 522240,
    group: 'light',
  },
  'light/onnx-community/Kokoro-82M-v1.0-ONNX/voices/pm_santa.bin': {
    url: 'https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX/resolve/1939ad2a8e416c0acfeecc08a694d14ef25f2231/voices/pm_santa.bin',
    sha256: '8b012db3185778afe2e45a62cbad69db73021774fe68dda634bcc748a982eede',
    size: 522240,
    group: 'light',
  },
  // Whisper base (MIT): q8 on the CPU; fp32 only when WebGPU is asked for (light-extra, on demand).
  'light/onnx-community/whisper-base/config.json': {
    url: 'https://huggingface.co/onnx-community/whisper-base/resolve/27a07b4b52b3a4c5886134bb4320e93e1a4bbc7c/config.json',
    sha256: 'f4d0608f7d918166da7edb3e188de5ef1bfe70d9802e785d271fd88111e9cf4b',
    size: 2243,
    group: 'light',
  },
  'light/onnx-community/whisper-base/generation_config.json': {
    url: 'https://huggingface.co/onnx-community/whisper-base/resolve/27a07b4b52b3a4c5886134bb4320e93e1a4bbc7c/generation_config.json',
    sha256: '61070cf8de25b1e9256e8e102ded49d8d24a8369ed36ef84fdf21549e68125a0',
    size: 3832,
    group: 'light',
  },
  'light/onnx-community/whisper-base/preprocessor_config.json': {
    url: 'https://huggingface.co/onnx-community/whisper-base/resolve/27a07b4b52b3a4c5886134bb4320e93e1a4bbc7c/preprocessor_config.json',
    sha256: 'a6a76d28c93edb273669eb9e0b0636a2bddbb1272c3261e47b7ca6dfdbac1b8d',
    size: 339,
    group: 'light',
  },
  'light/onnx-community/whisper-base/tokenizer.json': {
    url: 'https://huggingface.co/onnx-community/whisper-base/resolve/27a07b4b52b3a4c5886134bb4320e93e1a4bbc7c/tokenizer.json',
    sha256: '27fc476bfe7f17299480be2273fc0608e4d5a99aba2ab5dec5374b4482d1a566',
    size: 2480466,
    group: 'light',
  },
  'light/onnx-community/whisper-base/tokenizer_config.json': {
    url: 'https://huggingface.co/onnx-community/whisper-base/resolve/27a07b4b52b3a4c5886134bb4320e93e1a4bbc7c/tokenizer_config.json',
    sha256: '2e036e4dbacfdeb7242c7d4ec4149f4a16e86026048f94d1637e3a8ee9c6a573',
    size: 282682,
    group: 'light',
  },
  'light/onnx-community/whisper-base/onnx/encoder_model_quantized.onnx': {
    url: 'https://huggingface.co/onnx-community/whisper-base/resolve/27a07b4b52b3a4c5886134bb4320e93e1a4bbc7c/onnx/encoder_model_quantized.onnx',
    sha256: '5862993336bf33acd23736071aae2b32261d3b1b2f37780194460d4ef974dd46',
    size: 23201314,
    group: 'light',
  },
  'light/onnx-community/whisper-base/onnx/decoder_model_merged_quantized.onnx': {
    url: 'https://huggingface.co/onnx-community/whisper-base/resolve/27a07b4b52b3a4c5886134bb4320e93e1a4bbc7c/onnx/decoder_model_merged_quantized.onnx',
    sha256: 'fa3ef9902734ce5ae6f9ef2bdb2ba9a6c4b5785b09f4f420ce036573dc9d090b',
    size: 53693315,
    group: 'light',
  },
  'light/onnx-community/whisper-base/onnx/encoder_model.onnx': {
    url: 'https://huggingface.co/onnx-community/whisper-base/resolve/27a07b4b52b3a4c5886134bb4320e93e1a4bbc7c/onnx/encoder_model.onnx',
    sha256: 'a9f3b752833b49e880dec91ee5b6d936112be7c3ea07c221024ba493439f46fe',
    size: 82468078,
    group: 'light-extra',
  },
  'light/onnx-community/whisper-base/onnx/decoder_model_merged.onnx': {
    url: 'https://huggingface.co/onnx-community/whisper-base/resolve/27a07b4b52b3a4c5886134bb4320e93e1a4bbc7c/onnx/decoder_model_merged.onnx',
    sha256: '514903744bb1b45803ec571af99b31110491c6f77b0a154825866995fb124b73',
    size: 208521528,
    group: 'light-extra',
  },
  // Piper pt_BR faber (MIT voice data): the fallback when Kokoro is too slow on this computer.
  'light/rhasspy/piper-voices/pt/pt_BR/faber/medium/pt_BR-faber-medium.onnx': {
    url: 'https://huggingface.co/rhasspy/piper-voices/resolve/42301ec547bc2939386cf0ae9f9050ca05b1d3af/pt/pt_BR/faber/medium/pt_BR-faber-medium.onnx',
    sha256: '75e913eb463db0b6ac7ddf68d3e4c9ac19ace36dc3b710a81039b448352b8ffc',
    size: 63221984,
    group: 'light',
  },
  'light/rhasspy/piper-voices/pt/pt_BR/faber/medium/pt_BR-faber-medium.onnx.json': {
    url: 'https://huggingface.co/rhasspy/piper-voices/resolve/42301ec547bc2939386cf0ae9f9050ca05b1d3af/pt/pt_BR/faber/medium/pt_BR-faber-medium.onnx.json',
    sha256: '6b6801319e5a70aa4d75c63343515f55d1cd671ecd1ac511586bc16216812261',
    size: 6257,
    group: 'light',
  },

  // The native engine (gpu profile), all run by llama.cpp's llama-server (hub/engine.mjs).
  // Qwen3-TTS 1.7B Base (Apache-2.0): Ceci's voice, cloned from agent/ceci-voice.wav, streamed.
  // Converted with llama.cpp b12556 from Qwen/Qwen3-TTS-12Hz-1.7B-Base (revision
  // fd4b254389122332181a7c3db7f27e918eec64e3) and quantized to Q5_K_M: Q4 said 4 to 10 points fewer
  // English tech words right over 5 seeds. The owner heard it as clearly better than the 0.6B.
  'native/qwen3-tts-1.7b-base-q5_k_m.gguf': {
    url: `${LUKE_MODELS}/qwen3-tts-1.7b-base-q5_k_m.gguf`,
    sha256: '244e74cd46ba8c6aa4851723b667799ddb08b81839ce61b8bd0c8e247c7b6006',
    size: 1226118112,
    group: 'native',
  },
  // Its projector with the speech tokenizer's reference encoder: cloning from the reference clip AND
  // its transcript keeps Ceci's accent Brazilian; the public projector clones from the speaker
  // embedding only, which pulled her toward European Portuguese.
  'native/qwen3-tts-1.7b-base-mmproj-icl-q8_0.gguf': {
    url: `${LUKE_MODELS}/qwen3-tts-1.7b-base-mmproj-icl-q8_0.gguf`,
    sha256: 'd57d1a06a37e0d3f550ffec25977ac457fe0415b0885609a6c315a0e9f09f631',
    size: 632374944,
    group: 'native',
  },
  // Qwen3-ASR 0.6B (Apache-2.0): what the user said, ~120 ms per sentence on a mid-range GPU.
  // Quantized to Q6_K from ggml-org's BF16 (revision b98bf4381df3b400b929dcaff0dc83b6dafe221b): the
  // same tech words heard as Q8 (43 of 50) and the same word errors on 150 real pt-BR clips, with
  // ~300 MiB less video memory.
  'native/qwen3-asr-0.6b-q6_k.gguf': {
    url: `${LUKE_MODELS}/qwen3-asr-0.6b-q6_k.gguf`,
    sha256: 'dabec98fbedb9e9707c2d81bc7c1fbcb92a675ea1b23a63efaa01b067a77b7a1',
    size: 622729440,
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

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

const isAlive = pid => {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error.code === 'EPERM'
  }
}

async function isGood(entry, file) {
  if (sizeOf(file) !== entry.size || (await sha256Of(file)) !== entry.sha256) return false
  verified.add(file)
  return true
}

// The pid a lock file holds, or 0 when it is gone or unreadable.
const lockOwner = lock => {
  try {
    return Number(readFileSync(lock, 'utf8')) || 0
  } catch {
    return 0
  }
}

const lockAge = lock => {
  try {
    return Date.now() - statSync(lock).mtimeMs
  } catch {
    return 0
  }
}

// Removes the lock only while it still holds this pid: another process may have taken it over.
const releaseLock = (lock, pid) => {
  if (lockOwner(lock) === pid) rmSync(lock, { force: true })
}

// Another process can download the same file at the same time: the hub on a first call, and
// setup.mjs from the installer or /luke-voice setup. Both would write the same `.part`, and both
// downloads would fail their check. `${file}.lock` holds the writer's pid, and the writer touches it
// while it downloads (a heartbeat: a stalled network can leave its `.part` still for minutes before
// the download resumes). The other process waits for it (showing its progress), then uses the
// file. A lock is taken over only when its process is gone, or its heartbeat stopped for `staleMs`.
async function downloadLocked(entry, file, { request, onProgress, pollMs, staleMs }) {
  const lock = `${file}.lock`
  const part = `${file}.part`
  mkdirSync(dirname(file), { recursive: true })
  for (;;) {
    try {
      writeFileSync(lock, String(process.pid), { flag: 'wx' })
      break
    } catch (error) {
      if (error.code !== 'EEXIST') throw error
    }
    const owner = lockOwner(lock)
    if (!owner) {
      // Released meanwhile, or created and not written yet; an empty one a crash left goes once stale.
      if (lockAge(lock) > staleMs) rmSync(lock, { force: true })
      else if (existsSync(lock)) await sleep(Math.min(pollMs, 50))
      continue
    }
    if (owner === process.pid || !isAlive(owner) || lockAge(lock) > staleMs) {
      releaseLock(lock, owner)
      continue
    }
    let seen = sizeOf(part)
    while (lockOwner(lock) === owner && isAlive(owner) && lockAge(lock) <= staleMs) {
      await sleep(pollMs)
      const now = sizeOf(part)
      if (now !== seen) {
        seen = now
        if (now) onProgress?.(now, entry.size)
      }
    }
    if (await isGood(entry, file)) return file
  }
  const heartbeat = setInterval(() => {
    try {
      if (lockOwner(lock) === process.pid) utimesSync(lock, new Date(), new Date())
    } catch {
      // Gone meanwhile: the waiters see that.
    }
  }, Math.max(pollMs, Math.floor(staleMs / 4)))
  heartbeat.unref()
  try {
    // The other process may have finished just before this one took the lock.
    if (await isGood(entry, file)) return file
    rmSync(file, { force: true })
    return await download(entry, file, { request, onProgress })
  } finally {
    clearInterval(heartbeat)
    releaseLock(lock, process.pid)
  }
}

// A verified file at `file` for `entry` ({ url, sha256, size }), downloading it if needed.
export async function ensureFile(entry, file, { request = fetch, onProgress, pollMs = 1000, staleMs = 120_000 } = {}) {
  if (verified.has(file) && sizeOf(file) === entry.size) return file
  if (await isGood(entry, file)) return file
  if (!inFlight.has(file)) {
    inFlight.set(file, downloadLocked(entry, file, { request, onProgress, pollMs, staleMs }).finally(() => inFlight.delete(file)))
  }
  return inFlight.get(file)
}

// The local path of a verified model file, downloading it if needed. Null for an unknown path.
export async function ensureModel(path, { dir = modelsDir(), ...options } = {}) {
  // Own entries only: "__proto__" or "constructor" from a URL are not models.
  if (!Object.hasOwn(MODELS, path)) return null
  const entry = MODELS[path]
  return ensureFile(entry, join(dir, ...path.split('/')), options)
}

// Native model files the manifest no longer names (the 0.6B voice and the Q8 ears after 0.10.0),
// removed once the new ones are in: they are gigabytes nobody reads. Only the native folder is
// touched, and only GGUF files and their partial downloads. Returns the removed paths.
export function pruneModels({ dir = modelsDir() } = {}) {
  const folder = join(dir, 'native')
  if (!existsSync(folder)) return []
  const removed = []
  for (const name of readdirSync(folder)) {
    if (!/.gguf(.part|.lock)?$/.test(name) || MODELS[`native/${name}`]) continue
    try {
      rmSync(join(folder, name), { force: true })
      removed.push(`native/${name}`)
    } catch {
      // In use (an old server still running on Windows): removed on a later prepare.
    }
  }
  return removed
}

// Bytes still to download for these model paths: what is missing of each file (a cut download's
// .part counts as already there, since it resumes).
export function remainingBytes(paths, { dir = modelsDir() } = {}) {
  let bytes = 0
  for (const path of paths) {
    const entry = MODELS[path]
    if (!entry) continue
    const file = join(dir, ...path.split('/'))
    if (sizeOf(file) === entry.size) continue
    bytes += entry.size - Math.min(sizeOf(`${file}.part`), entry.size)
  }
  return bytes
}

// Free bytes on the disk that holds dir (or its nearest folder that exists); null when the system
// cannot say.
export async function freeBytes(dir, { stat = statfs } = {}) {
  let at = dir
  while (!existsSync(at) && dirname(at) !== at) at = dirname(at)
  try {
    const info = await stat(at)
    return Number(info.bavail) * Number(info.bsize)
  } catch {
    return null
  }
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
