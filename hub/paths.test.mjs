import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { pathToFileURL } from 'node:url'

import { isMainModule, isOlderVersion } from './paths.mjs'

test('only an older hub is replaced, never a newer one', () => {
  assert.equal(isOlderVersion('0.7.3', '0.7.4'), true)
  assert.equal(isOlderVersion('0.7.9', '0.7.10'), true)
  assert.equal(isOlderVersion('0.6.2', '0.7.0'), true)
  assert.equal(isOlderVersion('0.7.4', '0.7.3'), false)
  assert.equal(isOlderVersion('0.7.4', '0.7.4'), false)
  assert.equal(isOlderVersion(undefined, '0.7.4'), false)
  assert.equal(isOlderVersion('dev', '0.7.4'), false)
})

test('a script started through a symlinked or junctioned folder still knows it is the main script', () => {
  const dir = mkdtempSync(join(tmpdir(), 'luke-main-'))
  const real = join(dir, 'real')
  mkdirSync(real)
  const paths = pathToFileURL(join(import.meta.dirname, 'paths.mjs')).href
  writeFileSync(join(real, 'run.mjs'), `import { isMainModule } from ${JSON.stringify(paths)}
console.log(isMainModule(import.meta.url, process.argv[1]))
`)
  writeFileSync(join(real, 'other.mjs'), `import ${JSON.stringify(pathToFileURL(join(real, 'run.mjs')).href)}
`)
  const link = join(dir, 'link')
  symlinkSync(real, link, 'junction') // A junction on Windows (no admin needed), a symlink elsewhere.
  const run = script => spawnSync(process.execPath, [script], { encoding: 'utf8' }).stdout.trim()
  assert.equal(run(join(real, 'run.mjs')), 'true')
  assert.equal(run(join(link, 'run.mjs')), 'true')
  assert.equal(run(join(link, 'other.mjs')), 'false', 'imported by another script, it is not the main one')
  assert.equal(isMainModule(pathToFileURL(join(real, 'run.mjs')).href, undefined), false)
})
