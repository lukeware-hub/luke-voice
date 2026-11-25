// What a brain reply may do. A tool that acts on the computer runs only on the user's "sim" to a
// "posso?" (the fast path in local.js), never straight from the brain: not on a notice, and not on
// a user turn either, even if the model forgot to ask first.

// Tools that act on the computer: only these can wait for a "sim" (PENDABLE_TOOLS in hooks/register.tsx).
const PENDABLE = ['luke_run_task', 'luke_send_to_claude']
// Said instead of the brain's words when it called an acting tool at once: it did not run yet.
const ASK = {
  luke_run_task: 'Posso rodar essa tarefa?',
  luke_send_to_claude: 'Posso mandar isso para o Claude?',
}
// A "posso?" waits this long for its "sim".
export const PENDING_TTL_MS = 90_000

// -> { action: 'say' | 'pend' | 'run', say, tool?, pending }. `pending` is the new "posso?"
// ({ tool, at }) or null; it replaces the last one, so a notice lets an unanswered one go.
// `answering` is the live "posso?" this user turn answers (liveAction), or null.
export function decide({ kind, reply, now, answering = null }) {
  const say = reply?.say ?? ''
  if (kind !== 'user') return { action: 'say', say, pending: null }
  const tool = reply?.tool ?? null
  // Stopping Claude and reading the activity do not change anything: the user's turn runs them.
  if (tool && !PENDABLE.includes(tool.name)) return { action: 'run', say, tool, pending: null }
  // The user answered Ceci's "posso?" with a yes the fast path did not catch ("pode, Ceci, roda aí"),
  // and the brain read it as a yes: the action Ceci asked about runs now, as she said it (the
  // brain does not see its arguments), with no second question.
  if (tool && answering?.tool?.name === tool.name) return { action: 'run', say, tool: answering.tool, pending: null }
  const wanted = tool ?? (PENDABLE.includes(reply?.pending?.name) ? reply.pending : null)
  if (!wanted) return { action: 'say', say, pending: null }
  return { action: 'pend', say: tool || !say ? ASK[wanted.name] : say, pending: { tool: wanted, at: now } }
}

// The "posso?" a "sim" can still answer, or null once it is too old.
export const liveAction = (pending, now) => (pending && now - pending.at < PENDING_TTL_MS ? pending : null)
