// Who the assistant is. On a Mac that speaks with its own voice: Nara with Siri Voz 2 (sandra),
// Luke with a male voice (Siri Voz 1, nando, or a male Premium/Enhanced voice). Ceci everywhere
// else: Windows, Linux, the natural voice, ElevenLabs and the Mac's other voices.
// agent/persona.json is the one list of what changes, read here and by the mod (hooks/register.tsx).
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const PERSONAS = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'agent', 'persona.json'), 'utf8'))

// 'nara' or 'luke' only on a Mac that speaks with its own voice; 'ceci' everywhere else.
export function personaFor({ platform = process.platform, voice = null, gender = null, siri = null } = {}) {
  if (platform !== 'darwin' || !voice) return 'ceci'
  if (siri === 'sandra') return 'nara'
  return gender === 'male' ? 'luke' : 'ceci'
}

// What the window and the mod are told: { key, name, gender }.
export const personaInfo = key => ({ key, name: PERSONAS[key].name, gender: PERSONAS[key].gender })

// A text in the persona's words: Ceci's text as it is, the others' with every replacement, in order
// (the longer phrases come first in persona.json, so the short ones only catch what is left).
export function asPersona(text, key, personas = PERSONAS) {
  let out = String(text)
  for (const [from, to] of personas[key]?.replace ?? []) out = out.split(from).join(to)
  return out
}
