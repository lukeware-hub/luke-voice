// The native engine (gpu profile). llama.cpp's llama-server runs three local servers: Ceci's voice
// (Qwen3-TTS 1.7B, streamed, cloned from agent/ceci-voice.wav), her ears (Qwen3-ASR 0.6B) and the
// instant router of the hybrid brain (Qwen3.5 0.8B, on the CPU). The binaries are llama.cpp's
// official release builds (Vulkan on Windows and Linux, Metal on macOS), pinned by sha256; the
// models are in hub/models.mjs. No Python, no PyTorch.
import { execFile, execFileSync, spawn as nodeSpawn } from 'node:child_process'
import { createWriteStream, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { join } from 'node:path'
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
    args: ([model, mmproj]) => ['-m', model, '-mm', mmproj, '-ngl', '99', '-c', '1536', '-ub', '256', '-np', '1', ...ON_GPU],
  },
  router: {
    models: ['native/qwen3.5-0.8b-q4_k_m.gguf'],
    // The few-shot prompt and a 300-character utterance fit in 2048.
    args: ([model]) => ['-m', model, '-ngl', '0', '-c', '2048', '-np', '1', '--jinja', ...LEAN],
  },
}

// How Ceci's voice is sampled. With the reference clip in agent/ceci-voice.wav (a real Brazilian
// speaker, picked by the owner by ear). At 0.75 her pitch barely moved (pitch spread 2.9 of 10 on
// the naturalness panel, anchored on real pt-BR recordings) and the owner heard her as robotic;
// 0.9 gives her melody back (6.2 of 10, panel 7.6 to 8.8). The fixed seed makes the same sentence
// always sound the same.
export const VOICE_SETTINGS = { temperature: 0.9, top_p: 0.9, seed: 7 }

// What Qwen3-ASR is told, so English tech words, Ceci's name and session names come out right.
// The same prompt warms the engine up, so the first real transcription is not a cold one.
export const ASR_GLOSSARY = 'Conversa em português do Brasil com a Ceci, uma assistente de programação. Termos comuns: API, commit, branch, main, deploy, build, bug, pull request, GitHub, Claude, Ceci, lint, TypeScript, token, login, checkout, README.'

// Audio frames allowed for a text (12.5 per second; ~14 characters per second in pt-BR), so a
// rare generation loop stops after a few seconds instead of babbling for 40.
export const maxFrames = text => Math.ceil(String(text).length * 1.5) + 25

// Below this much video memory the voice and the ears would not fit together: the light profile.
export const MIN_VRAM_MIB = 6000

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
// Intel's integrated graphics, whose "memory" is shared RAM.
const WEAK_DEVICE = /llvmpipe|lavapipe|swiftshader|microsoft basic render|intel.*\b(uhd|hd graphics|iris)\b/i

// gpu when this platform has a build and a dedicated device with enough memory; light otherwise.
// LUKE_VOICE_PROFILE=gpu|light overrides the choice.
export function pickProfile({ key, devices = [], override = '' }) {
  if (override === 'light') return { profile: 'light', reason: 'escolhido' }
  if (!key) return { profile: 'light', reason: 'sem versão nativa para este sistema' }
  const usable = devices.filter(d => !WEAK_DEVICE.test(d.name))
  const best = [...usable].sort((a, b) => b.mib - a.mib)[0]
  if (override === 'gpu') return { profile: 'gpu', reason: 'escolhido', device: (best ?? devices[0])?.name ?? null }
  if (!best && devices.length) return { profile: 'light', reason: `só placa de vídeo integrada ou por software (${devices[0].name})`, device: devices[0].name }
  if (!best) return { profile: 'light', reason: 'nenhuma placa de vídeo encontrada' }
  if (best.mib < MIN_VRAM_MIB) return { profile: 'light', reason: `placa de vídeo com ${best.mib} MiB (precisa de ${MIN_VRAM_MIB})`, device: best.name }
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

export function readProfile(dir = engineDir()) {
  try {
    return JSON.parse(readFileSync(profileFile(dir), 'utf8'))
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

// Everything a profile needs, downloaded and checked: the build and the profile decision, then the
// models of that profile. onProgress(loaded, total, label) reports bytes over all model files.
// Returns the profile. `devices` already listed and a `reason` come with a fallback to the light
// profile (setup.mjs, when the natural voice fails its test). checkSpace({ paths, dir }) runs once
// the profile is known, before its models are downloaded (setup.mjs fails early on a full disk).
export async function prepareEngine({ dir = engineDir(), models = modelsDir(), request, onProgress = () => {}, run = runFile, override = process.env.LUKE_VOICE_PROFILE ?? '', devices: known = null, reason = '', checkSpace = null } = {}) {
  const key = platformKey()
  let exe = null
  let devices = known ?? []
  if (key && override !== 'light') {
    exe = await ensureBinaries({ dir, key, request, run, onProgress: (loaded, total) => onProgress(loaded, total, 'llama.cpp') })
    devices = await listDevices(exe, run)
  }
  const choice = pickProfile({ key, devices, override })
  const profile = { ...choice, ...(reason ? { reason } : {}), build: LLAMA_BUILD, exe, devices, at: new Date().toISOString() }
  mkdirSync(dir, { recursive: true })
  writeFileSync(profileFile(dir), JSON.stringify(profile, null, 2))
  const groups = profileGroups(profile.profile, devices)
  const total = groupBytes(groups)
  await checkSpace?.({ paths: groupPaths(groups), dir: models })
  let done = 0
  for (const path of groupPaths(groups)) {
    await ensureModel(path, { dir: models, request, onProgress: loaded => onProgress(done + loaded, total, 'modelos') })
    done += MODELS[path].size
  }
  onProgress(total, total, 'modelos')
  if (profile.profile === 'gpu') pruneModels({ dir: models })
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

export function createEngine({ dir = engineDir(), models = modelsDir(), spawn = nodeSpawn, request = fetch, log = () => {}, command = null, readyTimeoutMs = 90_000, latePollMs = 2000, guard = null } = {}) {
  const services = new Map() // name -> { port, child, isReady, restarts: number[], isStopping, hasExited, firstWait }
  let isStopped = false
  let guarded = guard

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
    const args = [...base.slice(1), ...spec.args(files), '--host', '127.0.0.1', '--port', String(port)]
    mkdirSync(dir, { recursive: true })
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
    async start(names = Object.keys(SERVICES), { exe } = {}) {
      isStopped = false
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
