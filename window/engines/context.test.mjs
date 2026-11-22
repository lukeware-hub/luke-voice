import { test } from 'node:test'
import assert from 'node:assert/strict'
import { trimContext } from './context.js'

test('one long entry is cut to the hub limit instead of emptying the context', () => {
  const list = ['a', 'b']
  trimContext(list, 'x'.repeat(5000))
  assert.deepEqual(list, ['a', 'b', 'x'.repeat(1500)])
})

test('the context keeps the newest entries within count and size', () => {
  const list = []
  for (let i = 0; i < 12; i++) trimContext(list, String(i))
  assert.deepEqual(list, ['4', '5', '6', '7', '8', '9', '10', '11'])
  const big = []
  for (let i = 0; i < 4; i++) trimContext(big, String(i).repeat(1000))
  assert.deepEqual(big.map(e => e[0]), ['2', '3'])
})
