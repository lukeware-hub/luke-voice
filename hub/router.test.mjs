import assert from 'node:assert/strict'
import { test } from 'node:test'

import { INTENTS, REPLIES, confirmed, route, routeOf, routerBody } from './router.mjs'

// A router that always answers `intent`, and counts how often it was asked.
function fixed(intent) {
  const asked = []
  const ask = async body => {
    asked.push(body)
    return { choices: [{ message: { content: JSON.stringify({ intent }) } }] }
  }
  return { ask, asked }
}

test('the request is greedy, without thinking, and constrained to the intents', () => {
  const body = routerBody('oi ceci')
  assert.equal(body.temperature, 0)
  assert.deepEqual(body.chat_template_kwargs, { enable_thinking: false })
  assert.deepEqual(body.response_format.json_schema.schema.properties.intent.enum, INTENTS)
  assert.equal(body.messages.at(-1).content, 'oi ceci')
})

test('anything unexpected from the model means Claude', () => {
  assert.equal(routeOf({ choices: [{ message: { content: '{"intent":"greeting"}' } }] }), 'greeting')
  assert.equal(routeOf({ choices: [{ message: { content: '{"intent":"run_tests"}' } }] }), 'claude')
  assert.equal(routeOf({ choices: [{ message: { content: 'oi!' } }] }), 'claude')
  assert.equal(routeOf(null), 'claude')
})

test('small talk is answered with Ceci\'s own written lines', async () => {
  const { ask } = fixed('greeting')
  const first = await route('oi ceci', { ask })
  assert.equal(first.intent, 'greeting')
  assert.ok(REPLIES.greeting.includes(first.say))
  // Taken in turn, so she does not repeat herself.
  assert.notEqual((await route('olá', { ask })).say, first.say)
  assert.equal((await route('quantos anos você tem?', fixed('age'))).say, 'Eu tenho 23 anos!')
  assert.match((await route('quem te criou?', fixed('creator'))).say, /Diego Morais.*Lukeware/)
  // "quem é você?" gets her name and job, never her age or creator.
  const who = (await route('quem é você?', fixed('identity'))).say
  assert.match(who, /Ceci/)
  assert.doesNotMatch(who, /23|Diego|Lukeware/)
})

test('a request is never answered locally, even when the model calls it small talk', async () => {
  for (const [text, intent] of [
    ['manda o claude parar e esperar', 'ack'],
    ['oi, roda o lint', 'greeting'],
    ['valeu, pode mandar', 'thanks'],
    ['tchau claude', 'goodbye'],
    ['quem fez esse commit?', 'creator'],
    ['quantos anos tem o projeto?', 'age'],
    ['tudo certo com o build?', 'how_are_you'],
    ['hum', 'ack'],
  ]) {
    const { intent: got, say } = await route(text, fixed(intent))
    assert.equal(got, 'claude', text)
    assert.equal(say, null, text)
  }
})

test('a long utterance skips the router; a failing router means Claude', async () => {
  const { ask, asked } = fixed('greeting')
  assert.equal((await route('oi ceci tudo bem com você hoje de manhã aqui', { ask })).intent, 'claude')
  assert.equal(asked.length, 0)
  const broken = { ask: async () => Promise.reject(new Error('down')) }
  assert.deepEqual(await route('oi', broken), { intent: 'claude', say: null })
})

test('after a question of hers, a short reaction is an answer for Claude', async () => {
  assert.equal((await route('tá bom', { ...fixed('ack'), lastSaid: 'Quer que eu rode os testes?' })).intent, 'claude')
  assert.equal((await route('tá bom', { ...fixed('ack'), lastSaid: 'Terminei.' })).intent, 'ack')
})

test('"tudo certo?" read as a greeting is answered as "how are you"', async () => {
  assert.equal((await route('oi, tudo bem?', fixed('greeting'))).intent, 'how_are_you')
  assert.equal(confirmed('identity', 'o que você faz?'), true)
  assert.equal(confirmed('thanks', 'obrigado, agora faz o commit'), false)
})
