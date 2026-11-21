import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

process.env.LUKE_VOICE_HOME = mkdtempSync(join(tmpdir(), 'luke-voice-setup-'))
const { progressPrinter, setup, size, smokeTest } = await import('./setup.mjs')

const sink = (isTTY = false) => {
  const lines = []
  return { lines, out: { isTTY, write: text => lines.push(text) } }
}

test('sizes read like a person would say them', () => {
  assert.equal(size(2_840_000_000), '2.84 GB')
  assert.equal(size(317_000_000), '317 MB')
})

test('in an installer log, progress is printed every 10%, not on every chunk', () => {
  const { lines, out } = sink()
  const print = progressPrinter(out)
  for (let loaded = 0; loaded <= 1000; loaded += 1) print(loaded, 1000, 'modelos')
  assert.ok(lines.length >= 10 && lines.length <= 12, String(lines.length))
  assert.match(lines.at(-1), /Voice models: 100% of/)
})

test('the gpu profile is tested; a failed test says the light voice will be used', async () => {
  const gpu = { profile: 'gpu', reason: 'RTX, 8192 MiB', devices: [{ name: 'Vulkan0', mib: 8192 }], exe: 'llama-server' }
  const passed = sink()
  const ok = await setup({ out: passed.out, prepare: async () => gpu, test: async () => ({ ok: true, ms: 4000, heard: 'Oi, eu sou a Ceci.', problems: [] }) })
  assert.equal(ok.ok, true)
  assert.match(passed.lines.join(''), /Natural voice ready.*Oi, eu sou a Ceci/)
  const failed = sink()
  const asked = []
  const prepare = async options => {
    asked.push(options)
    return options.override === 'light' ? { profile: 'light', reason: options.reason, devices: options.devices } : gpu
  }
  const bad = await setup({ out: failed.out, prepare, test: async () => ({ ok: false, ms: 1, heard: '', problems: ['the tts server did not start'] }) })
  assert.equal(bad.ok, false)
  assert.match(failed.lines.join(''), /tts server did not start[\s\S]*light voice[\s\S]*Light voice ready/)
  // The light profile is saved (prepared) in its place, so calls really use the light voice.
  assert.equal(asked.length, 2)
  assert.equal(asked[1].override, 'light')
  assert.deepEqual(asked[1].devices, gpu.devices)
  assert.match(asked[1].reason, /failed its test: the tts server did not start/)
  assert.equal(bad.fallback.profile, 'light')
  // With no internet for the light voice either, setup still ends and says so.
  const offline = sink()
  const worse = await setup({ out: offline.out, prepare: async o => { if (o.override === 'light') throw new Error('fetch failed'); return gpu }, test: async () => ({ ok: false, ms: 1, heard: '', problems: ['x'] }) })
  assert.equal(worse.ok, false)
  assert.match(offline.lines.join(''), /could not be downloaded either: fetch failed/)
})

test('the light profile needs no test', async () => {
  const { lines, out } = sink()
  let tested = false
  const result = await setup({ out, prepare: async () => ({ profile: 'light', reason: 'no GPU found', devices: [] }), test: async () => (tested = true) })
  assert.equal(result.ok, true)
  assert.equal(tested, false)
  assert.match(lines.join(''), /light voice in the browser \(no GPU found\)/)
})

test('the install test asks the ears with the glossary, so they write "Ceci" and not "assim se"', async () => {
  const { createServer } = await import('node:http')
  const { ASR_GLOSSARY } = await import('./engine.mjs')
  let asrBody = ''
  const server = createServer((req, res) => {
    let body = ''
    req.setEncoding('latin1')
    req.on('data', d => (body += d))
    req.on('end', () => {
      if (req.url === '/v1/audio/speech') return res.end(Buffer.alloc(30_000))
      if (req.url === '/v1/audio/transcriptions') {
        asrBody = Buffer.from(body, 'latin1').toString('utf8')
        // A warm-up call has no "test.wav"; answer it like the real engine would, with nothing.
        return res.end(JSON.stringify({ text: asrBody.includes('test.wav') ? 'language Portuguese<asr_text>Oi, eu sou a Ceci. Estou pronta!' : '' }))
      }
      res.end(JSON.stringify({ choices: [{ message: { content: '{"intent":"greeting"}' } }] }))
    })
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const url = `http://127.0.0.1:${server.address().port}`
  const engine = { start: async () => {}, status: () => ({ tts: true, asr: true, router: true }), warm: async () => {}, url: () => url, stop: () => {} }
  try {
    const result = await smokeTest({ profile: 'gpu' }, { engine, voice: 'missing.wav' })
    assert.equal(result.ok, true, result.problems.join('; '))
    assert.equal(result.heard, 'Oi, eu sou a Ceci. Estou pronta!')
    assert.match(asrBody, /name="prompt"/)
    assert.ok(asrBody.includes(ASR_GLOSSARY), 'the glossary is sent')
  } finally {
    server.close()
  }
})
