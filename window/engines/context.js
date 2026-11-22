// What the brain reads of the call on every turn: the newest entries, short, paid in tokens.
const MAX_CONTEXT = 8
const MAX_CONTEXT_CHARS = 3000
// The hub cuts each entry to this anyway (hub/server.mjs); cut here first, or one long entry
// alone is over MAX_CONTEXT_CHARS and the loop below empties the whole context.
const MAX_ENTRY_CHARS = 1500

export function trimContext(list, text) {
  list.push(String(text).slice(0, MAX_ENTRY_CHARS))
  while (list.length > MAX_CONTEXT || list.join('\n').length > MAX_CONTEXT_CHARS) list.shift()
  return list
}
