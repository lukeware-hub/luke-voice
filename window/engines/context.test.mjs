import { test } from 'node:test'
import assert from 'node:assert/strict'
import { CLOSE, OPEN, quoteUntrusted } from '../guard.js'
import { contextEntry, trimContext } from './context.js'

test('one long entry is cut to the hub limit instead of emptying the context', () => {
  const list = ['a', 'b']
  trimContext(list, 'x'.repeat(5000))
  assert.deepEqual(list, ['a', 'b', 'x'.repeat(2500)])
})

test('a long untrusted entry is cut inside its markers: the closing one stays', () => {
  const list = []
  trimContext(list, `[news]\n${quoteUntrusted('x'.repeat(5000))}`)
  const [entry] = list
  assert.ok(entry.length <= 2500)
  assert.ok(entry.startsWith(`[news]\n${OPEN}\n`))
  assert.ok(entry.endsWith(`\n${CLOSE}`))
  // A long entry with no open block is only cut.
  assert.equal(contextEntry('y'.repeat(3000)), 'y'.repeat(2500))
})

test('news waiting to be read is not pushed out by activity; the oldest other entry goes first', () => {
  const news = contextEntry(`[news]\n${quoteUntrusted('task done: ok')}`)
  const isKept = entry => entry === news
  const list = ['[activity] old']
  trimContext(list, news, isKept)
  for (let i = 0; i < 12; i++) trimContext(list, `[activity] ${i}`, isKept)
  assert.ok(list.includes(news))
  assert.equal(list.length, 8)
  assert.equal(list.at(-1), '[activity] 11')
  // Once read, it ages out like any other entry.
  for (let i = 0; i < 8; i++) trimContext(list, `[activity] again ${i}`)
  assert.ok(!list.includes(news))
})

test('the context keeps the newest entries within count and size', () => {
  const list = []
  for (let i = 0; i < 12; i++) trimContext(list, String(i))
  assert.deepEqual(list, ['4', '5', '6', '7', '8', '9', '10', '11'])
  const big = []
  for (let i = 0; i < 8; i++) trimContext(big, String(i).repeat(1000))
  assert.deepEqual(big.map(e => e[0]), ['3', '4', '5', '6', '7'])
})
