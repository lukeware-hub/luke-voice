// How Ceci opens a call. Every line says who she is and asks what we are doing today, in a
// different way, so a call does not start with the same words every time. Both voices use this
// list: the local engine says one, and the ElevenLabs engine sends one as the agent's first message
// (agent/agent.json allows that override; its own first_message is the first line here).
// Lines name her only as "a Ceci", so Luke ("o Luke") and Nara are a plain replacement.

export const GREETINGS = [
  'Oi! Eu sou a Ceci. O que vamos fazer hoje?',
  'Olá! Aqui é a Ceci. O que vamos fazer hoje?',
  'Oi, tudo bem? Eu sou a Ceci. O que a gente vai fazer hoje?',
  'Oi! Quem fala é a Ceci. Qual é o plano para hoje?',
  'E aí! Aqui é a Ceci. O que vamos fazer hoje?',
  'Olá, eu sou a Ceci. Por onde vamos começar hoje?',
  'Oi! Aqui é a Ceci, na escuta. O que vamos fazer hoje?',
  'Que bom te ouvir! Eu sou a Ceci. O que vamos fazer hoje?',
  'Oi! Eu sou a Ceci. Em que vamos trabalhar hoje?',
  'Olá! Aqui é a Ceci. O que você quer fazer hoje?',
]

const LAST_KEY = 'luke-voice:last-greeting'

// The line said last, from this browser; -1 when unknown (a private window, blocked storage).
function lastIndex(storage) {
  try {
    const at = Number(storage?.getItem(LAST_KEY))
    return Number.isInteger(at) ? at : -1
  } catch {
    return -1
  }
}

function remember(storage, at) {
  try {
    storage?.setItem(LAST_KEY, String(at))
  } catch {
    // Nothing kept: the next call may repeat this line, which is fine.
  }
}

// The line in the assistant's name: Ceci as written, Luke as "o Luke", Nara by name.
export function asName(line, name = 'Ceci') {
  if (name === 'Luke') return line.replace('a Ceci', 'o Luke')
  return name === 'Ceci' ? line : line.replace('Ceci', name)
}

// A greeting other than the one said last time.
export function pickGreeting({ name = 'Ceci', random = Math.random, storage = globalThis.localStorage } = {}) {
  const last = lastIndex(storage)
  const choices = GREETINGS.map((_, at) => at).filter(at => at !== last)
  const at = choices[Math.min(choices.length - 1, Math.floor(random() * choices.length))]
  remember(storage, at)
  return asName(GREETINGS[at], name)
}
