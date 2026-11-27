// Who the assistant is. On a Mac that speaks with its own voice: Nara with Siri Voz 2 (sandra),
// Luke with a male voice (Siri Voz 1, nando, or a male Premium/Enhanced voice). Everywhere else, the
// voice the user picked in Configurações: Ceci, Luke, João, or one of their own voices.
// agent/persona.json is the list of what changes for the built-in voices, read here and by the mod
// (hooks/register.tsx). The user's own voices live in ~/.luke-voice/voices/<id>/ (made by the
// luke-voice-studio skill), so an update of the plugin never removes them.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { stateDir } from './paths.mjs'

const AGENT = join(dirname(fileURLToPath(import.meta.url)), '..', 'agent')
export const PERSONAS = JSON.parse(readFileSync(join(AGENT, 'persona.json'), 'utf8'))

// 'nara' or 'luke' only on a Mac that speaks with its own voice; 'ceci' everywhere else.
export function personaFor({ platform = process.platform, voice = null, gender = null, siri = null } = {}) {
  if (platform !== 'darwin' || !voice) return 'ceci'
  if (siri === 'sandra') return 'nara'
  return gender === 'male' ? 'luke' : 'ceci'
}

// The voices that come with the plugin, in the order the window shows them; the user's own follow.
export const ASSISTANTS = ['ceci', 'luke', 'joao']
// The light voice (Kokoro, in the browser) of each built-in voice; a user voice gets one by gender.
const LIGHT = { ceci: 'pf_dora', luke: 'pm_alex', joao: 'pm_santa', nara: 'pf_dora' }
const LIGHT_VOICES = ['pf_dora', 'pm_alex', 'pm_santa']
// A user voice's folder name: lower case letters, digits and dashes, as the studio skill writes it.
export const VOICE_ID = /^[a-z0-9][a-z0-9-]{0,31}$/

export const userVoicesDir = () => join(stateDir(), 'voices')

const text = (value, max) => (typeof value === 'string' ? value.replace(/\s+/g, ' ').trim().slice(0, max) : '')

// The user's own voices: voices/<id>/voice.wav, voice.txt and voice.json ({ name, gender, age,
// description, jeito, fala, gostos, light }). A folder with no clip or no transcript is skipped. A
// folder named like a built-in voice (ceci, luke, joao) only replaces that voice's clip, unless its
// voice.json gives a new name.
export function readUserVoices(dir = userVoicesDir()) {
  const voices = {}
  let names = []
  try {
    names = readdirSync(dir)
  } catch {
    return voices
  }
  for (const id of names.sort()) {
    const folder = join(dir, id)
    if (!VOICE_ID.test(id) || !statSync(folder, { throwIfNoEntry: false })?.isDirectory()) continue
    if (!existsSync(join(folder, 'voice.wav')) || !existsSync(join(folder, 'voice.txt'))) continue
    let meta = {}
    try {
      meta = JSON.parse(readFileSync(join(folder, 'voice.json'), 'utf8'))
    } catch {
      meta = {}
    }
    const age = Number.parseInt(meta.age, 10)
    voices[id] = {
      dir: folder,
      name: text(meta.name, 40),
      gender: meta.gender === 'male' || meta.gender === 'female' ? meta.gender : '',
      age: age >= 1 && age <= 120 ? age : null,
      description: text(meta.description, 120),
      jeito: text(meta.jeito, 900),
      fala: text(meta.fala, 600),
      gostos: text(meta.gostos, 900),
      light: LIGHT_VOICES.includes(meta.light) ? meta.light : '',
    }
  }
  return voices
}

// Ceci's own lines that a persona rewrites whole, found by how they start (they are the keys of the
// built-in personas in persona.json).
const cecisLine = start => PERSONAS.luke.replace.find(([from]) => from.startsWith(start))?.[0] ?? null
const TAIL = 'Sempre ofereça um caminho: responda o que sabe ou diga qual é o próximo passo.'

// The persona of a user voice, in the same shape as persona.json: Ceci's text rewritten for that
// voice. A man starts from Luke's words, a woman from Ceci's; the name, age, way of being, way of
// speaking and tastes the user gave replace the defaults. Without tastes, the voice has none of its
// own to tell (it never borrows another voice's).
export function personaFromVoice(id, voice) {
  const isMale = voice.gender === 'male'
  const name = voice.name || id
  const age = voice.age ?? (isMale ? 36 : 25)
  const who = `${isMale ? 'um homem' : 'uma mulher'} de ${age} anos${voice.description ? `, ${voice.description}` : ''}`
  const own = [
    ['Seu nome é Ceci. Você é uma mulher de 25 anos, e linda.', `Seu nome é ${name}. Você é ${who}.`],
    ['que é uma mulher de 25 anos, linda.', `que é ${who}.`],
    ['Eu tenho 25 anos!', `Eu tenho ${age} anos${isMale ? '.' : '!'}`],
    [cecisLine('Seus gostos,'), voice.gostos ? `Seus gostos, que são seus de verdade: ${voice.gostos} Só fale disso quando o usuário perguntar de você ou puxar o assunto, em uma frase, e nunca invente outros gostos.` : 'Você não tem gostos pessoais para contar: se perguntarem, diga com leveza que prefere falar do trabalho, sem inventar.'],
  ]
  if (voice.jeito) own.push([cecisLine('Jeito:'), `Jeito: ${voice.jeito} ${TAIL}`])
  if (voice.fala) own.push([cecisLine('Fale como gente'), `Fale assim: ${voice.fala}`])
  const ownKeys = new Set(own.map(([from]) => from))
  // A man: Luke's rewriting of Ceci's text, with his name; a woman: Nara's (Ceci's words, her own
  // name, no story of Ceci's name or birthday).
  const base = (isMale ? PERSONAS.luke.replace : PERSONAS.nara.replace)
    .filter(([from]) => !ownKeys.has(from))
    .map(([from, to]) => [from, isMale ? to.split('Luke').join(name) : to === 'Nara' ? name : to])
  return { name, gender: isMale ? 'male' : 'female', replace: [...own.filter(([from]) => from), ...base] }
}

// Every voice the user can pick, built-in first: { [id]: persona } with the persona.json shape plus
// `light` (the Kokoro voice) and `dir` (a user voice's folder, also for a built-in whose clip the user
// replaced).
export function voiceRegistry(user = readUserVoices()) {
  const all = {}
  for (const id of ASSISTANTS) all[id] = { ...PERSONAS[id], light: LIGHT[id] }
  for (const [id, voice] of Object.entries(user)) {
    const isBuiltIn = ASSISTANTS.includes(id)
    const persona = isBuiltIn && !voice.name ? all[id] : personaFromVoice(id, voice)
    all[id] = { ...persona, light: voice.light || (isBuiltIn && !voice.gender ? LIGHT[id] : persona.gender === 'male' ? 'pm_alex' : 'pf_dora'), dir: voice.dir }
  }
  return all
}

// The personas text is rewritten with: the built-in ones (Nara too) and the user's voices.
export const personasNow = (registry = voiceRegistry()) => ({ ...PERSONAS, ...registry })

// What the window and the mod are told: { key, name, gender, light }.
export function personaInfo(key, personas = personasNow()) {
  const persona = personas[key] ?? PERSONAS.ceci
  return { key: personas[key] ? key : 'ceci', name: persona.name, gender: persona.gender, light: persona.light ?? LIGHT[key] ?? 'pf_dora' }
}

// A text in the persona's words: Ceci's text as it is, the others' with every replacement, in order
// (the longer phrases come first in persona.json, so the short ones only catch what is left).
export function asPersona(text, key, personas = PERSONAS) {
  let out = String(text)
  for (const [from, to] of personas[key]?.replace ?? []) out = out.split(from).join(to)
  return out
}
