import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { dayOf, ftsQuery, openMemory, rangeOf } from './memory.mjs'

const DAY = 86_400_000
const fresh = () => mkdtempSync(join(tmpdir(), 'ceci-memory-'))
const clockAt = start => {
  let t = start
  const now = () => t
  now.advance = ms => (t += ms)
  now.set = ms => (t = ms)
  return now
}

test('the memory is created when missing and kept, untouched, when it is there', () => {
  const dir = fresh()
  assert.equal(existsSync(join(dir, 'memory.db')), false)
  const now = clockAt(Date.parse('2026-01-05T10:00:00'))
  let memory = openMemory({ dir, now })
  assert.equal(existsSync(join(dir, 'memory.db')), true)
  memory.startCall({ persona: 'ceci' })
  memory.append({ kind: 'user', text: 'Oi Ceci, lembra da Lagoa de Alcaçuz?' })
  memory.append({ kind: 'ceci', text: 'Lembro sim!' })
  memory.endCall()
  memory.close()
  // Opened again (a new hub, an update): nothing is lost.
  memory = openMemory({ dir, now })
  assert.equal(memory.stats().events, 2)
  assert.equal(memory.conversation('first').items.length, 2)
  memory.close()
})

test('search finds words with or without accents, and leaves out empty words', () => {
  const memory = openMemory({ dir: fresh(), now: clockAt(Date.parse('2026-02-01T09:00:00')) })
  memory.startCall()
  memory.append({ kind: 'user', text: 'A Lagoa de Alcaçuz fica em Natal.' })
  memory.append({ kind: 'user', text: 'Roda os testes de pagamento.' })
  assert.equal(memory.search('alcacuz')[0].text, 'A Lagoa de Alcaçuz fica em Natal.')
  assert.equal(memory.search('ALCAÇUZ')[0].text, 'A Lagoa de Alcaçuz fica em Natal.')
  assert.equal(memory.search('o que a gente falou de pagamento?')[0].text, 'Roda os testes de pagamento.')
  assert.deepEqual(memory.search('o que a gente'), [])
  // FTS syntax in what the user says is only words.
  assert.equal(ftsQuery('deploy" OR NEAR(x'), '"deploy" OR "or" OR "near"')
  memory.close()
})

test('the very first conversation is found after ten thousand later events', () => {
  const now = clockAt(Date.parse('2025-03-01T08:00:00'))
  const memory = openMemory({ dir: fresh(), now })
  memory.startCall()
  memory.append({ kind: 'user', text: 'Meu primeiro projeto se chama Girassol.' })
  memory.endCall()
  for (let i = 0; i < 100; i++) {
    now.advance(DAY)
    memory.startCall()
    for (let j = 0; j < 100; j++) memory.append({ kind: j % 2 ? 'ceci' : 'user', text: `conversa ${i} linha ${j} sobre testes e deploy` })
    memory.endCall()
  }
  const first = memory.conversation('first')
  assert.equal(first.day, '2025-03-01')
  assert.equal(first.items[0].text, 'Meu primeiro projeto se chama Girassol.')
  assert.equal(memory.search('girassol')[0].day, '2025-03-01')
  assert.equal(memory.conversation('2025-03-01').items[0].text, 'Meu primeiro projeto se chama Girassol.')
  assert.equal(memory.stats().events, 10_001)
  memory.close()
})

test('talk goes into the call; session activity with no call goes into the day background', () => {
  const now = clockAt(Date.parse('2026-03-02T10:00:00'))
  const memory = openMemory({ dir: fresh(), now })
  memory.append({ kind: 'session_tool', text: 'Bash: npm test', session: 'api', untrusted: true })
  const call = memory.startCall()
  memory.append({ kind: 'user', text: 'oi' })
  assert.equal(memory.conversation(call).items.length, 1)
  memory.endCall()
  now.advance(60_000)
  // Talk with no call open (a window that did not say it started) opens one; a long silence another.
  memory.append({ kind: 'user', text: 'tá aí?' })
  now.advance(2 * 60 * 60_000)
  memory.append({ kind: 'user', text: 'voltei' })
  assert.equal(memory.conversations().length, 3)
  const background = memory.conversations({ includeBackground: true }).find(c => c.kind === 'background')
  assert.equal(background.events, 1)
  assert.equal(memory.search('npm')[0].untrusted, true)
  memory.close()
})

test('the digest carries the life summary, the last conversations and hits from other conversations', () => {
  const now = clockAt(Date.parse('2026-04-01T10:00:00'))
  const memory = openMemory({ dir: fresh(), now })
  memory.startCall()
  memory.append({ kind: 'user', text: 'O banco de produção é Postgres.' })
  memory.endCall()
  now.advance(DAY)
  memory.startCall()
  memory.append({ kind: 'user', text: 'qual é o banco de produção?' })
  const digest = memory.digest('qual é o banco de produção?')
  // The utterance itself, in the call now, is not a memory of it.
  assert.deepEqual(digest.hits.map(h => h.text), ['O banco de produção é Postgres.'])
  assert.equal(digest.firstDay, '2026-04-01')
  assert.equal(digest.recent.length, 2)
  assert.equal(digest.life, null)
  memory.close()
})

test('summaries climb from conversation to day to month to life, and nothing is left behind', () => {
  const now = clockAt(Date.parse('2026-05-10T10:00:00'))
  const memory = openMemory({ dir: fresh(), now })
  memory.startCall()
  memory.append({ kind: 'user', text: 'Vamos migrar o banco.' })
  memory.endCall()
  now.set(Date.parse('2026-06-02T10:00:00'))
  const write = () => {
    for (let round = 0; round < 10; round++) {
      const items = memory.pendingSummaries()
      if (items.length === 0) return
      for (const item of items) assert.equal(memory.saveSummary({ ...item, text: `resumo ${item.level} ${item.period}`, title: item.level === 'conversation' ? 'Migração do banco' : null }), true)
    }
  }
  write()
  const levels = ['conversation', 'day', 'month', 'life']
  const life = memory.digest().life
  assert.equal(life, 'resumo life all')
  assert.equal(memory.timeline({ from: rangeOf('2026-05')[0], to: rangeOf('2026-05')[1] }).months[0].text, 'resumo month 2026-05')
  assert.equal(memory.conversations()[0].title, 'Migração do banco')
  assert.deepEqual(memory.pendingSummaries(), [])
  assert.ok(levels)
  // A new conversation makes the life summary stale again, once it has its own summary.
  memory.startCall()
  memory.append({ kind: 'user', text: 'Agora o deploy.' })
  memory.endCall()
  now.advance(2 * 60_000)
  assert.deepEqual(memory.pendingSummaries().map(i => i.level), ['conversation'])
  write()
  assert.equal(memory.pendingSummaries().length, 0)
  memory.close()
})

test('a delete removes the events, their index, the summaries over them, and the bytes on disk', () => {
  const dir = fresh()
  const now = clockAt(Date.parse('2026-07-01T10:00:00'))
  const memory = openMemory({ dir, now })
  memory.startCall()
  memory.append({ kind: 'user', text: 'A senha do wifi é PalavraSecretaXYZ.' })
  memory.append({ kind: 'user', text: 'Outra coisa sem segredo.' })
  const secret = memory.conversation('first').id
  memory.endCall()
  now.advance(DAY)
  memory.startCall()
  memory.append({ kind: 'user', text: 'Conversa que fica.' })
  memory.endCall()
  now.advance(DAY)
  for (const item of memory.pendingSummaries({ max: 10 })) memory.saveSummary({ ...item, text: item.text.includes('PalavraSecretaXYZ') ? 'fala de PalavraSecretaXYZ' : 'outro resumo' })
  assert.deepEqual(memory.preview({ conversation: secret }), { events: 2, conversations: 1, firstDay: '2026-07-01', lastDay: '2026-07-01' })
  assert.deepEqual(memory.deleteMemory({ conversation: secret }, { how: 'voice' }), { deleted: 2 })
  assert.deepEqual(memory.search('PalavraSecretaXYZ'), [])
  assert.equal(memory.conversation(secret), null)
  assert.equal(memory.stats().events, 1)
  memory.close()
  for (const name of ['memory.db', 'memory.db-wal']) {
    const path = join(dir, name)
    if (existsSync(path)) assert.equal(readFileSync(path).includes('PalavraSecretaXYZ'), false, name)
  }
})

test('every kind of scope deletes only what it names; an unknown scope deletes nothing', () => {
  const now = clockAt(Date.parse('2026-08-01T10:00:00'))
  const memory = openMemory({ dir: fresh(), now })
  for (let i = 0; i < 3; i++) {
    memory.startCall()
    memory.append({ kind: 'user', text: `dia ${i} falando de deploy` })
    memory.append({ kind: 'ceci', text: `resposta ${i}` })
    memory.endCall()
    now.advance(DAY)
  }
  assert.deepEqual(memory.deleteMemory({}), { deleted: 0 })
  assert.deepEqual(memory.deleteMemory({ nonsense: 1 }), { deleted: 0 })
  assert.deepEqual(memory.deleteMemory({ search: '' }), { deleted: 0 })
  assert.deepEqual(memory.deleteMemory({ day: '2026-08-01' }), { deleted: 2 })
  assert.deepEqual(memory.deleteMemory({ search: 'resposta' }), { deleted: 2 })
  assert.deepEqual(memory.deleteMemory({ from: '2026-08-03', to: '2026-08-03' }), { deleted: 1 })
  assert.equal(memory.stats().events, 1)
  assert.deepEqual(memory.deleteMemory({ all: true }), { deleted: 1 })
  assert.equal(memory.stats().events, 0)
  memory.close()
})

test('events that could not be written wait in pending.jsonl and are moved in, as calls, on the next open', () => {
  const dir = fresh()
  const at = Date.parse('2026-09-01T10:00:00')
  const lines = [
    { kind: 'user', text: 'primeira fala', at },
    { kind: 'ceci', text: 'resposta', at: at + 1000 },
    { kind: 'session_tool', text: 'Bash: ls', at: at + 2000, untrusted: true },
    { kind: 'user', text: 'outra conversa', at: at + 3 * 60 * 60_000 },
  ]
  writeFileSync(join(dir, 'pending.jsonl'), `${lines.map(l => JSON.stringify(l)).join('\n')}\n{"torn`)
  const memory = openMemory({ dir, now: () => at + DAY })
  assert.equal(existsSync(join(dir, 'pending.jsonl')), false)
  assert.equal(memory.stats().events, 4)
  assert.equal(memory.conversations().length, 2)
  assert.equal(memory.conversation('first').items.map(i => i.text).join(' / '), 'primeira fala / resposta')
  memory.close()
})

test('dates are the user\'s own calendar days and months', () => {
  assert.equal(dayOf(Date.parse('2026-12-31T23:30:00')), '2026-12-31')
  const [from, to] = rangeOf('2026-02')
  assert.equal(dayOf(from), '2026-02-01')
  assert.equal(dayOf(to), '2026-03-01')
  assert.equal(rangeOf('ontem'), null)
})

test('words the window sends after the call closed still go into that call', () => {
  const now = clockAt(Date.parse('2026-10-01T10:00:00'))
  const memory = openMemory({ dir: fresh(), now })
  const call = memory.startCall()
  const said = now()
  now.advance(500)
  memory.endCall()
  now.advance(800)
  memory.append({ kind: 'ceci', text: 'Tchau!', at: said })
  assert.equal(memory.conversations().length, 1)
  assert.equal(memory.conversation(call).items[0].text, 'Tchau!')
  memory.close()
})
