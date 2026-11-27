import assert from 'node:assert/strict'
import { test } from 'node:test'

import { asrWords, withoutPromptLeak } from './asr-leak.mjs'
import { ASR_GLOSSARY } from './engine.mjs'

const said = 'Vou rodar os testes do luke-voice na pasta do projeto e te conto o resultado. Posso?'
const prompt = `${ASR_GLOSSARY} Sessões: administrator. Ceci acabou de dizer: ${said}`

test('the whole prompt handed back for silence or soft noise is no speech at all', () => {
  // Word for word what Qwen3-ASR answered for 1 s of silence (recorded on the real engine).
  assert.equal(withoutPromptLeak(prompt, prompt), '')
  assert.equal(withoutPromptLeak(ASR_GLOSSARY, prompt), '')
  assert.equal(withoutPromptLeak(`Ceci acabou de dizer: ${said}`, prompt), '')
})

test('a leaked prompt in front of what the user said leaves only the user', () => {
  assert.equal(withoutPromptLeak(`${prompt} Sim.`, prompt), 'Sim.')
  assert.equal(withoutPromptLeak(`Ceci acabou de dizer: ${said} Pode.`, prompt), 'Pode.')
  assert.equal(withoutPromptLeak(`na pasta do projeto e te conto o resultado. Posso? Isso.`, prompt), 'Isso.')
})

test("the user's own words stay, even when they repeat a few of Ceci's or the glossary's", () => {
  for (const heard of ['Sim.', 'Ok.', 'Pode rodar os testes.', 'Faz o commit e o push.', 'Isso aí, pode rodar.', 'Roda os testes do luke-voice.', 'Conversa com o Claude.', '']) {
    assert.equal(withoutPromptLeak(heard, prompt), heard)
  }
})

test("the ears' language tag is never the user's words, with or without words after it", () => {
  assert.equal(asrWords('language Portuguese<asr_text>Sim, pode.'), 'Sim, pode.')
  // No words in the audio: the tag alone, as heard after "posso?" on the real engine.
  for (const heard of ['(language: pt)', 'language Portuguese', ' (language: pt). ', 'language pt-BR', '']) assert.equal(asrWords(heard), '', heard)
  assert.equal(asrWords('(language: pt) Sim.'), 'Sim.')
  // Words that only look like it stay.
  for (const heard of ['Fim.', 'Sim.', 'O language server caiu.']) assert.equal(asrWords(heard), heard)
})

test('with no prompt, the transcript is untouched', () => {
  assert.equal(withoutPromptLeak(' Sim. ', ''), 'Sim.')
})
