import assert from 'node:assert/strict'
import { test } from 'node:test'

import { LONG_ACKS, QUICK_ACKS, pickAck } from './acks.js'

const LONG = 'eu queria que você olhasse o projeto da api e me dissesse por que o build quebrou hoje'

test('a short turn gets a quick word, a long one a listening line', () => {
  assert.ok(QUICK_ACKS.includes(pickAck('roda os testes')))
  // Fewer waiting lines (owner's ask): no "hum" fillers.
  for (const line of [...QUICK_ACKS, ...LONG_ACKS]) assert.doesNotMatch(line, /\bhum\b/i, line)
  assert.ok(LONG_ACKS.includes(pickAck(LONG)))
  // The lines the owner asked for.
  assert.ok(QUICK_ACKS.includes('Entendi.'))
  assert.ok(LONG_ACKS.includes('Deixa eu entender o que você está falando.'))
  assert.ok(LONG_ACKS.includes('Entendi, agora deixa eu analisar.'))
})

test('never the same line twice in a row, and every line can come up', () => {
  let last = ''
  const seen = new Set()
  for (let i = 0; i < 40; i++) {
    const line = pickAck(i % 2 ? LONG : 'roda os testes', last, () => (i * 0.37) % 1)
    assert.notEqual(line, last)
    seen.add(line)
    last = line
  }
  assert.equal(seen.size, QUICK_ACKS.length + LONG_ACKS.length)
})

test('every line is short and ends a sentence', () => {
  for (const line of [...QUICK_ACKS, ...LONG_ACKS]) {
    assert.match(line, /\.$/, line)
    assert.ok(line.split(' ').length <= 8, line)
  }
})
