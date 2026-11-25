import assert from 'node:assert/strict'
import { test } from 'node:test'

import { PENDING_TTL_MS, decide, liveAction } from './confirm.js'

const task = { name: 'luke_run_task', args: { task: 'roda os testes' } }
const send = { name: 'luke_send_to_claude', args: { prompt: 'faz o commit' } }
const stop = { name: 'luke_stop_claude', args: {} }
const activity = { name: 'luke_session_activity', args: {} }

test('a notice never runs a tool nor leaves one waiting, and lets the last "posso?" go', () => {
  for (const reply of [{ say: 'Terminou.', tool: task, pending: null }, { say: 'Terminou.', tool: null, pending: send }, { say: 'Terminou.', tool: stop, pending: null }, { say: 'Terminou.', tool: activity, pending: null }]) {
    assert.deepEqual(decide({ kind: 'notice', reply, now: 1 }), { action: 'say', say: 'Terminou.', pending: null })
  }
})

test('a user turn whose reply acts at once ("oi" + tool) only asks; the tool waits for a "sim", unchanged', () => {
  for (const tool of [task, send]) {
    const out = decide({ kind: 'user', reply: { say: 'Comecei, te aviso quando terminar.', tool, pending: null }, now: 5 })
    assert.equal(out.action, 'pend')
    assert.deepEqual(out.pending, { tool, at: 5 })
    // It did not start: Ceci asks instead of saying it did.
    assert.match(out.say, /posso/i)
    assert.doesNotMatch(out.say, /comecei|mandei/i)
  }
})

test('a "posso?" from the brain keeps its words and its tool', () => {
  const out = decide({ kind: 'user', reply: { say: 'Rodo os testes, posso?', tool: null, pending: task }, now: 7 })
  assert.deepEqual(out, { action: 'pend', say: 'Rodo os testes, posso?', pending: { tool: task, at: 7 } })
})

test('a user turn may stop Claude or read the activity at once; anything else lets the "posso?" go', () => {
  assert.deepEqual(decide({ kind: 'user', reply: { say: '', tool: stop, pending: null }, now: 1 }), { action: 'run', say: '', tool: stop, pending: null })
  assert.deepEqual(decide({ kind: 'user', reply: { say: '', tool: activity, pending: null }, now: 1 }), { action: 'run', say: '', tool: activity, pending: null })
  assert.deepEqual(decide({ kind: 'user', reply: { say: 'Oi!', tool: null, pending: null }, now: 1 }), { action: 'say', say: 'Oi!', pending: null })
  // A pending tool that does not act is not kept.
  assert.deepEqual(decide({ kind: 'user', reply: { say: 'Oi!', tool: null, pending: stop }, now: 1 }), { action: 'say', say: 'Oi!', pending: null })
})

test('a "sim" runs the waiting tool only while it is fresh; an old one after a notice finds nothing', () => {
  const asked = decide({ kind: 'user', reply: { say: 'Posso?', tool: null, pending: task }, now: 1000 }).pending
  assert.equal(liveAction(asked, 1000 + PENDING_TTL_MS - 1), asked)
  assert.equal(liveAction(asked, 1000 + PENDING_TTL_MS), null)
  // The notice cleared it: the old "sim" has nothing to run.
  const afterNotice = decide({ kind: 'notice', reply: { say: 'Terminou.', tool: null, pending: null }, now: 2000 }).pending
  assert.equal(liveAction(afterNotice, 2001), null)
})

test('a yes the fast path missed, read as a yes by the brain, runs the action Ceci asked about, with no second "posso?"', () => {
  const asked = { tool: task, at: 1 }
  // The brain does not see the pending arguments: what runs is what Ceci asked about.
  const out = decide({ kind: 'user', reply: { say: 'Comecei!', tool: { name: 'luke_run_task', args: { task: 'outra coisa' } }, pending: null }, now: 2, answering: asked })
  assert.deepEqual(out, { action: 'run', say: 'Comecei!', tool: task, pending: null })
  // Another acting tool than the one asked about still only asks.
  assert.equal(decide({ kind: 'user', reply: { say: '', tool: send, pending: null }, now: 2, answering: asked }).action, 'pend')
  // With no "posso?" waiting, it still only asks.
  assert.equal(decide({ kind: 'user', reply: { say: '', tool: task, pending: null }, now: 2 }).action, 'pend')
  // A notice never runs it, whatever it answers.
  assert.equal(decide({ kind: 'notice', reply: { say: '', tool: task, pending: null }, now: 2, answering: asked }).action, 'say')
  // A change asked with the yes goes back to "posso?" with the new arguments.
  const changed = { name: 'luke_run_task', args: { task: 'só na pasta site' } }
  assert.deepEqual(decide({ kind: 'user', reply: { say: 'Só na pasta site, posso?', tool: null, pending: changed }, now: 3, answering: asked }).pending, { tool: changed, at: 3 })
})

test('deleting from the memory waits for a "sim", like the tools that act on the computer; reading it runs at once', () => {
  const del = { name: 'luke_memory_delete', args: { conversation: 3 } }
  const asked = decide({ kind: 'user', reply: { say: 'Apago a conversa #3, posso?', tool: null, pending: del }, now: 1 })
  assert.deepEqual(asked, { action: 'pend', say: 'Apago a conversa #3, posso?', pending: { tool: del, at: 1 } })
  // Called at once, it only asks.
  const atOnce = decide({ kind: 'user', reply: { say: 'Apaguei.', tool: del, pending: null }, now: 2 })
  assert.equal(atOnce.action, 'pend')
  assert.match(atOnce.say, /posso apagar/i)
  // A notice never deletes.
  assert.equal(decide({ kind: 'notice', reply: { say: '', tool: del, pending: null }, now: 3 }).action, 'say')
  const search = { name: 'luke_memory_search', args: { query: 'girassol' } }
  assert.equal(decide({ kind: 'user', reply: { say: '', tool: search, pending: null }, now: 4 }).action, 'run')
})
