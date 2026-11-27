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
  assert.match(prompt, /Seu nome é Luke\. Você é um homem de 36 anos, sério e dedicado\./)
  assert.match(prompt, /Jeito: sério, dedicado e confiável/)
  assert.match(prompt, /Fale de si no masculino/)
  assert.match(prompt, /Você foi criado por Diego Morais/)
  // Serious, never Ceci's bubbly cheer.
  assert.doesNotMatch(prompt, /Ceci|mulher|linda|feminino|pronta|criada|garota|alegre demais|Oba!/)
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

test("João's brain prompt is a man's of 45: serious and very cultured, nothing of Ceci or Luke", async () => {
  const prompt = asPersona(await readFile(join(root, 'agent', 'brain-prompt.md'), 'utf8'), 'joao')
  assert.match(prompt, /^Você é o João, o assistente de voz/)
  assert.match(prompt, /Seu nome é João\. Você é um homem de 45 anos, sério e muito culto\./)
  assert.match(prompt, /Jeito: sério, sereno e muito culto/)
  assert.match(prompt, /Fale com eloquência e calma/)
  assert.match(prompt, /Fale de si no masculino/)
  assert.doesNotMatch(prompt, /Ceci|\bLuke\b(?! Voice)|mulher|linda|feminino|pronta|criada|carismática|garota|alegre demais|Oba!/)
  assert.match(asPersona(JSON.stringify(REPLIES), 'joao'), /Eu sou o João!/)
})

test('the small talk says each age, and Luke and João answer it soberly', () => {
  assert.match(JSON.stringify(REPLIES), /Eu tenho 25 anos!/)
  for (const [key, age] of [['luke', 36], ['joao', 45]]) {
    const all = asPersona(JSON.stringify(REPLIES), key)
    assert.match(all, new RegExp(`Eu tenho ${age} anos\\.`))
    assert.doesNotMatch(all, /Oi, oi!|Opa, oi!|Tchau, tchau!|Que nada! Adoro ajudar\.|Tudo lindo por aqui!|Adorei a conversa\./)
  }
})

test("Nara's brain prompt is Ceci's with her name: still a woman, in the feminine", async () => {
  const prompt = asPersona(await readFile(join(root, 'agent', 'brain-prompt.md'), 'utf8'), 'nara')
  assert.match(prompt, /^Você é a Nara, a assistente de voz/)
  assert.match(prompt, /Seu nome é Nara\. Você é uma mulher de 25 anos, e linda\./)
  assert.match(prompt, /Fale de si no feminino/)
  assert.doesNotMatch(prompt, /Ceci/)
  assert.doesNotMatch(prompt, /Cecília|homenagem|Narália|21 de novembro|esposa/)
  assert.match(prompt, /Se perguntarem quando você foi criada, diga com leveza que não sabe a data, sem inventar\./)
  assert.match(prompt, /Se perguntarem de onde vem o seu nome, diga com leveza que não conhece essa história, sem inventar\./)
  assert.match(prompt, /"ceci:"/)
  assert.match(asPersona(JSON.stringify(REPLIES), 'nara'), /Eu sou a Nara!/)
})

test('each voice has tastes of its own, told only when asked, and never borrows the others', async () => {
  const base = await readFile(join(root, 'agent', 'brain-prompt.md'), 'utf8')
  const tastes = text => text.split(/\r?\n/).find(line => line.startsWith('- Seus gostos,')) ?? ''
  const ceci = tastes(base)
  const luke = tastes(asPersona(base, 'luke'))
  const joao = tastes(asPersona(base, 'joao'))
  assert.match(ceci, /unhas.*Pipoca.*bailarina/)
  assert.match(luke, /academia.*churrasco.*Quando garoto.*de jovem/)
  assert.match(joao, /Machado de Assis.*vinil.*Quando garoto.*de jovem/)
  for (const line of [ceci, luke, joao]) assert.match(line, /Só fale disso quando o usuário perguntar de você ou puxar o assunto/)
  for (const line of [luke, joao]) assert.doesNotMatch(line, /Pipoca|unhas|bailarina|maquiagem|amigas/)
  assert.doesNotMatch(joao, /academia|churrasco/)
  assert.match(await readFile(join(root, 'agent', 'prompt.md'), 'utf8'), /- Seus gostos,.*Pipoca/)
})
