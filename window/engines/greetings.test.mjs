import assert from 'node:assert/strict'
import { test } from 'node:test'

import { GREETINGS, asName, pickGreeting } from './greetings.js'

const memory = (start = null) => {
  const data = new Map(start === null ? [] : [['luke-voice:last-greeting', String(start)]])
  return { getItem: key => data.get(key) ?? null, setItem: (key, value) => data.set(key, value) }
}

test('every greeting says she is Ceci and asks what we are doing today', () => {
  assert.ok(GREETINGS.length >= 8)
  assert.equal(new Set(GREETINGS).size, GREETINGS.length)
  for (const line of GREETINGS) {
    assert.match(line, /\ba Ceci\b/, line)
    assert.match(line, /hoje\?$/, line)
  }
})

test('a call never opens with the line the last call used', () => {
  const storage = memory()
  let last = null
  for (let i = 0; i < 50; i++) {
    const line = pickGreeting({ storage, random: () => (i * 0.37) % 1 })
    assert.notEqual(line, last)
    last = line
  }
})

test('every line can come up', () => {
  const seen = new Set()
  for (let i = 0; i < GREETINGS.length * 2; i++) seen.add(pickGreeting({ storage: memory(-1), random: () => (i % GREETINGS.length) / GREETINGS.length }))
  assert.equal(seen.size, GREETINGS.length)
})

test('blocked storage still gives a greeting', () => {
  const broken = { getItem() { throw new Error('blocked') }, setItem() { throw new Error('blocked') } }
  assert.ok(GREETINGS.includes(pickGreeting({ storage: broken })))
  assert.ok(GREETINGS.includes(pickGreeting({ storage: undefined })))
})

test('Luke and Nara greet in their own name', () => {
  assert.equal(asName('Oi! Eu sou a Ceci. O que vamos fazer hoje?', 'Luke'), 'Oi! Eu sou o Luke. O que vamos fazer hoje?')
  assert.equal(asName('Olá! Aqui é a Ceci. O que vamos fazer hoje?', 'Nara'), 'Olá! Aqui é a Nara. O que vamos fazer hoje?')
  for (const line of GREETINGS) assert.doesNotMatch(asName(line, 'Luke'), /Ceci|\ba Luke\b/, line)
})
