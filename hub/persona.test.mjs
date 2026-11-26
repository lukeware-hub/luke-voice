import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { asPersona, personaFor, personaInfo } from './persona.mjs'
import { REPLIES, ROUTER_SYSTEM } from './router.mjs'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

test('Luke only on a Mac with a male voice; Ceci everywhere else', () => {
  assert.equal(personaFor({ platform: 'darwin', voice: 'system', gender: 'male' }), 'luke')
  assert.equal(personaFor({ platform: 'darwin', voice: 'system', gender: 'female' }), 'ceci')
  assert.equal(personaFor({ platform: 'darwin', voice: 'system', gender: null }), 'ceci')
  // No Mac voice speaks (the natural voice, ElevenLabs, the browser voice): Ceci.
  assert.equal(personaFor({ platform: 'darwin', voice: null, gender: 'male' }), 'ceci')
  for (const platform of ['win32', 'linux']) assert.equal(personaFor({ platform, voice: 'system', gender: 'male' }), 'ceci')
  // Siri Voz 2 (sandra) is Nara; Siri Voz 1 (nando) is Luke.
  assert.equal(personaFor({ platform: 'darwin', voice: 'system', gender: 'female', siri: 'sandra' }), 'nara')
  assert.equal(personaFor({ platform: 'darwin', voice: 'system', gender: 'male', siri: 'nando' }), 'luke')
  assert.equal(personaFor({ platform: 'win32', voice: 'system', gender: 'female', siri: 'sandra' }), 'ceci')
  assert.equal(personaFor({ platform: 'darwin', voice: null, gender: 'female', siri: 'sandra' }), 'ceci')
  assert.deepEqual(personaInfo('nara'), { key: 'nara', name: 'Nara', gender: 'female' })
  assert.deepEqual(personaInfo('luke'), { key: 'luke', name: 'Luke', gender: 'male' })
  assert.deepEqual(personaInfo('ceci'), { key: 'ceci', name: 'Ceci', gender: 'female' })
})

test("Ceci's texts stay byte for byte the same", async () => {
  const prompt = await readFile(join(root, 'agent', 'brain-prompt.md'), 'utf8')
  assert.equal(asPersona(prompt, 'ceci'), prompt)
  assert.equal(asPersona(ROUTER_SYSTEM, 'ceci'), ROUTER_SYSTEM)
})

test("Luke's brain prompt is a man's: no Ceci, nothing in the feminine", async () => {
  const prompt = asPersona(await readFile(join(root, 'agent', 'brain-prompt.md'), 'utf8'), 'luke')
  assert.match(prompt, /^Você é o Luke, o assistente de voz/)
  assert.match(prompt, /Seu nome é Luke\. Você é um homem de 22 anos, e bonito\./)
  assert.match(prompt, /Fale de si no masculino/)
  assert.match(prompt, /Você foi criado por Diego Morais/)
  assert.doesNotMatch(prompt, /Ceci|mulher|linda|feminino|pronta|criada/)
  // The name's origin is Ceci's alone: Luke says he does not know his name's story.
  assert.doesNotMatch(prompt, /Cecília|homenagem|Lukelia/)
  assert.match(prompt, /Se perguntarem de onde vem o seu nome, diga com leveza que não conhece essa história, sem inventar\./)
  // So is the day she was created: Luke says he does not know his date.
  assert.doesNotMatch(prompt, /21 de novembro|esposa/)
  assert.match(prompt, /Se perguntarem quando você foi criado, diga com leveza que não sabe a data, sem inventar\./)
  // The conversation still marks the assistant's own lines "ceci:" (brainInput in the mod).
  assert.match(prompt, /"ceci:"/)
})

test("Luke's small talk and router prompt", () => {
  const all = asPersona(JSON.stringify(REPLIES), 'luke')
  assert.doesNotMatch(all, /Ceci|Pronta|ótima|obrigada|animada/)
  assert.match(all, /Eu sou o Luke!/)
  assert.match(all, /Estou ótimo, obrigado!/)
  const router = asPersona(ROUTER_SYSTEM, 'luke')
  assert.match(router, /um assistente de voz chamado Luke/)
  assert.doesNotMatch(router, /Ceci/)
})

test("Nara's brain prompt is Ceci's with her name: still a woman, in the feminine", async () => {
  const prompt = asPersona(await readFile(join(root, 'agent', 'brain-prompt.md'), 'utf8'), 'nara')
  assert.match(prompt, /^Você é a Nara, a assistente de voz/)
  assert.match(prompt, /Seu nome é Nara\. Você é uma mulher de 22 anos, e linda\./)
  assert.match(prompt, /Fale de si no feminino/)
  assert.doesNotMatch(prompt, /Ceci/)
  assert.doesNotMatch(prompt, /Cecília|homenagem|Narália|21 de novembro|esposa/)
  assert.match(prompt, /Se perguntarem quando você foi criada, diga com leveza que não sabe a data, sem inventar\./)
  assert.match(prompt, /Se perguntarem de onde vem o seu nome, diga com leveza que não conhece essa história, sem inventar\./)
  assert.match(prompt, /"ceci:"/)
  assert.match(asPersona(JSON.stringify(REPLIES), 'nara'), /Eu sou a Nara!/)
})
