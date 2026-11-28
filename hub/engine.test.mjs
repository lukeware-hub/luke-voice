import assert from 'node:assert/strict'
import { spawn as nodeSpawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { test } from 'node:test'

import { BINARIES, LEAN_VRAM_MIB, LLAMA_BUILD, MIN_VRAM_MIB, SERVICES, cpuThreads, createEngine, ensureBinaries, groupBytes, parseDevices, pickProfile, platformKey, profileGroups, profileReady } from './engine.mjs'
import { MODELS } from './models.mjs'

const fresh = () => mkdtempSync(join(tmpdir(), 'luke-engine-'))

test('every llama.cpp build is an official GitHub release asset pinned by sha256', () => {
  for (const [key, entry] of Object.entries(BINARIES)) {
    assert.match(entry.url, /^https:\/\/github\.com\/ggml-org\/llama\.cpp\/releases\/download\/b\d+\//, key)
    assert.match(entry.sha256, /^[0-9a-f]{64}$/, key)
    assert.ok(entry.size > 0 && entry.exe, key)
  }
  assert.equal(platformKey('win32', 'x64'), 'win32-x64')
  assert.equal(platformKey('darwin', 'arm64'), 'darwin-arm64')
  assert.equal(platformKey('darwin', 'x64', { isTranslated: () => false }), null)
  // An Apple silicon Mac in a Rosetta terminal (x64 Node): the arm64 build, not the light voice.
  assert.equal(platformKey('darwin', 'x64', { isTranslated: () => true }), 'darwin-arm64')
  assert.equal(platformKey('linux', 'x64', { isTranslated: () => assert.fail('only asked on a Mac') }), 'linux-x64')
})

// The 1.7B voice (0.10.0) took the gpu download from ~2.5 to ~3.3 GB.
test('every native service names models that exist in the manifest, and the gpu download stays under 3.5 GB', () => {
  let bytes = 0
  for (const [name, spec] of Object.entries(SERVICES)) {
    for (const path of spec.models) {
      assert.ok(MODELS[path], `${name}: ${path}`)
      bytes += MODELS[path].size
    }
  }
  bytes += Object.values(MODELS).filter(m => m.group === 'turn').reduce((n, m) => n + m.size, 0)
  bytes += Math.max(...Object.values(BINARIES).map(b => b.size))
  assert.ok(bytes < 3.5e9, `${(bytes / 1e9).toFixed(2)} GB`)
})

test('the servers run lean: small contexts, no busy-waiting, no prompt cache, few CPU threads on the GPU ones', () => {
  const flags = name => {
    const args = SERVICES[name].args(['m.gguf', 'mm.gguf'])
    return Object.fromEntries(['-c', '-ub', '-np', '-ngl', '--poll', '-cram', '-t', '-lm'].map(f => [f, args.includes(f) ? args[args.indexOf(f) + 1] : null]))
  }
  assert.deepEqual(flags('tts'), { '-c': '1024', '-ub': '256', '-np': '1', '-ngl': '99', '--poll': '0', '-cram': '0', '-t': '2', '-lm': 'none' })
  assert.deepEqual(flags('asr'), { '-c': '1536', '-ub': '256', '-np': '1', '-ngl': '99', '--poll': '0', '-cram': '0', '-t': '2', '-lm': 'none' })
  // The router runs on the CPU: all its threads, and its file stays mapped.
  assert.deepEqual(flags('router'), { '-c': '2048', '-ub': null, '-np': '1', '-ngl': '0', '--poll': '0', '-cram': '0', '-t': '2', '-lm': null })
})

test('lean: the ears move to the CPU (model and projector) so a smaller GPU keeps Ceci\'s original voice', () => {
  const lean = SERVICES.asr.args(['m.gguf', 'mm.gguf'], { lean: true })
  assert.equal(lean[lean.indexOf('-ngl') + 1], '0')
  assert.ok(lean.includes('--no-mmproj-offload'))
  assert.equal(lean[lean.indexOf('-t') + 1], String(cpuThreads()))
  assert.ok(!lean.includes('-lm'), 'on the CPU the model stays mapped instead of copied')
  assert.deepEqual([lean[lean.indexOf('-c') + 1], lean[lean.indexOf('-ub') + 1]], ['1536', '256'])
  // The voice itself never changes with lean: same flags, same GPU.
  assert.deepEqual(SERVICES.tts.args(['m.gguf', 'mm.gguf'], { lean: true }), SERVICES.tts.args(['m.gguf', 'mm.gguf']))
  // Most cores, two left for the machine, between 2 and 8.
  assert.deepEqual([cpuThreads(4), cpuThreads(8), cpuThreads(16), cpuThreads(2)], [2, 6, 8, 2])
})

test('each profile downloads its own groups at install time, within budget', () => {
  assert.deepEqual(profileGroups('gpu', [{ name: 'Vulkan0' }]), ['turn', 'native'])
  assert.deepEqual(profileGroups('light', []), ['turn', 'light', 'light-cpu'])
  assert.deepEqual(profileGroups('light', [{ name: 'Vulkan0' }]), ['turn', 'light', 'light-webgpu'])
  const build = Math.max(...Object.values(BINARIES).map(b => b.size))
  assert.ok(groupBytes(profileGroups('gpu')) + build < 3.5e9) // the 1.7B voice: ~3.3 GB
  // The light profile on the CPU: about a third of a gigabyte; with WebGPU, Kokoro is fp32.
  assert.ok(groupBytes(profileGroups('light', [])) < 350e6, String(groupBytes(profileGroups('light', []))))
  assert.ok(groupBytes(profileGroups('light', [{}])) + build < 550e6)
  // Every group named by a profile exists.
  for (const group of new Set([...profileGroups('gpu'), ...profileGroups('light', []), ...profileGroups('light', [{}])])) {
    assert.ok(Object.values(MODELS).some(m => m.group === group), group)
  }
})

test('devices are read from llama-server --list-devices, Vulkan and Metal', () => {
  const text = 'Available devices:\n  Vulkan0: NVIDIA GeForce RTX 3060 Ti (8238 MiB, 7469 MiB free)\n  Vulkan1: Intel(R) UHD Graphics (2048 MiB, 1900 MiB free)\n'
  assert.deepEqual(parseDevices(text), [
    { id: 'Vulkan0', name: 'NVIDIA GeForce RTX 3060 Ti', mib: 8238 },
    { id: 'Vulkan1', name: 'Intel(R) UHD Graphics', mib: 2048 },
  ])
  assert.deepEqual(parseDevices('  MTL0: Apple M2 Pro (21845 MiB, 21845 MiB free)'), [{ id: 'MTL0', name: 'Apple M2 Pro', mib: 21845 }])
  assert.deepEqual(parseDevices('Available devices:\n'), [])
})

test('the gpu profile needs a native build and a device with enough memory; the user can force either', () => {
  const big = [{ name: 'RTX', mib: 8238 }]
  const small = [{ name: 'UHD', mib: 2048 }]
  assert.equal(pickProfile({ key: 'win32-x64', devices: big }).profile, 'gpu')
  assert.equal(pickProfile({ key: 'win32-x64', devices: small }).profile, 'light')
  assert.match(pickProfile({ key: 'win32-x64', devices: small }).reason, new RegExp(String(LEAN_VRAM_MIB)))
  assert.equal(pickProfile({ key: 'win32-x64', devices: big }).lean, undefined)
  // Room for the voice only (a 4 GB card, a Mac with 8 GB): still Ceci's original voice, lean.
  for (const device of [{ name: 'NVIDIA GeForce GTX 1650', mib: 4096 }, { name: 'Apple M1', mib: 5461 }, { name: 'RTX', mib: MIN_VRAM_MIB - 1 }]) {
    const choice = pickProfile({ key: 'darwin-arm64', devices: [device] })
    assert.deepEqual([choice.profile, choice.lean], ['gpu', true], device.name)
    assert.match(choice.reason, /os ouvidos no processador/)
  }
  assert.equal(pickProfile({ key: 'win32-x64', devices: [{ name: 'RTX', mib: LEAN_VRAM_MIB - 1 }] }).profile, 'light')
  assert.equal(pickProfile({ key: 'win32-x64', devices: [{ name: 'RTX', mib: MIN_VRAM_MIB }] }).lean, undefined)
  assert.equal(pickProfile({ key: 'win32-x64', devices: [] }).profile, 'light')
  assert.equal(pickProfile({ key: null, devices: big }).profile, 'light')
  assert.equal(pickProfile({ key: 'win32-x64', devices: big, override: 'light' }).profile, 'light')
  assert.equal(pickProfile({ key: 'win32-x64', devices: small, override: 'gpu' }).profile, 'gpu')
})

test('the build is downloaded once, checked, unpacked once, and reused', async () => {
  const dir = fresh()
  const bytes = Buffer.from('fake llama archive')
  const saved = BINARIES['test-x64']
  BINARIES['test-x64'] = { url: 'https://github.com/ggml-org/llama.cpp/releases/download/b1/x.zip', sha256: createHash('sha256').update(bytes).digest('hex'), size: bytes.length, exe: 'llama-server.exe' }
  let unpacked = 0
  const run = async (_tar, args) => {
    unpacked++
    const target = args[args.indexOf('-C') + 1]
    writeFileSync(join(target, 'llama-server.exe'), '')
    return { ok: true, stdout: '', stderr: '' }
  }
  try {
    const request = async () => new Response(bytes, { status: 200 })
    const exe = await ensureBinaries({ dir, key: 'test-x64', request, run })
    assert.ok(existsSync(exe))
    await ensureBinaries({ dir, key: 'test-x64', request, run })
    assert.equal(unpacked, 1)
  } finally {
    if (saved) BINARIES['test-x64'] = saved
    else delete BINARIES['test-x64']
  }
})

test('the build is unpacked aside and moved in whole: a second process (setup and hub) never sees it half done', async () => {
  const { readdirSync, rmSync } = await import('node:fs')
  const dir = fresh()
  const bytes = Buffer.from('fake llama archive')
  const saved = BINARIES['test-x64']
  BINARIES['test-x64'] = { url: 'https://github.com/ggml-org/llama.cpp/releases/download/b1/x.zip', sha256: createHash('sha256').update(bytes).digest('hex'), size: bytes.length, exe: 'llama-server.exe' }
  const targets = []
  // Two unpacks at once, each slow: like the hub and setup.mjs preparing together.
  const run = async (_tar, args) => {
    const target = args[args.indexOf('-C') + 1]
    targets.push(target)
    await new Promise(resolve => setTimeout(resolve, 50))
    writeFileSync(join(target, 'llama-server.exe'), '')
    return { ok: true, stdout: '', stderr: '' }
  }
  try {
    const request = async () => new Response(bytes, { status: 200 })
    // A folder an older unpack left half done (no marker) is replaced, not trusted.
    mkdirSync(join(dir, LLAMA_BUILD), { recursive: true })
    writeFileSync(join(dir, LLAMA_BUILD, 'partial.dll'), '')
    const [a, b] = await Promise.all([ensureBinaries({ dir, key: 'test-x64', request, run }), ensureBinaries({ dir, key: 'test-x64', request, run })])
    assert.equal(a, b)
    assert.ok(existsSync(a))
    assert.ok(existsSync(join(dir, LLAMA_BUILD, '.unpacked')))
    assert.equal(existsSync(join(dir, LLAMA_BUILD, 'partial.dll')), false)
    for (const target of targets) assert.notEqual(target, join(dir, LLAMA_BUILD), 'tar never writes into the build folder itself')
    assert.deepEqual(readdirSync(dir).filter(name => name.endsWith('.tmp')), [], 'no unpack folder is left behind')
    // An unpack that fails leaves nothing behind.
    rmSync(join(dir, LLAMA_BUILD), { recursive: true })
    await assert.rejects(ensureBinaries({ dir, key: 'test-x64', request, run: async () => ({ ok: false, stdout: '', stderr: 'bad zip' }) }), /bad zip/)
    assert.deepEqual(readdirSync(dir).filter(name => name !== 'downloads'), [])
  } finally {
    if (saved) BINARIES['test-x64'] = saved
    else delete BINARIES['test-x64']
  }
})

// A stand-in for llama-server: answers /health on the port it is given.
const FAKE = `
const port = Number(process.argv[process.argv.indexOf('--port') + 1])
require('node:http').createServer((req, res) => { res.writeHead(req.url === '/health' ? 200 : 404); res.end('{}') }).listen(port, '127.0.0.1')
`

test('the engine starts the servers whose models are on disk, reports them ready, and stops them', async () => {
  const dir = fresh()
  const models = fresh()
  const fake = join(dir, 'fake-llama.cjs')
  writeFileSync(fake, FAKE)
  for (const path of SERVICES.tts.models) {
    mkdirSync(dirname(join(models, path)), { recursive: true })
    writeFileSync(join(models, path), '')
  }
  const engine = createEngine({ dir, models, command: [process.execPath, fake], readyTimeoutMs: 15_000 })
  try {
    const started = await engine.start(['tts', 'asr'])
    assert.deepEqual(started, { tts: true, asr: false })
    assert.match(engine.url('tts'), /^http:\/\/127\.0\.0\.1:\d+$/)
    assert.equal(engine.url('asr'), null)
    assert.deepEqual(engine.status(), { tts: true, asr: false, router: false })
    const health = await fetch(`${engine.url('tts')}/health`)
    assert.equal(health.status, 200)
  } finally {
    engine.stop()
  }
  assert.deepEqual(engine.status(), { tts: false, asr: false, router: false })
})

// A fake llama-server that starts listening after `wait` ms and, when `crash` is set, exits that
// long after it is up.
const fakeServer = (dir, { wait = 0, crash = 0 } = {}) => {
  const file = join(dir, `fake-${wait}-${crash}.cjs`)
  writeFileSync(
    file,
    `const port = Number(process.argv[process.argv.indexOf('--port') + 1])
setTimeout(() => {
  require('node:http').createServer((req, res) => { res.writeHead(req.url === '/health' ? 200 : 404); res.end('{}') }).listen(port, '127.0.0.1')
  if (${crash}) setTimeout(() => process.exit(1), ${crash})
}, ${wait})
setInterval(() => {}, 1000)`,
  )
  return file
}
const ttsModels = () => {
  const models = fresh()
  for (const path of SERVICES.tts.models) {
    mkdirSync(dirname(join(models, path)), { recursive: true })
    writeFileSync(join(models, path), '')
  }
  return models
}
const sleepMs = ms => new Promise(resolve => setTimeout(resolve, ms))

test('a stop while a server is still getting its port starts no server, so none is left running untracked', async () => {
  const dir = fresh()
  let spawns = 0
  const spawn = (...args) => (spawns++, nodeSpawn(...args))
  const engine = createEngine({ dir, models: ttsModels(), spawn, command: [process.execPath, fakeServer(dir)], readyTimeoutMs: 10_000 })
  try {
    const started = engine.start(['tts'])
    engine.stop()
    assert.deepEqual(await started, { tts: false })
    assert.equal(spawns, 0, 'a llama-server was started after stop(), with nothing to stop it')
    assert.equal(engine.url('tts'), null)
    // Setup stops and starts again at once: only the new start runs a server.
    const old = engine.start(['tts'])
    engine.stop()
    const again = engine.start(['tts'])
    assert.deepEqual(await old, { tts: false })
    assert.deepEqual(await again, { tts: true })
    assert.equal(spawns, 1)
  } finally {
    engine.stop()
  }
})

test('a lean start runs the ears on the CPU, and a crashed ear restarts lean too', async () => {
  const dir = fresh()
  const models = fresh()
  for (const path of SERVICES.asr.models) {
    mkdirSync(dirname(join(models, path)), { recursive: true })
    writeFileSync(join(models, path), '')
  }
  const spawned = []
  const spawn = (cmd, args, options) => (spawned.push(args), nodeSpawn(cmd, args, options))
  const engine = createEngine({ dir, models, spawn, command: [process.execPath, fakeServer(dir, { crash: 600 })], readyTimeoutMs: 10_000 })
  try {
    assert.deepEqual(await engine.start(['asr'], { lean: true }), { asr: true })
    for (let i = 0; i < 80 && spawned.length < 2; i++) await sleepMs(50)
    assert.ok(spawned.length >= 2, 'the fake server did not crash and restart')
    for (const args of spawned) {
      assert.equal(args[args.indexOf('-ngl') + 1], '0')
      assert.ok(args.includes('--no-mmproj-offload'))
    }
  } finally {
    engine.stop()
  }
})

test('a server slower than the start timeout is used once it answers, and is never started twice', async () => {
  const dir = fresh()
  let spawns = 0
  const spawn = (...args) => (spawns++, nodeSpawn(...args))
  const engine = createEngine({ dir, models: ttsModels(), spawn, command: [process.execPath, fakeServer(dir, { wait: 1500 })], readyTimeoutMs: 300, latePollMs: 200 })
  try {
    assert.deepEqual(await engine.start(['tts']), { tts: false })
    // The hub tries again on the next call: the running server is waited for, not doubled.
    await engine.start(['tts'])
    for (let i = 0; i < 50 && !engine.url('tts'); i++) await sleepMs(100)
    assert.match(engine.url('tts') ?? '', /^http:\/\/127\.0\.0\.1:\d+$/, 'the late server was never used')
    assert.equal(spawns, 1)
  } finally {
    engine.stop()
  }
})

test('a server that crashes right before the engine is stopped is not started again', async () => {
  const dir = fresh()
  let spawns = 0
  const spawn = (...args) => (spawns++, nodeSpawn(...args))
  const engine = createEngine({ dir, models: ttsModels(), spawn, command: [process.execPath, fakeServer(dir, { crash: 1200 })], readyTimeoutMs: 10_000 })
  assert.deepEqual(await engine.start(['tts']), { tts: true })
  // It crashes, a restart is due in 1 s, and setup stops the engine meanwhile.
  for (let i = 0; i < 80 && engine.url('tts'); i++) await sleepMs(50)
  assert.equal(engine.url('tts'), null, 'the fake server did not crash')
  engine.stop()
  await sleepMs(1500)
  assert.equal(spawns, 1, 'a server was started after stop(), with nothing to stop it')
  assert.equal(engine.url('tts'), null)
})

test('when the hub is killed (no exit handlers run), its servers are stopped too', async () => {
  const dir = fresh()
  const models = ttsModels()
  // A stand-in hub: starts a server through the engine, prints its pid, and stays up.
  const hubFile = join(dir, 'fake-hub.mjs')
  writeFileSync(
    hubFile,
    `import { createEngine } from ${JSON.stringify(pathToFileURL(join(import.meta.dirname, 'engine.mjs')).href)}
const engine = createEngine({ dir: ${JSON.stringify(dir)}, models: ${JSON.stringify(models)}, command: [process.execPath, ${JSON.stringify(fakeServer(dir))}], readyTimeoutMs: 10_000 })
await engine.start(['tts'])
const service = engine.url('tts')
console.log(JSON.stringify({ service }))
setInterval(() => {}, 1000)`,
  )
  const hub = nodeSpawn(process.execPath, [hubFile], { stdio: ['ignore', 'pipe', 'inherit'] })
  let out = ''
  hub.stdout.on('data', chunk => (out += chunk))
  for (let i = 0; i < 100 && !out.includes('service'); i++) await sleepMs(100)
  const { service } = JSON.parse(out)
  assert.match(service ?? '', /^http:/)
  assert.equal((await fetch(`${service}/health`)).status, 200)
  hub.kill('SIGKILL')
  let isUp = true
  for (let i = 0; i < 50 && isUp; i++) {
    await sleepMs(100)
    isUp = await fetch(`${service}/health`).then(() => true, () => false)
  }
  assert.equal(isUp, false, 'the server outlived the killed hub')
})

test('a CPU posing as a GPU (llvmpipe) or integrated graphics (Intel, AMD APUs) gets the light voice, not the natural one', () => {
  const key = 'linux-x64'
  const cases = [
    [[{ id: 'Vulkan0', name: 'llvmpipe (LLVM 15.0.7, 256 bits)', mib: 32000 }], 'light'],
    [[{ id: 'Vulkan0', name: 'Intel(R) UHD Graphics 770', mib: 16000 }], 'light'],
    [[{ id: 'Vulkan0', name: 'Intel(R) Iris(R) Xe Graphics', mib: 8000 }], 'light'],
    [[{ id: 'Vulkan0', name: 'Intel(R) Arc(TM) A770 Graphics', mib: 16000 }], 'gpu'],
    [[{ id: 'Vulkan0', name: 'AMD Radeon RX 7600', mib: 8176 }], 'gpu'],
    // Integrated GPUs whose shared memory reads as video memory: too slow for the natural voice.
    [[{ id: 'Vulkan0', name: 'Intel(R) Arc(TM) Graphics', mib: 18000 }], 'light'],
    [[{ id: 'Vulkan0', name: 'Intel(R) Arc(TM) 140V GPU (16GB)', mib: 16000 }], 'light'],
    [[{ id: 'Vulkan0', name: 'Intel(R) Arc(TM) 130T GPU', mib: 16000 }], 'light'],
    [[{ id: 'Vulkan0', name: 'AMD Radeon(TM) Graphics', mib: 12000 }], 'light'],
    [[{ id: 'Vulkan0', name: 'AMD Radeon 780M Graphics', mib: 16000 }], 'light'],
    [[{ id: 'Vulkan0', name: 'AMD Radeon(TM) 890M', mib: 16000 }], 'light'],
    [[{ id: 'Vulkan0', name: 'AMD Radeon(TM) Vega 8 Graphics', mib: 8000 }], 'light'],
    // Discrete ones stay allowed.
    [[{ id: 'Vulkan0', name: 'Intel(R) Arc(TM) B580 Graphics', mib: 12000 }], 'gpu'],
    [[{ id: 'Vulkan0', name: 'AMD Radeon RX 7900 XTX', mib: 24000 }], 'gpu'],
    [[{ id: 'Vulkan0', name: 'AMD Radeon PRO W7800', mib: 32000 }], 'gpu'],
    [[{ id: 'Vulkan0', name: 'AMD Radeon RX 6700M', mib: 10000 }], 'gpu'],
    [[{ id: 'Metal', name: 'Apple M2 Pro', mib: 21000 }], 'gpu'],
    // A laptop with both: the dedicated one is picked.
    [[{ id: 'Vulkan0', name: 'Intel(R) UHD Graphics', mib: 16000 }, { id: 'Vulkan1', name: 'NVIDIA GeForce RTX 4060 Laptop GPU', mib: 8188 }], 'gpu'],
  ]
  for (const [devices, profile] of cases) assert.equal(pickProfile({ key, devices }).profile, profile, devices.map(d => d.name).join(' + '))
  assert.match(pickProfile({ key, devices: cases[0][0] }).reason, /integrada ou por software \(llvmpipe/)
  assert.equal(pickProfile({ key, devices: cases[3 - 2][0], override: 'gpu' }).profile, 'gpu', 'forced, it is still allowed')
  assert.equal(pickProfile({ key, devices: cases.at(-1)[0] }).device, 'NVIDIA GeForce RTX 4060 Laptop GPU')
})

test('a llama-server that cannot be started (missing or quarantined) is logged and given up on, not a hub crash', async () => {
  const dir = fresh()
  let spawns = 0
  const spawn = (...args) => (spawns++, nodeSpawn(...args))
  const lines = []
  const engine = createEngine({ dir, models: ttsModels(), spawn, command: [join(dir, 'missing-llama-server.exe')], readyTimeoutMs: 10_000, log: line => lines.push(line) })
  try {
    const started = Date.now()
    assert.deepEqual(await engine.start(['tts']), { tts: false })
    assert.ok(Date.now() - started < 3000, `start waited ${Date.now() - started} ms for a server that never ran`)
    // Treated as a crash: restarted, within the same limit of 5 in 5 minutes.
    await sleepMs(5500)
    assert.equal(spawns, 5)
    assert.ok(lines.some(line => /engine tts could not run/.test(line)), lines.join('\n'))
    assert.ok(lines.some(line => /giving up/.test(line)), lines.join('\n'))
  } finally {
    engine.stop()
  }
})

test('start stops waiting for a server that crashed before it was ready', async () => {
  const dir = fresh()
  const crasher = join(dir, 'crash-at-once.cjs')
  writeFileSync(crasher, 'process.exit(1)')
  const engine = createEngine({ dir, models: ttsModels(), command: [process.execPath, crasher], readyTimeoutMs: 10_000 })
  try {
    const started = Date.now()
    assert.deepEqual(await engine.start(['tts']), { tts: false })
    assert.ok(Date.now() - started < 3000, `start polled a dead server for ${Date.now() - started} ms`)
  } finally {
    engine.stop()
  }
})

test('a gpu profile saved by another llama.cpp build is not ready, so it is prepared again', () => {
  const models = fresh()
  const engineFiles = fresh()
  const exe = join(engineFiles, 'llama-server.exe')
  writeFileSync(exe, '')
  // Stand-in sizes, so the test does not write gigabytes.
  const paths = Object.keys(MODELS).filter(path => ['turn', 'native'].includes(MODELS[path].group))
  const sizes = paths.map(path => MODELS[path].size)
  try {
    for (const path of paths) {
      MODELS[path].size = 1
      mkdirSync(dirname(join(models, path)), { recursive: true })
      writeFileSync(join(models, path), 'x')
    }
    const profile = { profile: 'gpu', exe, devices: [{ name: 'RTX', mib: 8192 }], build: LLAMA_BUILD }
    assert.equal(profileReady(profile, { models }), true)
    assert.equal(profileReady({ ...profile, build: 'b1' }, { models }), false)
    assert.equal(profileReady({ ...profile, build: undefined }, { models }), false)
  } finally {
    paths.forEach((path, i) => (MODELS[path].size = sizes[i]))
  }
})

test('models download up to three at a time, with one progress total over all of them', async () => {
  const { downloadModels } = await import('./engine.mjs')
  const paths = Object.keys(MODELS).filter(p => MODELS[p].group === 'light').slice(0, 5)
  const total = paths.reduce((n, p) => n + MODELS[p].size, 0)
  let running = 0
  let most = 0
  const seen = []
  const ensure = async (path, { onProgress }) => {
    running++
    most = Math.max(most, running)
    const size = MODELS[path].size
    for (const part of [0.25, 0.5, 1]) {
      await new Promise(resolve => setTimeout(resolve, 5))
      onProgress(Math.round(size * part), size)
    }
    running--
    return path
  }
  assert.equal(await downloadModels(paths, { ensure, onProgress: (loaded, all) => seen.push([loaded, all]) }), total)
  assert.equal(most, 3)
  assert.ok(seen.every(([, all]) => all === total))
  // The sum never goes back and ends at the total.
  assert.ok(seen.every(([loaded], i) => i === 0 || loaded >= seen[i - 1][0]))
  assert.deepEqual(seen.at(-1), [total, total])
})

test('a failed model download still rejects, and no new download starts after it', async () => {
  const { downloadModels } = await import('./engine.mjs')
  const paths = Object.keys(MODELS).filter(p => MODELS[p].group === 'light').slice(0, 6)
  const started = []
  const ensure = async path => {
    started.push(path)
    await new Promise(resolve => setTimeout(resolve, path === paths[1] ? 5 : 30))
    if (path === paths[1]) throw new Error('Integrity check failed: x')
    return path
  }
  await assert.rejects(downloadModels(paths, { ensure }), /Integrity check failed/)
  assert.deepEqual(started, paths.slice(0, 3))
})

test('prepare downloads the profile models in parallel, reports them as one total, and prunes old llama.cpp builds', async () => {
  const { prepareEngine } = await import('./engine.mjs')
  const dir = fresh()
  // An old build, its archive and a half download of another, and the build a previous profile ran.
  for (const build of ['b1000', 'b2000', LLAMA_BUILD]) mkdirSync(join(dir, build), { recursive: true })
  writeFileSync(join(dir, LLAMA_BUILD, '.unpacked'), LLAMA_BUILD)
  mkdirSync(join(dir, 'downloads'))
  for (const name of ['llama-b1000-bin-win-vulkan-x64.zip', 'llama-b1500-bin-win-vulkan-x64.zip.part', `llama-${LLAMA_BUILD}-bin-win-vulkan-x64.zip`, 'llama-b1800-bin-win-vulkan-x64.zip', 'llama-b1800-bin-win-vulkan-x64.zip.lock']) writeFileSync(join(dir, 'downloads', name), 'x')
  writeFileSync(join(dir, 'profile.json'), JSON.stringify({ profile: 'gpu', build: 'b2000', exe: join(dir, 'b2000', 'llama-server.exe') }))
  const totals = new Set()
  const done = []
  const profile = await prepareEngine({
    dir,
    models: fresh(),
    override: 'light',
    ensure: async (path, { onProgress }) => {
      onProgress(MODELS[path].size, MODELS[path].size)
      done.push(path)
    },
    onProgress: (loaded, total, label) => label === 'modelos' && totals.add(total),
  })
  assert.equal(profile.profile, 'light')
  assert.equal(totals.size, 1)
  assert.equal([...totals][0], groupBytes(profileGroups('light', [])))
  assert.equal(done.length, Object.values(MODELS).filter(m => ['turn', 'light', 'light-cpu'].includes(m.group)).length)
  // Pruned: the old build and archives. Kept: this build, the build the previous profile ran, and
  // an archive another process is still downloading.
  assert.equal(existsSync(join(dir, 'b1000')), false)
  assert.equal(existsSync(join(dir, 'b2000')), true)
  assert.equal(existsSync(join(dir, LLAMA_BUILD)), true)
  assert.equal(existsSync(join(dir, 'downloads', 'llama-b1000-bin-win-vulkan-x64.zip')), false)
  assert.equal(existsSync(join(dir, 'downloads', 'llama-b1500-bin-win-vulkan-x64.zip.part')), false)
  assert.equal(existsSync(join(dir, 'downloads', `llama-${LLAMA_BUILD}-bin-win-vulkan-x64.zip`)), false)
  assert.equal(existsSync(join(dir, 'downloads', 'llama-b1800-bin-win-vulkan-x64.zip')), true)
})

test('after the natural voice failed its test, a later preparation keeps the light voice', async () => {
  const { prepareEngine } = await import('./engine.mjs')
  const ensure = async (path, { onProgress }) => onProgress(MODELS[path].size, MODELS[path].size)
  const M1 = [{ id: 'MTL0', name: 'Apple M1', mib: 12124 }]
  const why = 'a voz natural falhou no teste: lenta demais (7.4 s para 2.6 s de fala)'
  const dir = fresh()
  // setup.mjs, after two failed tests: the light profile, remembering the failure.
  const fallback = await prepareEngine({ dir, models: fresh(), key: 'darwin-arm64', override: 'light', devices: M1, failed: true, reason: why, ensure })
  assert.equal(fallback.profile, 'light')
  assert.equal(fallback.naturalFailed, true)
  // The hub, starting while the light models still download, prepares again with no override:
  // it once wrote gpu here and every call used the slow natural voice. No llama.cpp is fetched.
  const again = await prepareEngine({ dir, models: fresh(), key: 'darwin-arm64', override: '', ensure, run: () => assert.fail('no llama.cpp for the light voice') })
  assert.equal(again.profile, 'light')
  assert.equal(again.naturalFailed, true)
  assert.equal(again.reason, why)
  // The devices are kept: the light voice's models are the WebGPU ones on this Mac.
  assert.deepEqual(again.devices, M1)
  assert.equal(JSON.parse(readFileSync(join(dir, 'profile.json'), 'utf8')).profile, 'light')
  // Setup tests the natural voice again: the remembered failure no longer decides.
  const retried = await prepareEngine({ dir, models: fresh(), key: null, override: '', retryNatural: true, ensure })
  assert.equal(retried.naturalFailed, undefined)
})

test('the archive of this build stays until it is unpacked', async () => {
  const { pruneEngine } = await import('./engine.mjs')
  const dir = fresh()
  mkdirSync(join(dir, 'downloads'), { recursive: true })
  const archive = join(dir, 'downloads', `llama-${LLAMA_BUILD}-bin-win-vulkan-x64.zip`)
  writeFileSync(archive, 'x')
  assert.deepEqual(pruneEngine({ dir }), [])
  assert.equal(existsSync(archive), true)
})

test('a server log past the limit is moved to .old.log when the server starts, replacing the previous one', async () => {
  const { rotateLog } = await import('./engine.mjs')
  const { readFileSync } = await import('node:fs')
  const dir = fresh()
  const log = join(dir, 'tts.log')
  assert.equal(rotateLog(log, 10), false, 'no log yet')
  writeFileSync(log, 'small')
  assert.equal(rotateLog(log, 10), false)
  writeFileSync(join(dir, 'tts.old.log'), 'older')
  writeFileSync(log, 'x'.repeat(11))
  assert.equal(rotateLog(log, 10), true)
  assert.equal(existsSync(log), false)
  assert.equal(readFileSync(join(dir, 'tts.old.log'), 'utf8'), 'x'.repeat(11))
})

test("Ceci's, Luke's and João's voices come with every install: the same clips, transcripts, models and sampling", async () => {
  const { readFileSync } = await import('node:fs')
  const { VOICE_SETTINGS } = await import('./engine.mjs')
  const root = join(import.meta.dirname, '..')
  const sha = file => createHash('sha256').update(readFileSync(join(root, file))).digest('hex')
  // The reference clips the owner picked by ear, and their transcripts: the TTS clones each voice from
  // both. Changing either changes that voice on every machine, so this test must be updated on purpose.
  assert.equal(sha('agent/ceci-voice.wav'), 'd4009e2a9855e8f511c65b27736896488ede82c3fcf65a22ef0f688547a3dca5')
  assert.equal(sha('agent/ceci-voice.txt'), '37f91de2f871d60e54eb1652f46b13498f2032a7e6dc9f1de504a2689ae95927')
  assert.equal(sha('agent/luke-voice.wav'), '9383ea3a6c99dc04050495b0c68f658949071b3319245511f6336a0b16bbb340')
  assert.equal(sha('agent/luke-voice.txt'), '1d0bec3d6efd6a822af792fc2ccb6c260b8e06f04035e992f8508e5d7326a1f8')
  assert.equal(sha('agent/joao-voice.wav'), '10671df6532f6df4cca2af76bcc25f5ca86c0853d380b457e0712fcf61d1b76c')
  assert.equal(sha('agent/joao-voice.txt'), '2c9d1ae5c3977aaab360a6684df8e61395f24a4929870768f5b6853c110e4800')
  // Git must hand them over byte for byte on Windows, Mac and Linux.
  const attributes = readFileSync(join(root, '.gitattributes'), 'utf8')
  assert.match(attributes, /^\*\.wav binary$/m)
  assert.match(attributes, /^agent\/ceci-voice\.txt -text$/m)
  assert.match(attributes, /^agent\/luke-voice\.txt -text$/m)
  assert.match(attributes, /^agent\/joao-voice\.txt -text$/m)
  // The voice models, from luke-voice's own release, pinned by sha256.
  assert.equal(MODELS['native/qwen3-tts-1.7b-base-q5_k_m.gguf'].sha256, '244e74cd46ba8c6aa4851723b667799ddb08b81839ce61b8bd0c8e247c7b6006')
  assert.equal(MODELS['native/qwen3-tts-1.7b-base-mmproj-icl-q8_0.gguf'].sha256, 'd57d1a06a37e0d3f550ffec25977ac457fe0415b0885609a6c315a0e9f09f631')
  assert.match(MODELS['native/qwen3-tts-1.7b-base-q5_k_m.gguf'].url, /^https:\/\/github\.com\/lukeware-hub\/luke-voice\/releases\/download\//)
  // Her sampling: the fixed seed makes the same sentence sound the same everywhere.
  assert.deepEqual(VOICE_SETTINGS, { temperature: 0.9, top_p: 0.9, seed: 7 })
})

test('the profile is read from disk again only when another process rewrites it', async () => {
  const { readProfile } = await import('./engine.mjs')
  const { utimesSync } = await import('node:fs')
  const dir = fresh()
  assert.equal(readProfile(dir), null, 'no profile yet')
  const file = join(dir, 'profile.json')
  writeFileSync(file, JSON.stringify({ profile: 'light' }))
  const first = readProfile(dir)
  assert.equal(first.profile, 'light')
  assert.equal(readProfile(dir), first, 'unchanged: the cached profile')
  // setup.mjs rewrites it from another process.
  writeFileSync(file, JSON.stringify({ profile: 'gpu' }))
  utimesSync(file, new Date(), new Date(Date.now() + 5000))
  assert.equal(readProfile(dir).profile, 'gpu')
})

test('digits and acronyms get more audio frames, so a line full of them is not cut off', async () => {
  const { maxFrames } = await import('./engine.mjs')
  const plain = 'Comecei, te aviso quando terminar.'
  assert.equal(maxFrames(plain), Math.ceil(plain.length * 1.5) + 25)
  // Same length, but "2026" and "API" are said much longer than they are written.
  assert.ok(maxFrames('Em 2026 a API mudou.') >= maxFrames('Em xxxx a xxx mudou.') + 4 * 5 + 3 * 3)
})
