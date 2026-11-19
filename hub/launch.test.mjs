import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))

test('a hub the launcher starts gets the API key sent on stdin', async () => {
  const home = mkdtempSync(join(tmpdir(), 'luke-voice-launch-'))
  const port = String(48_000 + Math.floor(Math.random() * 1000))
  const env = { ...process.env, LUKE_VOICE_HOME: home, LUKE_VOICE_PORT: port, ELEVENLABS_API_KEY: '' }
  const run = spawnSync(process.execPath, [join(here, 'launch.mjs')], { env, input: JSON.stringify({ apiKey: 'test-key' }), encoding: 'utf8', timeout: 20_000 })
  assert.match(run.stdout, /"ok":true/)
  try {
    const health = await fetch(`http://127.0.0.1:${port}/health`).then(r => r.json())
    assert.equal(health.hasKey, true)
  } finally {
    const { serviceToken } = JSON.parse(readFileSync(join(home, 'hub.json'), 'utf8'))
    await fetch(`http://127.0.0.1:${port}/shutdown`, { method: 'POST', headers: { authorization: `Bearer ${serviceToken}` } })
  }
})
