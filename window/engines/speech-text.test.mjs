import assert from 'node:assert/strict'
import { test } from 'node:test'

import { chunks, plainText, respell, speechChunks } from './speech-text.js'

test('markdown and code are dropped, the words stay', () => {
  const text = '## Pronto\n\nCorrigi o **login** em `auth.ts`:\n\n```ts\nconst x = 1\n```\n- veja [o PR](https://github.com/x/y/pull/2)'
  assert.equal(plainText(text), 'Pronto. Corrigi o login em auth.ts:. veja o PR')
})

test('English tech words are respelled for a pt-BR voice, in any case, and other words stay', () => {
  assert.equal(respell('Abri a API e corrigi 2 BUGS na branch do Claude.'), 'Abri a a pê i e corrigi 2 bâgs na brentch do clód.')
  assert.equal(respell('A casa é azul'), 'A casa é azul')
})

test('text is cut into sentences, and a long sentence at a comma or space', () => {
  assert.deepEqual(chunks('Oi. Tudo bem? Sim!'), ['Oi.', 'Tudo bem?', 'Sim!'])
  const long = `${'palavra '.repeat(40)}fim.`
  const parts = chunks(long, 100)
  assert.ok(parts.length > 1)
  assert.ok(parts.every(p => p.length <= 100))
  assert.equal(parts.join(' ').replace(/\s+/g, ' '), long.trim())
})

test('the first chunk is cut short at a comma, so the voice starts sooner', () => {
  const parts = speechChunks('Terminei a tarefa no projeto de autenticação, e todos os testes passaram sem nenhum erro. Pode seguir.')
  assert.equal(parts[0], 'Terminei a tarefa no projeto de autenticação,')
  assert.equal(parts[1], 'e todos os testes passaram sem nenhum erro.')
  assert.equal(parts[2], 'Pode seguir.')
})

test('empty or missing text gives nothing to say', () => {
  assert.deepEqual(speechChunks(''), [])
  assert.deepEqual(speechChunks(undefined), [])
  assert.deepEqual(speechChunks('```\ncode only\n```'), [])
})
