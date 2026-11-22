import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))

test('a hub the launcher starts gets the API key and the voice sent on stdin, and a big hub.log is set aside', async () => {
  const home = mkdtempSync(join(tmpdir(), 'luke-voice-launch-'))
  writeFileSync(join(home, 'hub.log'), 'x'.repeat(5 * 1024 * 1024 + 1))
  const port = String(48_000 + Math.floor(Math.random() * 1000))
  const env = { ...process.env, LUKE_VOICE_HOME: home, LUKE_VOICE_PORT: port, ELEVENLABS_API_KEY: '', LUKE_VOICE_PROVIDER: '', LUKE_VOICE_ENGINE: 'off' }
  const run = spawnSync(process.execPath, [join(here, 'launch.mjs')], { env, input: JSON.stringify({ apiKey: 'test-key', provider: 'local' }), encoding: 'utf8', timeout: 20_000 })
  assert.match(run.stdout, /"ok":true/)
  assert.equal(statSync(join(home, 'hub.old.log')).size, 5 * 1024 * 1024 + 1)
  assert.ok(!existsSync(join(home, 'hub.log')) || statSync(join(home, 'hub.log')).size < 1024 * 1024)
  try {
    const health = await fetch(`http://127.0.0.1:${port}/health`).then(r => r.json())
    assert.equal(health.hasKey, true)
    // With a key the hub would pick ElevenLabs; local proves the choice reached it.
    assert.equal(health.provider, 'local')
  } finally {
    const { serviceToken } = JSON.parse(readFileSync(join(home, 'hub.json'), 'utf8'))
    await fetch(`http://127.0.0.1:${port}/shutdown`, { method: 'POST', headers: { authorization: `Bearer ${serviceToken}` } })
  }
})
