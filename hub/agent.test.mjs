import assert from 'node:assert/strict'
import { test } from 'node:test'

import { ensureVoice } from './agent.mjs'

const VOICE = { voice_id: 'lib-1', public_owner_id: 'owner-1', name: 'Roberta' }

test('a library voice missing from the account is added, and the added id is used', async () => {
  const asked = []
  const request = async (_key, method, path, body) => {
    asked.push(`${method} ${path}`)
    if (method === 'GET') return { voices: [] }
    assert.deepEqual(body, { new_name: 'Roberta' })
    return { voice_id: 'acct-9' }
  }
  assert.equal(await ensureVoice('k', VOICE, request), 'acct-9')
  assert.deepEqual(asked, ['GET /voices?search=Roberta', 'POST /voices/add/owner-1/lib-1'])
})

test('a library voice already in the account is not added again', async () => {
  const asked = []
  const request = async (_key, method, path) => {
    asked.push(`${method} ${path}`)
    return { voices: [{ voice_id: 'acct-9', name: 'Roberta', sharing: { original_voice_id: 'lib-1' } }] }
  }
  assert.equal(await ensureVoice('k', VOICE, request), 'acct-9')
  assert.equal(asked.length, 1)
})

test('the agent definition shipped in agent/ parses and builds a request body', async () => {
  const { readDefinition } = await import('./agent.mjs')
  const root = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')
  const { def, prompt, hash } = await readDefinition(root)
  assert.equal(def.name, 'luke-voice')
  assert.ok(def.tools.some(tool => tool.name === 'luke_run_task'))
  assert.ok(prompt.length > 100)
  assert.match(hash, /^[0-9a-f]{16}$/)
})
