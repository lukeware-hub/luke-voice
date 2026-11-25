// The native engine (gpu profile). llama.cpp's llama-server runs three local servers: Ceci's voice
// (Qwen3-TTS 1.7B, streamed, cloned from agent/ceci-voice.wav), her ears (Qwen3-ASR 0.6B) and the
// instant router of the hybrid brain (Qwen3.5 0.8B, on the CPU). The binaries are llama.cpp's
// official release builds (Vulkan on Windows and Linux, Metal on macOS), pinned by sha256; the
// models are in hub/models.mjs. No Python, no PyTorch.
import { execFile, execFileSync, spawn as nodeSpawn } from 'node:child_process'
import { createWriteStream, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { availableParallelism } from 'node:os'
import { isAbsolute, join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

import { MODELS, ensureFile, ensureModel, modelsDir, pruneModels } from './models.mjs'
import { stateDir } from './paths.mjs'
import { routerBody } from './router.mjs'

export const LLAMA_BUILD = 'b12556'
const RELEASE = `https://github.com/ggml-org/llama.cpp/releases/download/${LLAMA_BUILD}`

// The llama.cpp build per platform: where llama-server is inside the archive.
export const BINARIES = {
  'win32-x64': {
    url: `${RELEASE}/llama-${LLAMA_BUILD}-bin-win-vulkan-x64.zip`,
    sha256: '73f3346fbbad14db8f5a5b35c4e9dbae7debf306309bfc77aca4a17096cb2f93',
    size: 38690012,
    exe: 'llama-server.exe',
  },
  'darwin-arm64': {
    url: `${RELEASE}/llama-${LLAMA_BUILD}-bin-macos-arm64.tar.gz`,
    sha256: 'eb92254d5ada74c6753bd6ef0d23f498ffe2872b7222043eb48743abcaac8333',
    size: 16449908,
    exe: `llama-${LLAMA_BUILD}/llama-server`,
  },
  'linux-x64': {
    url: `${RELEASE}/llama-${LLAMA_BUILD}-bin-ubuntu-vulkan-x64.tar.gz`,
    sha256: '75ea69b93eea3abfb9539cc0bb21701cfa1f7f791e6fc30b290eab4d5dbcee4f',
    size: 36721000,
    exe: `llama-${LLAMA_BUILD}/llama-server`,
  },
}

// The three servers: their models and llama-server flags. The voice and the ears use the GPU;
// the router stays on the CPU, so it never competes with them for video memory.
// Flags every server gets, none of which changes what it says or hears (same audio, transcripts and
// routes on a fixed workload): no busy-waiting for work (--poll 0) and no prompt cache in RAM
// (-cram 0). The voice and the ears also run on 2 CPU threads (they run on the GPU) and do not keep
// their model files mapped in RAM once loaded (-lm none). Measured on the whole engine: RAM in use
// 5.0 to 3.2 GB, CPU time 73 to 52 s on the same work, video memory 5.85 to 5.41 GB (with the Q6
// ears). The router keeps its file mapped: on the CPU, a copy would cost more RAM.
const LEAN = ['--poll', '0', '-cram', '0']
const ON_GPU = [...LEAN, '-t', '2', '-lm', 'none']
export const SERVICES = {
  tts: {
    models: ['native/qwen3-tts-1.7b-base-q5_k_m.gguf', 'native/qwen3-tts-1.7b-base-mmproj-icl-q8_0.gguf'],
    // One slot: every request reuses the cached reference voice, so the first audio comes in ~250 ms.
    // A 1024 context and 256 batch fit the reference plus the longest chunk (220 characters).
    args: ([model, mmproj]) => ['-m', model, '-mm', mmproj, '-ngl', '99', '-c', '1024', '-ub', '256', '-np', '1', ...ON_GPU],
  },
  asr: {
    models: ['native/qwen3-asr-0.6b-q6_k.gguf', 'native/qwen3-asr-0.6b-mmproj-q8_0.gguf'],
    // 1536 context and 256 batch: the same transcripts as 2048, ~270 MiB less video memory.
    // Lean (a GPU with room for the voice only): the ears run on the CPU, model and projector, so
    // the GPU keeps Ceci's original voice. Measured: ~640 ms a sentence on 8 threads, ~85 ms on the GPU.
    args: ([model, mmproj], { lean = false } = {}) =>
      lean
        ? ['-m', model, '-mm', mmproj, '-ngl', '0', '--no-mmproj-offload', '-c', '1536', '-ub', '256', '-np', '1', '-t', String(cpuThreads()), ...LEAN]
        : ['-m', model, '-mm', mmproj, '-ngl', '99', '-c', '1536', '-ub', '256', '-np', '1', ...ON_GPU],
  },
  router: {
    models: ['native/qwen3.5-0.8b-q4_k_m.gguf'],
    // The few-shot prompt and a 300-character utterance fit in 2048.
    // Two CPU threads: llama.cpp would take every core for a 0.8B model and 16 tokens, starving the
    // window's audio while Ceci speaks.
    args: ([model]) => ['-m', model, '-ngl', '0', '-c', '2048', '-np', '1', '--jinja', '-t', '2', ...LEAN],
  },
}

// How Ceci's voice is sampled. With the reference clip in agent/ceci-voice.wav (a real Brazilian
// speaker, picked by the owner by ear). At 0.75 her pitch barely moved (pitch spread 2.9 of 10 on
// the naturalness panel, anchored on real pt-BR recordings) and the owner heard her as robotic;
// 0.9 gives her melody back (6.2 of 10, panel 7.6 to 8.8). The fixed seed makes the same sentence
// always sound the same.
export const VOICE_SETTINGS = { temperature: 0.9, top_p: 0.9, seed: 7 }

// What Qwen3-ASR is told, so English tech words, Ceci's name and session names come out right.
// The same prompt warms the engine up, so the first real transcription is not a cold one. The model
// names and Lukeware took word errors from 30 to 27 of 129 on 20 recorded turns ("Raiko" became
// "Haiku", "Apus" became "Opus"), with noise and silence still heard as nothing.
export const ASR_GLOSSARY = 'Conversa em português do Brasil com a Ceci, uma assistente de programação. Termos comuns: API, commit, branch, main, deploy, build, bug, pull request, GitHub, Claude, Ceci, lint, TypeScript, token, login, checkout, README, Opus, Sonnet, Haiku, Anthropic, Lukeware, Diego, push, merge, PR, teste, repositório, subagente, npm, luke-voice.'

// Audio frames allowed for a text (12.5 per second; ~14 characters per second in pt-BR), so a
// rare generation loop stops after a few seconds instead of babbling for 40. Digits and acronyms
// are said much longer than they are written ("2026" is "dois mil e vinte e seis", "API" is
// "a pê i"), so each gets more room, or the end of a line full of them would be cut off.
export const maxFrames = text => {
  const t = String(text)
  const digits = t.match(/\d/g)?.length ?? 0
  const capitals = (t.match(/\b[A-Z]{2,}\b/g) ?? []).join('').length
  return Math.ceil(t.length * 1.5) + 25 + digits * 5 + capitals * 3
}

// Below this much video memory the voice and the ears would not fit together on the GPU.
export const MIN_VRAM_MIB = 6000
// Ceci's voice alone takes ~2.8 GB of video memory (Vulkan, RTX 3060 Ti). From this much, with room
// left for the desktop, the gpu profile still runs her original voice, lean: the ears move to the
// CPU. A Mac with 8 GB gives Metal ~5.3 GB; a 4 GB card reports about 4 GB. Below it: the light voice.
export const LEAN_VRAM_MIB = 3800
// CPU threads for the lean ears: most cores, leaving two for the rest of the machine.
export const cpuThreads = (cores = availableParallelism()) => Math.max(2, Math.min(8, cores - 2))

export const engineDir = () => join(stateDir(), 'engine')
const profileFile = dir => join(dir, 'profile.json')

// An Apple silicon Mac running an Intel Node.js (a terminal under Rosetta, or an x64 Node someone
// installed) reports x64, and darwin-x64 has no build: Ceci would fall to the light voice. The arm64
// build runs natively when spawned, so a translated process counts as arm64.
export function isRosetta() {
  if (process.platform !== 'darwin') return false
  try {
    return execFileSync('sysctl', ['-n', 'sysctl.proc_translated'], { encoding: 'utf8', timeout: 2000, stdio: ['ignore', 'pipe', 'ignore'] }).trim() === '1'
  } catch {
    return false
  }
}

export function platformKey(platform = process.platform, arch = process.arch, { isTranslated = isRosetta } = {}) {
  const real = platform === 'darwin' && arch === 'x64' && isTranslated() ? 'arm64' : arch
  const key = `${platform}-${real}`
  return BINARIES[key] ? key : null
}

// `llama-server --list-devices` lines such as "  Vulkan0: NVIDIA GeForce RTX 3060 Ti (8238 MiB, 7469 MiB free)".
export function parseDevices(text) {
  const devices = []
  for (const line of String(text ?? '').split('\n')) {
    const m = line.match(/^\s*(\w+?\d+):\s*(.+?)\s*\((\d+)\s*MiB/)
    if (m) devices.push({ id: m[1], name: m[2], mib: Number(m[3]) })
  }
  return devices
}

// Devices that report memory but would not keep up with the natural voice: a CPU posing as a
// Vulkan device (Mesa's llvmpipe on a Linux box without GPU drivers reports the system RAM), and
// integrated graphics, whose "memory" is shared RAM: Intel's UHD, Iris and the Arc of Meteor,
// Lunar and Arrow Lake ("Arc(TM) Graphics", "Arc(TM) 140V"; a discrete Arc names its A or B
// model), and AMD's APUs ("Radeon(TM) Graphics", "Radeon 780M", "Radeon Vega 8"; a discrete
// Radeon is an RX, PRO or VII).
const WEAK_DEVICE = /llvmpipe|lavapipe|swiftshader|microsoft basic render|intel.*\b(uhd|hd graphics|iris)\b|intel.*\barc(\(tm\))?\s+(graphics|\d{3}[vt]\b)|radeon(\(tm\))?\s+(graphics|\d{3}m\b|vega\s+\d+\b)/i

// gpu when this platform has a build and a dedicated device with enough memory (lean, with the ears
// on the CPU, when it has room for the voice only); light otherwise.
// LUKE_VOICE_PROFILE=gpu|light overrides the choice.
export function pickProfile({ key, devices = [], override = '' }) {
  if (override === 'light') return { profile: 'light', reason: 'escolhido' }
  if (!key) return { profile: 'light', reason: 'sem versão nativa para este sistema' }
  const usable = devices.filter(d => !WEAK_DEVICE.test(d.name))
  const best = [...usable].sort((a, b) => b.mib - a.mib)[0]
  if (override === 'gpu') return { profile: 'gpu', reason: 'escolhido', device: (best ?? devices[0])?.name ?? null }
  if (!best && devices.length) return { profile: 'light', reason: `só placa de vídeo integrada ou por software (${devices[0].name})`, device: devices[0].name }
  if (!best) return { profile: 'light', reason: 'nenhuma placa de vídeo encontrada' }
  if (best.mib < LEAN_VRAM_MIB) return { profile: 'light', reason: `placa de vídeo com ${best.mib} MiB (precisa de ${LEAN_VRAM_MIB})`, device: best.name }
  if (best.mib < MIN_VRAM_MIB) return { profile: 'gpu', lean: true, reason: `${best.name}, ${best.mib} MiB: a voz na placa de vídeo e os ouvidos no processador`, device: best.name }
  return { profile: 'gpu', reason: `${best.name}, ${best.mib} MiB`, device: best.name }
}

const runFile = (file, args, { timeoutMs = 20_000 } = {}) =>
  new Promise(resolve => {
    execFile(file, args, { timeout: timeoutMs, windowsHide: true }, (error, stdout, stderr) =>
      resolve({ ok: !error, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') }),
    )
  })

// The system tar: bsdtar on Windows 10+ reads zip; GNU tar from Git Bash does not.
const tarCommand = () => (process.platform === 'win32' ? join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe') : 'tar')

// The llama.cpp build for this platform, downloaded, checked and unpacked once. Returns llama-server's path.
export async function ensureBinaries({ dir = engineDir(), key = platformKey(), request, onProgress, run = runFile } = {}) {
  const entry = BINARIES[key]
  if (!entry) throw new Error(`No native engine for ${process.platform}-${process.arch}.`)
  const target = join(dir, LLAMA_BUILD)
  const exe = join(target, ...entry.exe.split('/'))
  const marker = join(target, '.unpacked')
  if (existsSync(marker) && existsSync(exe)) return exe
  const archive = join(dir, 'downloads', entry.url.slice(entry.url.lastIndexOf('/') + 1))
  await ensureFile(entry, archive, { request, onProgress })
  mkdirSync(target, { recursive: true })
  const out = await run(tarCommand(), ['-xf', archive, '-C', target], { timeoutMs: 120_000 })
  if (!out.ok || !existsSync(exe)) throw new Error(`Could not unpack the voice engine: ${out.stderr.trim() || 'llama-server is missing'}`)
  writeFileSync(marker, LLAMA_BUILD)
  return exe
}

export async function listDevices(exe, run = runFile) {
  const out = await run(exe, ['--list-devices'])
  return parseDevices(`${out.stdout}\n${out.stderr}`)
}

// The hub reads the profile on every request; setup.mjs rewrites it from another process, so the
// file is parsed again only when its mtime or size changes.
const profiles = new Map() // file -> { mtimeMs, size, profile }
export function readProfile(dir = engineDir()) {
  const file = profileFile(dir)
  try {
    const { mtimeMs, size } = statSync(file)
    const cached = profiles.get(file)
    if (cached?.mtimeMs === mtimeMs && cached.size === size) return cached.profile
    const profile = JSON.parse(readFileSync(file, 'utf8'))
    profiles.set(file, { mtimeMs, size, profile })
    return profile
  } catch {
    return null
  }
}

// The model groups each profile downloads at install time. The light profile's Kokoro is fp32 for
// a browser with WebGPU (a machine with a GPU), fp16 for the CPU; the other one, if ever needed,
// is downloaded on first use.
export function profileGroups(profile, devices = []) {
  if (profile === 'gpu') return ['turn', 'native']
  return ['turn', 'light', devices.length ? 'light-webgpu' : 'light-cpu']
}

const groupPaths = groups => Object.keys(MODELS).filter(path => groups.includes(MODELS[path].group))
export const groupBytes = groups => groupPaths(groups).reduce((n, p) => n + MODELS[p].size, 0)
export const nativeBytes = () => groupBytes(['native'])

// Whether every model file of a saved profile is on disk (by size; the hash was checked on download).
export function profileReady(profile, { models = modelsDir() } = {}) {
  if (profile?.profile === 'gpu' && !(profile.exe && existsSync(profile.exe))) return false
  // An update that moves to another llama.cpp build must not run the old binary with the new
  // models: the profile is prepared again, which downloads the build it names.
  if (profile?.profile === 'gpu' && profile.build !== LLAMA_BUILD) return false
  return groupPaths(profileGroups(profile?.profile, profile?.devices ?? [])).every(path => {
    const file = join(models, ...path.split('/'))
    return existsSync(file) && statSync(file).size === MODELS[path].size
  })
}

// Model files downloaded and checked, up to `parallel` at a time (one file at a time left most of
// the bandwidth unused on a fast line). Each file keeps its own lock, resume and sha256 check
// (models.mjs). onProgress(loaded, total) counts bytes over all of them. If one fails, no new one
// starts, the ones under way finish (their files stay good for the next try), and the first error
// is thrown.
export async function downloadModels(paths, { dir = modelsDir(), request, ensure = ensureModel, parallel = 3, onProgress = () => {} } = {}) {
  const total = paths.reduce((n, path) => n + MODELS[path].size, 0)
  const loaded = new Map()
  const report = () => onProgress([...loaded.values()].reduce((a, b) => a + b, 0), total)
  const waiting = [...paths]
  let failure = null
  const worker = async () => {
    while (waiting.length && !failure) {
      const path = waiting.shift()
      const size = MODELS[path].size
      try {
        await ensure(path, {
          dir,
          request,
          onProgress: bytes => {
            loaded.set(path, Math.min(bytes, size))
            report()
          },
        })
        loaded.set(path, size)
        report()
      } catch (error) {
        failure ??= error
      }
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, Math.min(parallel, paths.length)) }, worker))
  if (failure) throw failure
  return total
}

// After a prepare: llama.cpp builds and archives nobody runs any more (~40 MB each, one per update
// that moved the build). Kept: this build, and the one the previous profile ran (a hub may still
// be running it until it restarts). A build's archive goes once the build is unpacked; an archive
// whose download is locked by another process stays. Anything in use (Windows) stays for a later
// prepare. Returns the removed names.
export function pruneEngine({ dir = engineDir(), keep = [] } = {}) {
  const kept = new Set([LLAMA_BUILD, ...keep.filter(Boolean)])
  const removed = []
  const remove = (path, name) => {
    try {
      rmSync(path, { recursive: true, force: true })
      removed.push(name)
    } catch {
      // In use: removed on a later prepare.
    }
  }
  const list = folder => {
    try {
      return readdirSync(folder, { withFileTypes: true })
    } catch {
      return []
    }
  }
  for (const entry of list(dir)) {
    if (entry.isDirectory() && /^b\d+$/.test(entry.name) && !kept.has(entry.name)) remove(join(dir, entry.name), entry.name)
  }
  const downloads = join(dir, 'downloads')
  const names = list(downloads).map(entry => entry.name)
  for (const name of names) {
    const archive = name.match(/^(llama-(b\d+)-bin-.+?\.(?:zip|tar\.gz))(\.part)?$/)
    if (!archive || names.includes(`${archive[1]}.lock`)) continue
    const isCurrent = archive[2] === LLAMA_BUILD
    if (isCurrent && !existsSync(join(dir, LLAMA_BUILD, '.unpacked'))) continue
    remove(join(downloads, name), `downloads/${name}`)
  }
  return removed
}

// The build folder a profile runs: its "build", or the folder its exe is in under the engine folder.
function profileBuild(profile, dir) {
  if (profile?.build) return profile.build
  if (!profile?.exe) return null
  const inside = relative(dir, profile.exe)
  return inside && !inside.startsWith('..') && !isAbsolute(inside) ? inside.split(sep)[0] : null
}

// Everything a profile needs, downloaded and checked: the build and the profile decision, then the
// models of that profile. onProgress(loaded, total, label) reports bytes over all model files.
// Returns the profile. `devices` already listed and a `reason` come with a fallback to the light
// profile (setup.mjs, when the natural voice fails its test), with `failed`: the profile then
// remembers it (naturalFailed), and every later preparation keeps the light voice, whoever runs it
// (the hub, after an update, while setup still downloads the light models), until `retryNatural`
// (setup.mjs, which tests the natural voice again) or LUKE_VOICE_PROFILE=gpu asks for it.
// checkSpace({ paths, dir }) runs once the profile is known, before its models are downloaded
// (setup.mjs fails early on a full disk).
export async function prepareEngine({ dir = engineDir(), models = modelsDir(), request, onProgress = () => {}, run = runFile, override = process.env.LUKE_VOICE_PROFILE ?? '', devices: known = null, reason = '', failed = false, retryNatural = false, checkSpace = null, key = platformKey(), ensure = ensureModel, parallel = 3 } = {}) {
  const previous = readProfile(dir)
  const keepLight = !failed && !retryNatural && override !== 'gpu' && previous?.naturalFailed === true
  const wanted = keepLight ? 'light' : override
  let exe = null
  // The devices listed before: the light voice's models depend on them (WebGPU or the CPU).
  let devices = known ?? (keepLight ? (previous.devices ?? []) : [])
  if (key && wanted !== 'light') {
    exe = await ensureBinaries({ dir, key, request, run, onProgress: (loaded, total) => onProgress(loaded, total, 'llama.cpp') })
    devices = await listDevices(exe, run)
  }
  const choice = pickProfile({ key, devices, override: wanted })
  const why = reason || (keepLight ? previous.reason : '')
  const profile = { ...choice, ...(why ? { reason: why } : {}), ...(failed || keepLight ? { naturalFailed: true } : {}), build: LLAMA_BUILD, exe, devices, at: new Date().toISOString() }
  mkdirSync(dir, { recursive: true })
  writeFileSync(profileFile(dir), JSON.stringify(profile, null, 2))
  const groups = profileGroups(profile.profile, devices)
  await checkSpace?.({ paths: groupPaths(groups), dir: models })
  const total = await downloadModels(groupPaths(groups), { dir: models, request, ensure, parallel, onProgress: (loaded, all) => onProgress(loaded, all, 'modelos') })
  onProgress(total, total, 'modelos')
  if (profile.profile === 'gpu') pruneModels({ dir: models })
  pruneEngine({ dir, keep: [profileBuild(previous, dir)] })
  return profile
}

const freePort = () =>
  new Promise((resolve, reject) => {
    const probe = createServer()
    probe.once('error', reject)
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address()
      probe.close(() => resolve(port))
    })
  })

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

// Runs the servers and keeps them up. `command` replaces llama-server in tests.
// The guard process (hub/guard.mjs): stops the servers when the hub is killed. One per hub, started
// with the first server. It must not keep the hub alive by itself, so its handles are unref'd.
const GUARD = fileURLToPath(new URL('./guard.mjs', import.meta.url))
function startGuard(log) {
  try {
    const child = nodeSpawn(process.execPath, [GUARD], { stdio: ['pipe', 'ignore', 'ignore'], windowsHide: true })
    child.on('error', () => {})
    child.stdin.on('error', () => {})
    child.unref()
    child.stdin.unref?.()
    return {
      add: pid => child.stdin.writable && child.stdin.write(`+${pid}
`),
      remove: pid => child.stdin.writable && child.stdin.write(`-${pid}
`),
    }
  } catch (error) {
    log(`engine guard: ${error.message}`)
    return { add() {}, remove() {} }
  }
}

// A server's log past this size is moved to <name>.old.log when the server starts (replacing the
// previous one), so the logs never grow without bound (~0.7 MB a day in use).
export const MAX_LOG_BYTES = 5 * 1024 * 1024

export function rotateLog(file, maxBytes = MAX_LOG_BYTES) {
  try {
    if (statSync(file).size <= maxBytes) return false
    renameSync(file, file.replace(/\.log$/, '.old.log'))
    return true
  } catch {
    // No log yet, or it is still open by a server that is exiting (Windows): append to it this time.
    return false
  }
}

export function createEngine({ dir = engineDir(), models = modelsDir(), spawn = nodeSpawn, request = fetch, log = () => {}, command = null, readyTimeoutMs = 90_000, latePollMs = 2000, guard = null, maxLogBytes = MAX_LOG_BYTES } = {}) {
  const services = new Map() // name -> { port, child, isReady, restarts: number[], isStopping, hasExited, firstWait }
  let isStopped = false
  let guarded = guard
  // How the servers run, from the profile: { lean } puts the ears on the CPU. Kept for restarts.
  let runAs = { lean: false }

  // The service is still the one in the map, and nobody asked it to stop.
  const isCurrent = (name, service) => services.get(name) === service && !service.isStopping && !isStopped
  // A child that could not be spawned at all has no exit code: hasExited covers it.
  const isRunning = service => !service.hasExited && service.child.exitCode === null && service.child.signalCode === null

  // Polls this service's port until it answers. Stops as soon as its server is gone (crashed or
  // never ran) or another server replaced it, instead of polling a dead port for the whole timeout.
  async function waitReady(name, service, timeoutMs = readyTimeoutMs) {
    const until = Date.now() + timeoutMs
    while (Date.now() < until) {
      if (!isCurrent(name, service) || !isRunning(service)) return false
      try {
        const res = await request(`http://127.0.0.1:${service.port}/health`)
        if (res.ok) return true
      } catch {
        // not listening yet
      }
      await sleep(300)
    }
    return false
  }

  async function startOne(name, exe) {
    const spec = SERVICES[name]
    const files = spec.models.map(path => join(models, ...path.split('/')))
    const port = await freePort()
    const base = command ?? [exe]
    const args = [...base.slice(1), ...spec.args(files, runAs), '--host', '127.0.0.1', '--port', String(port)]
    mkdirSync(dir, { recursive: true })
    rotateLog(join(dir, `${name}.log`), maxLogBytes)
    const out = createWriteStream(join(dir, `${name}.log`), { flags: 'a' })
    // Never two servers for one service: one left over (a start that timed out) is stopped first,
    // or it would keep its GPU memory with nothing tracking it.
    const previous = services.get(name)
    if (previous) {
      previous.isStopping = true
      previous.child.kill()
    }
    const child = spawn(base[0], args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
    child.stdout?.pipe(out)
    child.stderr?.pipe(out)
    guarded ??= startGuard(log)
    if (child.pid) guarded.add(child.pid)
    child.on('exit', () => child.pid && guarded.remove(child.pid))
    const service = { port, child, isReady: false, restarts: previous?.restarts ?? [], isStopping: false, hasExited: false, firstWait: null }
    services.set(name, service)
    const onGone = code => {
      // A failed spawn may be followed by an exit event: count it once.
      if (service.hasExited) return
      service.hasExited = true
      service.isReady = false
      if (service.isStopping || isStopped) return
      // Crashed: start it again, unless it keeps crashing (5 times in 5 minutes).
      const now = Date.now()
      service.restarts = [...service.restarts.filter(t => now - t < 300_000), now]
      log(`engine ${name} exited (${code}); ${service.restarts.length < 5 ? 'restarting' : 'giving up'}`)
      if (service.restarts.length < 5) {
        setTimeout(() => {
          // Stopped (setup, hub exit) or replaced during the wait: no new server.
          if (isCurrent(name, service)) void startOne(name, exe).catch(() => {})
        }, 1000)
      }
    }
    child.on('exit', onGone)
    // The exe is missing or cannot run (ENOENT, EACCES: an antivirus quarantine): without this
    // listener the error would crash the whole hub. It counts as a crash, with the same limit.
    child.on('error', error => {
      log(`engine ${name} could not run: ${error.message}`)
      onGone(error.code)
    })
    service.firstWait = waitReady(name, service)
    service.isReady = await service.firstWait
    log(`engine ${name} ${service.isReady ? `ready on ${port}` : 'did not become ready'}`)
    if (!service.isReady) void waitLate(name, service)
    return service.isReady
  }

  // A server slower than the timeout (a cold disk, a first shader compile) is still running: keep
  // checking, and use it once it answers, instead of marking it down for the life of the hub.
  async function waitLate(name, service) {
    while (isCurrent(name, service) && isRunning(service)) {
      if (await waitReady(name, service, latePollMs)) {
        if (!isCurrent(name, service)) return
        service.isReady = true
        log(`engine ${name} ready on ${service.port} (late)`)
        return
      }
    }
  }

  return {
    // Starts the servers that have their files, in parallel. Resolves to { name: isReady }.
    // lean (from the profile): the ears on the CPU, for a GPU with room for the voice only.
    async start(names = Object.keys(SERVICES), { exe, lean = false } = {}) {
      isStopped = false
      runAs = { lean: Boolean(lean) }
      const result = {}
      await Promise.all(
        names.map(async name => {
          const current = services.get(name)
          if (current?.isReady) return (result[name] = true)
          // Already starting, or late but running: wait for it, do not start a second one.
          if (current && !current.isStopping && isRunning(current) && current.firstWait) return (result[name] = await current.firstWait)
          const ready = SERVICES[name].models.every(path => existsSync(join(models, ...path.split('/'))))
          result[name] = ready ? await startOne(name, exe).catch(error => (log(`engine ${name}: ${error.message}`), false)) : false
        }),
      )
      return result
    },
    // The first request of each model compiles its GPU shaders (~10 s): pay it at start, not on
    // the user's first words. Errors are ignored; the real request will say what is wrong.
    async warm({ speakerRefB64 = '', speakerRefText = '' } = {}) {
      const silence = new Uint8Array(44 + 16_000 * 2)
      const view = new DataView(silence.buffer)
      ;[...'RIFF'].forEach((c, i) => view.setUint8(i, c.charCodeAt(0)))
      view.setUint32(4, 36 + 16_000 * 2, true)
      ;[...'WAVEfmt '].forEach((c, i) => view.setUint8(8 + i, c.charCodeAt(0)))
      view.setUint32(16, 16, true)
      view.setUint16(20, 1, true)
      view.setUint16(22, 1, true)
      view.setUint32(24, 16_000, true)
      view.setUint32(28, 32_000, true)
      view.setUint16(32, 2, true)
      view.setUint16(34, 16, true)
      ;[...'data'].forEach((c, i) => view.setUint8(36 + i, c.charCodeAt(0)))
      view.setUint32(40, 16_000 * 2, true)
      const jobs = []
      const asr = this.url('asr')
      if (asr) {
        const form = new FormData()
        form.append('file', new Blob([silence], { type: 'audio/wav' }), 'warm.wav')
        form.append('model', 'qwen3-asr')
        form.append('language', 'pt')
        form.append('prompt', ASR_GLOSSARY)
        jobs.push(request(`${asr}/v1/audio/transcriptions`, { method: 'POST', body: form }).then(r => r.arrayBuffer()))
      }
      const tts = this.url('tts')
      if (tts) {
        const body = JSON.stringify({ input: 'Oi, tudo bem?', lang: 'pt', response_format: 'wav', ...VOICE_SETTINGS, ...(speakerRefB64 ? { speaker_ref_b64: speakerRefB64, speaker_ref_text: speakerRefText } : {}) })
        jobs.push(request(`${tts}/v1/audio/speech`, { method: 'POST', headers: { 'content-type': 'application/json' }, body }).then(r => r.arrayBuffer()))
      }
      const router = this.url('router')
      if (router) {
        // The router's whole prompt, so its long prefix is in the cache before the first utterance.
        const body = JSON.stringify(routerBody('oi'))
        jobs.push(request(`${router}/v1/chat/completions`, { method: 'POST', headers: { 'content-type': 'application/json' }, body }).then(r => r.arrayBuffer()))
      }
      const started = Date.now()
      await Promise.allSettled(jobs)
      log(`engine warmed up in ${Date.now() - started} ms`)
    },
    stop() {
      isStopped = true
      for (const service of services.values()) {
        service.isStopping = true
        service.child.kill()
      }
      services.clear()
    },
    url(name) {
      const service = services.get(name)
      return service?.isReady ? `http://127.0.0.1:${service.port}` : null
    },
    status() {
      return Object.fromEntries(Object.keys(SERVICES).map(name => [name, Boolean(services.get(name)?.isReady)]))
    },
  }
}
