// How Ceci opens a call: "bom dia", "boa tarde" or "boa noite" by the clock, who she is, and a
// question about what we are doing, in a different way each call, so a call does not start with
// the same words every time. Both voices use this list: the local engine says one, and the
// ElevenLabs engine sends one as the agent's first message (agent/agent.json allows that override;
// its own first_message is "Oi!" and the first line here).
// Lines name her only as "a Ceci", so Luke ("o Luke") and Nara are a plain replacement.

export const GREETINGS = [
  'Eu sou a Ceci. O que vamos fazer hoje?',
  'Aqui é a Ceci. Em que posso ajudar?',
  'Que bom te ouvir! Aqui é a Ceci. O que você deseja?',
  'Tudo bem? Eu sou a Ceci. O que a gente vai fazer hoje?',
  'Quem fala é a Ceci. Qual é o plano para hoje?',
  'Aqui é a Ceci, na escuta. Em que posso te ajudar hoje?',
  'Eu sou a Ceci. Por onde vamos começar hoje?',
  'Que alegria te ouvir! Aqui é a Ceci. O que vamos fazer hoje?',
  'Eu sou a Ceci. O que você deseja hoje?',
  'Aqui é a Ceci, com toda a energia. Em que posso ajudar?',
]

const LAST_KEY = 'luke-voice:last-greeting'

// "Bom dia" until noon, "Boa tarde" until 6 pm, "Boa noite" after that and before 5 am.
export function salutation(hour) {
  if (hour >= 5 && hour < 12) return 'Bom dia'
  if (hour >= 12 && hour < 18) return 'Boa tarde'
  return 'Boa noite'
}

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

// The line in the assistant's name: Ceci as written, Luke and João as "o Luke" and "o João", Nara by name.
export function asName(line, name = 'Ceci') {
  if (name === 'Luke' || name === 'João') return line.replace('a Ceci', `o ${name}`)
  return name === 'Ceci' ? line : line.replace('Ceci', name)
}

// A greeting for this time of day, with a line other than the one said last time.
export function pickGreeting({ name = 'Ceci', random = Math.random, storage = globalThis.localStorage, now = new Date() } = {}) {
  const last = lastIndex(storage)
  const choices = GREETINGS.map((_, at) => at).filter(at => at !== last)
  const at = choices[Math.min(choices.length - 1, Math.floor(random() * choices.length))]
  remember(storage, at)
  return `${salutation(now.getHours())}! ${asName(GREETINGS[at], name)}`
}
