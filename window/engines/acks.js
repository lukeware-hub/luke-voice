// What Ceci says while the brain thinks, so the user knows she heard: a quick word after a short
// turn, and a listening line after a long one, which the brain takes longer to answer. Never the
// same line twice in a row.

export const QUICK_ACKS = ['Entendi.', 'Uhum, certo.', 'Certo.', 'Hum, tá bom.']
export const LONG_ACKS = ['Deixa eu entender o que você está falando.', 'Entendi, agora deixa eu analisar.', 'Hum, deixa eu ver.']
export const ACKS = [...QUICK_ACKS, ...LONG_ACKS]
// A turn with this many words or more gets a listening line.
export const LONG_TURN_WORDS = 12

export function pickAck(text, last = '', random = Math.random) {
  const words = String(text ?? '').trim().split(/\s+/).filter(Boolean).length
  const lines = (words >= LONG_TURN_WORDS ? LONG_ACKS : QUICK_ACKS).filter(line => line !== last)
  return lines[Math.floor(random() * lines.length)]
}
