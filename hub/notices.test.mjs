import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { createNotices } from './notices.mjs'

test('a result is kept until the window acks it, and survives a hub restart', () => {
  const file = join(mkdtempSync(join(tmpdir(), 'luke-voice-notices-')), 'notices.json')
  const notices = createNotices({ file })
  const first = notices.add('api', 'Task: rodar os testes\nResult: passaram')
  // The same result again is the same notice, not a second one to say.
  assert.equal(notices.add('api', 'Task: rodar os testes\nResult: passaram').id, first.id)
  const second = notices.add('web', 'Task: build\nResult: ok')
  assert.deepEqual(notices.pending().map(n => n.id), [first.id, second.id])
  // A new hub reads what was kept, and numbers new notices after it.
  const again = createNotices({ file })
  assert.deepEqual(again.pending().map(n => n.text), [first.text, second.text])
  assert.notEqual(again.add('api', 'Task: lint\nResult: ok').id, first.id)
  assert.equal(again.ack(first.id), true)
  assert.equal(again.ack(first.id), false)
  assert.deepEqual(createNotices({ file }).pending().map(n => n.session), ['web', 'api'])
})

test('a result too old to be news is dropped instead of said', () => {
  let now = 0
  const notices = createNotices({ clock: () => now, maxAgeMs: 1000 })
  notices.add('api', 'old')
  now = 500
  notices.add('api', 'new')
  now = 1200
  assert.deepEqual(notices.pending().map(n => n.text), ['new'])
})
