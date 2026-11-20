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

// The local path of a verified model file, downloading it if needed. Null for an unknown path.
export async function ensureModel(path, { dir = modelsDir(), request = fetch, onProgress } = {}) {
  const entry = MODELS[path]
  if (!entry) return null
  const file = join(dir, ...path.split('/'))
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
