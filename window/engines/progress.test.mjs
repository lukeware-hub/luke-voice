import assert from 'node:assert/strict'
import { test } from 'node:test'

import { risingPercent } from './progress.js'

test('the download percentage never goes back when a new file adds to the total', () => {
  const percent = risingPercent()
  assert.equal(percent({ loaded: 40, total: 100 }), 40)
  assert.equal(percent({ loaded: 74, total: 100 }), 74)
  // Whisper starts: the total grows to 370, the raw percentage would be 20%.
  assert.equal(percent({ loaded: 74, total: 370 }), 74)
  assert.equal(percent({ loaded: 300, total: 370 }), 81)
  assert.equal(percent({ loaded: 370, total: 370 }), 99, 'stops at 99% until the voice is ready')
  assert.equal(percent({ loaded: 0, total: 0 }), 99)
})
