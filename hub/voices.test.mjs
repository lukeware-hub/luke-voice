import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { asPersona, personaFromVoice, personaInfo, personasNow, readUserVoices, voiceRegistry } from './persona.mjs'
import { REPLIES } from './router.mjs'

const root = join(import.meta.dirname, '..')
const base = readFileSync(join(root, 'agent', 'brain-prompt.md'), 'utf8')

// A voices folder as the luke-voice-studio skill writes it.
function voicesDir(voices) {
  const dir = mkdtempSync(join(tmpdir(), 'luke-voices-'))
  for (const [id, files] of Object.entries(voices)) {
    mkdirSync(join(dir, id))
    for (const [name, content] of Object.entries(files)) writeFileSync(join(dir, id, name), content)
  }
  return dir
}

test('a user voice needs its clip and transcript; a bad folder name or a missing file is skipped', () => {
  const dir = voicesDir({
    bia: { 'voice.wav': 'RIFF', 'voice.txt': 'Oi.', 'voice.json': JSON.stringify({ name: 'Bia', gender: 'female', age: 30 }) },
    'Sem-Clip': { 'voice.txt': 'Oi.' },
    noclip: { 'voice.txt': 'Oi.' },
    semjson: { 'voice.wav': 'RIFF', 'voice.txt': 'Oi.' },
  })
  const voices = readUserVoices(dir)
  assert.deepEqual(Object.keys(voices), ['bia', 'semjson'])
  assert.equal(voices.bia.name, 'Bia')
  assert.equal(voices.bia.age, 30)
  assert.equal(voices.semjson.gender, '')
  assert.deepEqual(readUserVoices(join(dir, 'nao-existe')), {})
})

test("a man's voice speaks as himself: his name, age, way of being and tastes, nothing of Ceci or Luke", () => {
  const persona = personaFromVoice('rafa', { name: 'Rafa', gender: 'male', age: 41, description: 'calmo e paciente', jeito: 'calmo, paciente e didático.', gostos: 'pescar e cozinhar.' })
  const prompt = asPersona(base, 'rafa', { rafa: persona })
  assert.equal(persona.gender, 'male')
  assert.match(prompt, /^Você é o Rafa, o assistente de voz/)
  assert.match(prompt, /Seu nome é Rafa\. Você é um homem de 41 anos, calmo e paciente\./)
  assert.match(prompt, /Jeito: calmo, paciente e didático\. Sempre ofereça um caminho/)
  assert.match(prompt, /Seus gostos, que são seus de verdade: pescar e cozinhar\./)
  assert.doesNotMatch(prompt, /Ceci|\bLuke\b(?! Voice)|mulher|feminino|Pipoca|academia|churrasco/)
  assert.match(asPersona(JSON.stringify(REPLIES), 'rafa', { rafa: persona }), /Eu tenho 41 anos\./)
})

test("a woman's voice keeps Ceci's way unless told otherwise, with her own name and no tastes borrowed", () => {
  const persona = personaFromVoice('bia', { name: 'Bia', gender: 'female', age: 30 })
  const prompt = asPersona(base, 'bia', { bia: persona })
  assert.match(prompt, /^Você é a Bia, a assistente de voz/)
  assert.match(prompt, /Seu nome é Bia\. Você é uma mulher de 30 anos\./)
  assert.match(prompt, /Fale de si no feminino/)
  assert.match(prompt, /Você não tem gostos pessoais para contar/)
  assert.doesNotMatch(prompt, /Ceci|Cecília|21 de novembro|Pipoca/)
})

test('the registry lists the built-in voices first, then the user voices; a built-in folder only swaps the clip', () => {
  const dir = voicesDir({
    luke: { 'voice.wav': 'RIFF', 'voice.txt': 'Oi.' },
    rafa: { 'voice.wav': 'RIFF', 'voice.txt': 'Oi.', 'voice.json': JSON.stringify({ name: 'Rafa', gender: 'male', age: 41 }) },
  })
  const registry = voiceRegistry(readUserVoices(dir))
  assert.deepEqual(Object.keys(registry), ['ceci', 'luke', 'joao', 'rafa'])
  // Luke keeps his own persona and light voice; only his clip comes from the folder.
  assert.equal(registry.luke.name, 'Luke')
  assert.equal(registry.luke.light, 'pm_alex')
  assert.equal(registry.luke.dir, join(dir, 'luke'))
  assert.deepEqual(personaInfo('rafa', personasNow(registry)), { key: 'rafa', name: 'Rafa', gender: 'male', light: 'pm_alex' })
  // A voice that is gone answers as Ceci.
  assert.equal(personaInfo('sumiu', personasNow(registry)).key, 'ceci')
})
