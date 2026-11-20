// Third-party browser code for the local voice, pinned by version and sha384.
// The hub downloads each file once from jsDelivr, checks its hash, keeps it under
// ~/.luke-voice/vendor and serves it from 127.0.0.1, so the window never runs remote code
// that was not verified. Model weights are data, not code: the window fetches them from
// Hugging Face and the browser caches them.
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

import { stateDir } from './paths.mjs'

const TRANSFORMERS = 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.8.1/dist'
const ESPEAK = 'https://cdn.jsdelivr.net/npm/espeak-phonemizer@0.2.0/dist'

// Served path (under /vendor/) -> source URL and integrity.
export const VENDOR = {
  'transformers/transformers.min.js': { url: `${TRANSFORMERS}/transformers.min.js`, sha384: 'sOua6i337lNLWtuIG44PBf5JXIvhoicFClCcI4XHDe/eHW3dwhQ3Y6t6wQjfRrkT' },
  'transformers/ort-wasm-simd-threaded.jsep.mjs': { url: `${TRANSFORMERS}/ort-wasm-simd-threaded.jsep.mjs`, sha384: '7GJqH5vc83Yt7VHwrMXTM8bNCrt/e/8eCtok8zlB2u5dwqmhzSakzCkQWrfYGRN4' },
  'transformers/ort-wasm-simd-threaded.jsep.wasm': { url: `${TRANSFORMERS}/ort-wasm-simd-threaded.jsep.wasm`, sha384: 'u/bDsx39c+wt0LbHmOCydxt4fyiig3118hQgOTfOvrfkgScM4hRo2IwTtlxyoI02' },
  'espeak/dist/espeak.mjs': { url: `${ESPEAK}/espeak.mjs`, sha384: '9mFo4AxtuW2zg0K6d8MDGuPwvKkcnQ+jaz+BfFFmA91Fx0invCjCYBY/uI0aXxsz' },
  'espeak/dist/constants.mjs': { url: `${ESPEAK}/constants.mjs`, sha384: 'YlHorzeMKVJSmFa757+mBfgS1m3twWsqFFoERP8M5+wKmvIPDAMRwML4R/VrcmgM' },
  'espeak/dist/version.mjs': { url: `${ESPEAK}/version.mjs`, sha384: 'RHxZI3yLU2zKL0va808bdHQCyQEoWg3T8MocYu8w7euWUyawxEfGOnekhkSRMA9/' },
  'espeak/dist/wasm/espeak-ng.mjs': { url: `${ESPEAK}/wasm/espeak-ng.mjs`, sha384: 'wGxs6Lejz24uYXGUV9aEq/bzXK3oM5lNj83VPdXaA1+FNkr8McW+3Tlot4choFiF' },
  'espeak/dist/wasm/espeak-ng.wasm': { url: `${ESPEAK}/wasm/espeak-ng.wasm`, sha384: '/obVIqMy27Sm8OUbWNOfGxX8IuEcnR3HcCcMfiudPl2So4UdPjKURUWzdyrlT0H7' },
  'espeak/dist/data/manifest.json': { url: `${ESPEAK}/data/manifest.json`, sha384: 'AVsS9zBPndrLda1pyS+JfHDHIJIEZaI+1kw90ENXZFDPiG6ezMARnDG/jF60zBBS' },
  'espeak/dist/data/data.data': { url: `${ESPEAK}/data/data.data`, sha384: 'UQNDE+2HMgdfD7ZAWW/NBFTcY5beaw7EtaA8VBx6soCelw6/zwmWGEoclj826npD' },
}

const TYPES = { '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.wasm': 'application/wasm', '.json': 'application/json', '.data': 'application/octet-stream' }

export const contentType = path => TYPES[path.slice(path.lastIndexOf('.'))] ?? 'application/octet-stream'

const sha384 = bytes => createHash('sha384').update(bytes).digest('base64')

// One download per file at a time, shared by every request that asks for it meanwhile.
const inFlight = new Map()

// The verified bytes of a vendored file, downloading it on first use. Null for an unknown path.
export async function vendorFile(path, { dir = join(stateDir(), 'vendor'), request = fetch } = {}) {
  const entry = VENDOR[path]
  if (!entry) return null
  const file = join(dir, ...path.split('/'))
  if (existsSync(file)) {
    const bytes = readFileSync(file)
    if (sha384(bytes) === entry.sha384) return bytes
  }
  if (!inFlight.has(file)) {
    const job = (async () => {
      const res = await request(entry.url)
      if (!res.ok) throw new Error(`Download failed (${res.status}): ${entry.url}`)
      const bytes = Buffer.from(await res.arrayBuffer())
      if (sha384(bytes) !== entry.sha384) throw new Error(`Integrity check failed: ${entry.url}`)
      mkdirSync(dirname(file), { recursive: true })
      writeFileSync(`${file}.part`, bytes)
      renameSync(`${file}.part`, file)
      return bytes
    })().finally(() => inFlight.delete(file))
    inFlight.set(file, job)
  }
  return inFlight.get(file)
}
