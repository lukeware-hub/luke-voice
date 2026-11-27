import { CLOSE, OPEN } from '../guard.js'

// What the brain reads of the call on every turn: the newest entries, short, paid in tokens.
const MAX_CONTEXT = 8
const MAX_CONTEXT_CHARS = 3000
// The hub cuts each entry to this anyway (hub/server.mjs); cut here first, or one long entry
// alone is over MAX_CONTEXT_CHARS and the loop below empties the whole context.
const MAX_ENTRY_CHARS = 1500

// One entry as the context keeps it: cut to MAX_ENTRY_CHARS. An untrusted block the cut leaves open
// is cut inside and closed again, so what follows it is never read as part of the quoted text.
export function contextEntry(text) {
  const entry = String(text ?? '')
  if (entry.length <= MAX_ENTRY_CHARS) return entry
  const cut = entry.slice(0, MAX_ENTRY_CHARS - CLOSE.length - 1)
  return cut.lastIndexOf(OPEN) > cut.lastIndexOf(CLOSE) ? `${cut}\n${CLOSE}` : entry.slice(0, MAX_ENTRY_CHARS)
}

// Adds an entry and lets the oldest go. `isKept(entry)` marks entries not to let go yet (news a
// queued notice has not read): the oldest other entry goes first, and a kept one only when nothing
// else is left.
export function trimContext(list, text, isKept = () => false) {
  list.push(contextEntry(text))
  while (list.length > MAX_CONTEXT || list.join('\n').length > MAX_CONTEXT_CHARS) {
    const at = list.findIndex(entry => !isKept(entry))
    list.splice(Math.max(0, at), 1)
  }
  return list
}
