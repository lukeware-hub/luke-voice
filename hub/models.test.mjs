import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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
