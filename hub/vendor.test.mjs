import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { VENDOR, contentType, vendorFile } from './vendor.mjs'

const PATH = 'espeak/dist/version.mjs'
const fresh = () => mkdtempSync(join(tmpdir(), 'luke-vendor-'))

// Real bytes are not needed: point the entry at bytes whose hash we know.
function withEntry(bytes, run) {
  const saved = VENDOR[PATH]
  VENDOR[PATH] = { url: 'https://cdn.example/version.mjs', sha384: createHash('sha384').update(bytes).digest('base64') }
  return run().finally(() => (VENDOR[PATH] = saved))
}

const ok = bytes => async () => ({ ok: true, status: 200, arrayBuffer: async () => bytes })

test('every vendored file is pinned to an exact version on jsDelivr with a sha384', () => {
  for (const [path, { url, sha384 }] of Object.entries(VENDOR)) {
    assert.match(url, /^https:\/\/cdn\.jsdelivr\.net\/npm\/(@[^/]+\/)?[^/@]+@\d+\.\d+\.\d+\//, path)
    assert.match(sha384, /^[A-Za-z0-9+/]{64}$/, path)
  }
})

test('a vendored file is downloaded once, verified, and then read from disk', () =>
  withEntry(Buffer.from('export const V = 1'), async () => {
    const dir = fresh()
    let calls = 0
    const request = async () => (calls++, ok(Buffer.from('export const V = 1'))())
    assert.equal(String(await vendorFile(PATH, { dir, request })), 'export const V = 1')
    assert.equal(String(await vendorFile(PATH, { dir, request })), 'export const V = 1')
    assert.equal(calls, 1)
    assert.equal(String(readFileSync(join(dir, 'espeak', 'dist', 'version.mjs'))), 'export const V = 1')
  }))

test('a download whose hash does not match is refused and never saved', () =>
  withEntry(Buffer.from('good'), async () => {
    const dir = fresh()
    await assert.rejects(vendorFile(PATH, { dir, request: ok(Buffer.from('evil')) }), /Integrity check failed/)
    await assert.rejects(vendorFile(PATH, { dir, request: ok(Buffer.from('evil')) }), /Integrity check failed/)
  }))

test('a tampered file on disk is downloaded again', () =>
  withEntry(Buffer.from('good'), async () => {
    const dir = fresh()
    mkdirSync(join(dir, 'espeak', 'dist'), { recursive: true })
    writeFileSync(join(dir, 'espeak', 'dist', 'version.mjs'), 'tampered')
    assert.equal(String(await vendorFile(PATH, { dir, request: ok(Buffer.from('good')) })), 'good')
  }))

test('an unknown path is not served, and types follow the extension', async () => {
  assert.equal(await vendorFile('../../etc/passwd', { dir: fresh(), request: ok(Buffer.from('x')) }), null)
  assert.equal(contentType('a/b.wasm'), 'application/wasm')
  assert.equal(contentType('a/b.mjs'), 'text/javascript; charset=utf-8')
})
