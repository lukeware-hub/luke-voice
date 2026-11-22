import assert from 'node:assert/strict'
import { test } from 'node:test'

import { isNotSpeech } from './transcript.js'

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
