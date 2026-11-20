import assert from 'node:assert/strict'
import { spawn as nodeSpawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test } from 'node:test'

import { BINARIES, MIN_VRAM_MIB, SERVICES, createEngine, ensureBinaries, groupBytes, parseDevices, pickProfile, platformKey, profileGroups } from './engine.mjs'
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
  assert.equal(platformKey('darwin', 'x64'), null)
})

test('every native service names models that exist in the manifest, and the gpu download stays under 3 GB', () => {
  let bytes = 0
  for (const [name, spec] of Object.entries(SERVICES)) {
    for (const path of spec.models) {
      assert.ok(MODELS[path], `${name}: ${path}`)
      bytes += MODELS[path].size
    }
  }
  bytes += Object.values(MODELS).filter(m => m.group === 'turn').reduce((n, m) => n + m.size, 0)
  bytes += Math.max(...Object.values(BINARIES).map(b => b.size))
  assert.ok(bytes < 3e9, `${(bytes / 1e9).toFixed(2)} GB`)
})

test('each profile downloads its own groups at install time, within budget', () => {
  assert.deepEqual(profileGroups('gpu', [{ name: 'Vulkan0' }]), ['turn', 'native'])
  assert.deepEqual(profileGroups('light', []), ['turn', 'light', 'light-cpu'])
  assert.deepEqual(profileGroups('light', [{ name: 'Vulkan0' }]), ['turn', 'light', 'light-webgpu'])
  const build = Math.max(...Object.values(BINARIES).map(b => b.size))
  assert.ok(groupBytes(profileGroups('gpu')) + build < 3e9)
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
  assert.match(pickProfile({ key: 'win32-x64', devices: small }).reason, new RegExp(String(MIN_VRAM_MIB)))
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
