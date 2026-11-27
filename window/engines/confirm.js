// What a brain reply may do. A tool that acts on the computer runs only on the user's "sim" to a
// "ok?" (the fast path in local.js), never straight from the brain: not on a notice, and not on
// a user turn either, even if the model forgot to ask first.

import { isMixed } from './fast-path.js'
import { isNotSpeech } from './transcript.js'

// Tools that act on the computer or delete from the memory: only these can wait for a "sim" (PENDABLE_TOOLS in hooks/register.tsx).
const PENDABLE = ['luke_run_task', 'luke_send_to_claude', 'luke_memory_delete']
// Said instead of the brain's words when it called an acting tool at once: it did not run yet.
const ASK = {
  luke_run_task: 'Rodo essa tarefa, ok?',
  luke_send_to_claude: 'Mando isso para o Claude, ok?',
  luke_memory_delete: 'Apago isso da memória, ok?',
}
// A "ok?" waits this long for its "sim".
export const PENDING_TTL_MS = 90_000
// Said when an answer could not be heard for sure: too soft, mixed with another voice, a noise or
// the room. The "ok?" it answered stays open, so the repeated "sim" still runs it.
export const REPEAT = 'Pode repetir para mim, por favor?'
// How many times Ceci asks it for one "ok?": a TV or a fan that keeps setting off turns must not
// keep her asking. After that, the turn goes as it did before.
export const MAX_REPEATS = 2
const isRepeatAsk = say => /\bpode(?:ria)? repetir\b/i.test(String(say ?? ''))

// The brain's arguments for the tool are the asked ones: none given, or equal in any key order.
const canonical = value =>
  Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value
function sameArgs(given, asked) {
  if (given == null || (typeof given === 'object' && Object.keys(given).length === 0)) return true
  return JSON.stringify(canonical(given)) === JSON.stringify(canonical(asked ?? {}))
}

// -> { action: 'say' | 'pend' | 'run', say, tool?, pending }. `pending` is the new "ok?"
// ({ tool, at }) or null; it replaces the last one, so a notice lets an unanswered one go.
// `answering` is the live "ok?" this user turn answers (liveAction), or null.
export function decide({ kind, reply, now, answering = null }) {
  const say = reply?.say ?? ''
  if (kind !== 'user') return { action: 'say', say, pending: null }
  const tool = reply?.tool ?? null
  // Stopping Claude and reading the activity do not change anything: the user's turn runs them.
  if (tool && !PENDABLE.includes(tool.name)) return { action: 'run', say, tool, pending: null }
  // The user answered Ceci's "ok?" with a yes the fast path did not catch ("pode, Ceci, roda aí"),
  // and the brain read it as a yes: the action Ceci asked about runs now, as she said it, with no
  // second question. Only with the same arguments (or none): other ones are a changed request, and
  // that one asks "ok?" again below instead of running the old action.
  if (tool && answering?.tool?.name === tool.name && sameArgs(tool.args, answering.tool.args)) return { action: 'run', say, tool: answering.tool, pending: null }
  const wanted = tool ?? (PENDABLE.includes(reply?.pending?.name) ? reply.pending : null)
  // The brain could not make out the answer to "ok?" and asks to hear it again: the same
  // action keeps waiting (the brain does not see its arguments, so it cannot ask again itself).
  if (!wanted && answering && isRepeatAsk(say)) return { action: 'say', say, pending: { ...answering, at: now } }
  if (!wanted) return { action: 'say', say, pending: null }
  return { action: 'pend', say: tool || !say ? ASK[wanted.name] : say, pending: { tool: wanted, at: now } }
}

// The "ok?" a "sim" can still answer, or null once it is too old.
export const liveAction = (pending, now) => (pending && now - pending.at < PENDING_TTL_MS ? pending : null)

// Why the answer to the live "ok?" `action` could not be heard for sure, or null: a sound the
// speech check heard no words in (a soft answer lost in a noise), words the ears made up from
// noise, or a yes and a no at once (two voices over each other). Then Ceci says REPEAT and the
// "ok?" stays open (askedAgain). Null with no "ok?" waiting, or once she asked enough.
export function unsureAnswer(action, { noSpeech = false, text = '' } = {}) {
  if (!action || (action.repeats ?? 0) >= MAX_REPEATS) return null
  if (noSpeech) return 'a sound with no clear words after "ok?"'
  if (!text || isNotSpeech(text)) return `no words in "${text}" after "ok?"`
  if (isMixed(text)) return `yes and no at once: "${text.slice(0, 80)}"`
  return null
}

// The same "ok?", fresh again, after Ceci asked to hear its answer once more.
export const askedAgain = (action, now) => ({ ...action, at: now, repeats: (action.repeats ?? 0) + 1 })
