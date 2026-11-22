// Who the assistant is: Ceci, or Luke when the Mac speaks with a male voice (a Siri voice or a
// Premium/Enhanced one). Windows, Linux, the natural voice and ElevenLabs are always Ceci.
// agent/persona.json is the one list of what changes, read here and by the mod (hooks/register.tsx).
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const PERSONAS = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'agent', 'persona.json'), 'utf8'))

// 'luke' only on a Mac whose voice is male; 'ceci' everywhere else.
export function personaFor({ platform = process.platform, voice = null, gender = null } = {}) {
  return platform === 'darwin' && voice && gender === 'male' ? 'luke' : 'ceci'
}

// What the window and the mod are told: { key, name, gender }.
export const personaInfo = key => ({ key, name: PERSONAS[key].name, gender: PERSONAS[key].gender })

// A text in the persona's words: Ceci's text as it is, Luke's with every replacement, in order
// (the longer phrases come first in persona.json, so the short ones only catch what is left).
export function asPersona(text, key, personas = PERSONAS) {
  let out = String(text)
  for (const [from, to] of personas[key]?.replace ?? []) out = out.split(from).join(to)
  return out
}
