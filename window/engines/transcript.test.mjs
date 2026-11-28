import assert from 'node:assert/strict'
import { test } from 'node:test'

import { isBargeEcho, isEcho, isNotSpeech } from './transcript.js'

test('punctuation alone is not speech, but a word with accents is, however short', () => {
  for (const heard of ['', '.', '...', ' ?! ', '-', '…']) assert.equal(isNotSpeech(heard), true, heard)
  for (const heard of ['É.', 'é', 'Ó!', 'à', 'Sim.', '5', 'ok']) assert.equal(isNotSpeech(heard), false, heard)
})

test('a transcript that is entirely a known Whisper phantom phrase is not speech, in any case, accent or punctuation', () => {
  for (const heard of [
    'Obrigado por assistir.',
    'obrigada por assistir!',
    'OBRIGADO POR ASSISTIREM',
    'Legendas pela comunidade Amara.org',
    'Legendas pela comunidade amara.org.',
    'Inscreva-se no canal!',
    'Inscreva-se.',
    'Se inscreva no canal.',
    'Obrigado por assistir. Inscreva-se no canal!',
    'Obrigado por assistir. Obrigado por assistir.',
    '(language: pt)',
    'language Portuguese',
  ]) {
    assert.equal(isNotSpeech(heard), true, heard)
  }
})

test('a real sentence that merely contains a phantom phrase, or a short thanks, is still speech', () => {
  for (const heard of [
    'Obrigado.',
    'Obrigada, Ceci.',
    'Tchau.',
    'Obrigado por assistir o deploy comigo.',
    'Ceci, inscreva-se no canal do time.',
    'Abre as legendas pela comunidade amara.org e me fala.',
    'Valeu, obrigado por assistir.',
  ]) {
    assert.equal(isNotSpeech(heard), false, heard)
  }
})

test("a barge-in made of Ceci's own words is her echo; the user's own words are not", () => {
  const said = 'Pronto, os testes da API passaram e eu já abri o pull request.'
  assert.equal(isEcho('os testes da API passaram', said), true)
  assert.equal(isEcho('Os testes da a p i passaram e eu já', said), true)
  assert.equal(isEcho('Certo.', 'Certo.'), true)
  assert.equal(isEcho('para, espera, roda o deploy primeiro', said), false)
  assert.equal(isEcho('não, quero outra coisa', said), false)
  assert.equal(isEcho('', said), false)
  assert.equal(isEcho('testes', ''), false)
})

test('a short yes or no said over Ceci\'s "ok?" is the answer, not her echo, even made of her words', () => {
  const said = 'Refino e mando isso para o Claude?'
  // While her "ok?" waits, "isso" or "manda" over her voice is the user's answer.
  for (const heard of ['Isso.', 'Isso mesmo.', 'Pode mandar.', 'Não.', 'Sim.']) assert.equal(isBargeEcho(heard, said, true), false, heard)
  // With no "ok?" waiting, her own words are still her echo.
  assert.equal(isBargeEcho('Isso.', said, false), true)
  // A longer run of her words is still her echo, "ok?" or not.
  assert.equal(isBargeEcho('Refino e mando isso para o Claude', said, true), true)
  // The user's own words are never her echo.
  assert.equal(isBargeEcho('roda os testes da pasta hub', said, false), false)
})
