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

test('times and percentages are written the way a Brazilian reads them; plain numbers are left to the voice', async () => {
  const { spokenForms } = await import('./speech-text.js')
  assert.equal(spokenForms('O deploy subiu às 17h30 e terminou às 18h.'), 'O deploy subiu às 17 e 30 e terminou às 18 horas.')
  assert.equal(spokenForms('Reunião às 9:05, 1h e 12:00.'), 'Reunião às 9 e 05, 1 hora e 12 horas.')
  assert.equal(spokenForms('Cobertura de 85% e 3 %.'), 'Cobertura de 85 por cento e 3 por cento.')
  assert.equal(spokenForms('A porta 4848 e a versão 0.8.1.'), 'A porta 4848 e a versão 0.8.1.')
})

test('the native voice keeps English tech words as they are; the browser voices get them respelled', () => {
  assert.deepEqual(speechChunks('Fiz o commit na branch main.', { isNative: true }), ['Fiz o commit na branch main.'])
  assert.deepEqual(speechChunks('Fiz o commit na branch main.'), ['Fiz o comít na brentch main.'])
})

test('the native voice starts on one short clause, so the first audio comes sooner', () => {
  // Cut at the comma...
  assert.deepEqual(speechChunks('Certo, vou verificar os testes de login no repositório api agora.', { isNative: true }), ['Certo,', 'vou verificar os testes de login no repositório api agora.'])
  // ...but never mid-phrase: without a comma close by, the sentence goes whole.
  assert.deepEqual(speechChunks('Você quer que eu verifique os testes de login no repositório api? Posso?', { isNative: true }), ['Você quer que eu verifique os testes de login no repositório api?', 'Posso?'])
})
