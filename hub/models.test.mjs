import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { test } from 'node:test'

import { MODELS, ensureModel, modelsStatus } from './models.mjs'

const PATH = 'test/model.bin'
const BYTES = Buffer.from('0123456789abcdefghij'.repeat(50))
const fresh = () => mkdtempSync(join(tmpdir(), 'luke-models-'))

function withEntry(bytes, run) {
  MODELS[PATH] = { url: 'https://hf.example/model.bin', sha256: createHash('sha256').update(bytes).digest('hex'), size: bytes.length, group: 'test' }
  return run().finally(() => delete MODELS[PATH])
}

// A server that honors byte ranges, and counts requests.
function server(bytes) {
  const asked = []
  const request = async (_url, init) => {
    const range = init?.headers?.range
    asked.push(range ?? 'all')
    if (!range) return new Response(bytes, { status: 200 })
    const from = Number(range.match(/bytes=(\d+)-/)[1])
    return new Response(bytes.subarray(from), { status: 206 })
  }
  return { request, asked }
}

test('every model is pinned to a Hugging Face revision with a sha256 and a size', () => {
  for (const [path, { url, sha256, size, group }] of Object.entries(MODELS)) {
    // A pinned Hugging Face revision, or luke-voice's own model release.
    assert.match(url, /^(https:\/\/huggingface\.co\/[^/]+\/[^/]+\/resolve\/[0-9a-f]{40}\/|https:\/\/github\.com\/lukeware-hub\/luke-voice\/releases\/download\/voice-models-v\d+\/)/, path)
    assert.match(sha256, /^[0-9a-f]{64}$/, path)
    assert.ok(Number.isInteger(size) && size > 0, path)
    assert.ok(group, path)
  }
})

test('a model is downloaded once, verified, reported with progress, and then read from disk', () =>
  withEntry(BYTES, async () => {
    const dir = fresh()
    const { request, asked } = server(BYTES)
    const seen = []
    const file = await ensureModel(PATH, { dir, request, onProgress: loaded => seen.push(loaded) })
    assert.deepEqual(readFileSync(file), BYTES)
    assert.equal(seen.at(-1), BYTES.length)
    await ensureModel(PATH, { dir, request })
    assert.deepEqual(asked, ['all'])
    assert.deepEqual(modelsStatus({ dir, group: 'test' }), { files: 1, present: 1, bytes: BYTES.length, total: BYTES.length })
  }))

test('a cut download resumes from where it stopped', () =>
  withEntry(BYTES, async () => {
    const dir = fresh()
    mkdirSync(join(dir, 'test'), { recursive: true })
    writeFileSync(join(dir, 'test', 'model.bin.part'), BYTES.subarray(0, 300))
    const { request, asked } = server(BYTES)
    const file = await ensureModel(PATH, { dir, request })
    assert.deepEqual(asked, ['bytes=300-'])
    assert.deepEqual(readFileSync(file), BYTES)
  }))

test('a download whose hash does not match is refused, and nothing is left in place', () =>
  withEntry(BYTES, async () => {
    const dir = fresh()
    const evil = Buffer.from(BYTES)
    evil[0] = 0x58
    await assert.rejects(ensureModel(PATH, { dir, request: server(evil).request }), /Integrity check failed/)
    assert.equal(existsSync(join(dir, 'test', 'model.bin')), false)
    assert.equal(existsSync(join(dir, 'test', 'model.bin.part')), false)
  }))

test('a tampered file on disk is downloaded again, and an unknown path is not served', () =>
  withEntry(BYTES, async () => {
    const dir = fresh()
    mkdirSync(join(dir, 'test'), { recursive: true })
    writeFileSync(join(dir, 'test', 'model.bin'), Buffer.alloc(BYTES.length, 0x41))
    const file = await ensureModel(PATH, { dir, request: server(BYTES).request })
    assert.deepEqual(readFileSync(file), BYTES)
    assert.equal(await ensureModel('../../hub.json', { dir }), null)
  }))

const sleepMs = ms => new Promise(resolve => setTimeout(resolve, ms))
// A process that is alive while the test runs, to own a lock.
const liveProcess = () => spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore' })

test('a file another process is downloading is waited for, then used, not downloaded again', async () => {
  const dir = fresh()
  const other = liveProcess()
  try {
    await withEntry(BYTES, async () => {
      const file = join(dir, ...PATH.split('/'))
      mkdirSync(join(dir, 'test'), { recursive: true })
      writeFileSync(`${file}.lock`, String(other.pid))
      writeFileSync(`${file}.part`, BYTES.subarray(0, 100))
      const { request, asked } = server(BYTES)
      const seen = []
      const done = ensureModel(PATH, { dir, request, pollMs: 20, onProgress: loaded => seen.push(loaded) })
      await sleepMs(120)
      writeFileSync(`${file}.part`, BYTES.subarray(0, 300))
      await sleepMs(120)
      writeFileSync(file, BYTES) // The other process finished: its file is in place, its lock gone.
      writeFileSync(`${file}.part`, '')
      const { rmSync } = await import('node:fs')
      rmSync(`${file}.part`)
      rmSync(`${file}.lock`)
      assert.equal(await done, file)
      assert.deepEqual(asked, [], 'nothing was downloaded twice')
      assert.ok(seen.includes(300), 'the other download’s progress is shown')
    })
  } finally {
    other.kill()
  }
})

test('a lock left by a process that is gone, or by a download that stopped, is taken over', async () => {
  const gone = spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], { encoding: 'utf8' }).stdout
  const other = liveProcess()
  try {
    for (const owner of [gone, String(other.pid)]) {
      const dir = fresh()
      await withEntry(BYTES, async () => {
        const file = join(dir, ...PATH.split('/'))
        mkdirSync(join(dir, 'test'), { recursive: true })
        writeFileSync(`${file}.lock`, owner)
        const { request, asked } = server(BYTES)
        assert.equal(await ensureModel(PATH, { dir, request, pollMs: 20, staleMs: 150 }), file)
        assert.deepEqual(asked, ['all'])
        assert.deepEqual(readFileSync(file), BYTES)
        assert.equal(existsSync(`${file}.lock`), false)
      })
    }
  } finally {
    other.kill()
  }
})

test('two processes asking for the same file at once both get it whole (installer and hub)', async () => {
  const SIZE = 1024 * 1024
  const blob = Buffer.alloc(SIZE)
  for (let i = 0; i < SIZE; i++) blob[i] = (i * 31 + 7) & 255
  const sha256 = createHash('sha256').update(blob).digest('hex')
  let requests = 0
  const slow = createServer(async (req, res) => {
    requests++
    const from = Number(/bytes=(\d+)-/.exec(req.headers.range ?? '')?.[1] ?? 0)
    res.writeHead(from ? 206 : 200, { 'content-length': SIZE - from })
    for (let at = from; at < SIZE; at += 64 * 1024) {
      res.write(blob.subarray(at, Math.min(SIZE, at + 64 * 1024)))
      await sleepMs(25)
    }
    res.end()
  })
  await new Promise(resolve => slow.listen(0, '127.0.0.1', resolve))
  const dir = fresh()
  const file = join(dir, 'model.bin')
  const script = join(dir, 'client.mjs')
  writeFileSync(script, `import { ensureFile } from ${JSON.stringify(pathToFileURL(join(import.meta.dirname, 'models.mjs')).href)}
const entry = { url: 'http://127.0.0.1:${slow.address().port}/model.bin', sha256: '${sha256}', size: ${SIZE} }
try { await ensureFile(entry, ${JSON.stringify(file)}, { pollMs: 50 }); console.log('OK') } catch (e) { console.log('FAIL', e.message) }
`)
  const run = () => new Promise(resolve => {
    const child = spawn(process.execPath, [script], { stdio: ['ignore', 'pipe', 'inherit'] })
    let out = ''
    child.stdout.on('data', d => (out += d))
    child.on('exit', () => resolve(out.trim()))
  })
  try {
    const results = await Promise.all([run(), sleepMs(150).then(run)])
    assert.deepEqual(results, ['OK', 'OK'])
    assert.equal(requests, 1, 'downloaded once')
    assert.equal(createHash('sha256').update(readFileSync(file)).digest('hex'), sha256)
  } finally {
    slow.close()
  }
})
