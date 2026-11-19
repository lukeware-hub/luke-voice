import assert from 'node:assert/strict'
import { test } from 'node:test'

import { isOlderVersion } from './paths.mjs'

test('only an older hub is replaced, never a newer one', () => {
  assert.equal(isOlderVersion('0.7.3', '0.7.4'), true)
  assert.equal(isOlderVersion('0.7.9', '0.7.10'), true)
  assert.equal(isOlderVersion('0.6.2', '0.7.0'), true)
  assert.equal(isOlderVersion('0.7.4', '0.7.3'), false)
  assert.equal(isOlderVersion('0.7.4', '0.7.4'), false)
  assert.equal(isOlderVersion(undefined, '0.7.4'), false)
  assert.equal(isOlderVersion('dev', '0.7.4'), false)
})
