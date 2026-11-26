import assert from 'node:assert/strict'
import { test } from 'node:test'

import { GREETINGS, asName, pickGreeting, salutation } from './greetings.js'

const memory = (start = null) => {
  const data = new Map(start === null ? [] : [['luke-voice:last-greeting', String(start)]])
  return { getItem: key => data.get(key) ?? null, setItem: (key, value) => data.set(key, value) }
}
const at = hour => new Date(2026, 10, 26, hour, 30)
const SALUTED = /^(Bom dia|Boa tarde|Boa noite)! /

test('every greeting says she is Ceci and asks what we are doing', () => {
  assert.ok(GREETINGS.length >= 8)
  assert.equal(new Set(GREETINGS).size, GREETINGS.length)
  for (const line of GREETINGS) {
    assert.match(line, /\ba Ceci\b/, line)
    assert.match(line, /\?$/, line)
  }
  // The questions the owner asked for.
  for (const question of ['O que vamos fazer hoje?', 'Em que posso ajudar?', 'O que você deseja?']) {
    assert.ok(GREETINGS.some(line => line.endsWith(question)), question)
  }
})

test('the greeting fits the time of day', () => {
  assert.equal(salutation(5), 'Bom dia')
  assert.equal(salutation(11), 'Bom dia')
  assert.equal(salutation(12), 'Boa tarde')
  assert.equal(salutation(17), 'Boa tarde')
  assert.equal(salutation(18), 'Boa noite')
  assert.equal(salutation(23), 'Boa noite')
  assert.equal(salutation(2), 'Boa noite')
  assert.match(pickGreeting({ storage: memory(), now: at(9) }), /^Bom dia! /)
  assert.match(pickGreeting({ storage: memory(), now: at(15) }), /^Boa tarde! /)
  assert.match(pickGreeting({ storage: memory(), now: at(21) }), /^Boa noite! /)
})

test('a call never opens with the line the last call used', () => {
  const storage = memory()
  let last = null
  for (let i = 0; i < 50; i++) {
    const line = pickGreeting({ storage, random: () => (i * 0.37) % 1, now: at(10) })
    assert.notEqual(line, last)
    last = line
  }
})

test('every line can come up', () => {
  const seen = new Set()
  for (let i = 0; i < GREETINGS.length * 2; i++) seen.add(pickGreeting({ storage: memory(-1), random: () => (i % GREETINGS.length) / GREETINGS.length, now: at(10) }))
  assert.equal(seen.size, GREETINGS.length)
})

test('blocked storage still gives a greeting', () => {
  const broken = { getItem() { throw new Error('blocked') }, setItem() { throw new Error('blocked') } }
  for (const line of [pickGreeting({ storage: broken }), pickGreeting({ storage: undefined })]) {
    assert.match(line, SALUTED)
    assert.ok(GREETINGS.includes(line.replace(SALUTED, '')), line)
  }
})

test('Luke and Nara greet in their own name', () => {
  assert.equal(asName('Eu sou a Ceci. O que vamos fazer hoje?', 'Luke'), 'Eu sou o Luke. O que vamos fazer hoje?')
  assert.equal(asName('Aqui é a Ceci. Em que posso ajudar?', 'Nara'), 'Aqui é a Nara. Em que posso ajudar?')
  for (const line of GREETINGS) assert.doesNotMatch(asName(line, 'Luke'), /Ceci|\ba Luke\b/, line)
  assert.match(pickGreeting({ name: 'Luke', storage: memory(), now: at(9) }), /^Bom dia! .*\bo Luke\b/)
})
