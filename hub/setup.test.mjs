import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

process.env.LUKE_VOICE_HOME = mkdtempSync(join(tmpdir(), 'luke-voice-setup-'))
const { checkSpace, explain, hubRunsVoice, progressPrinter, setup, size, smokeTest } = await import('./setup.mjs')
// No hub runs the natural voice in these tests (a real one may run on this machine).
const noHub = async () => false

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
  assert.match(lines.at(-1), /Modelos de voz: 100% de/)
})

test('the gpu profile is tested; a failed test says the light voice will be used', async () => {
  const gpu = { profile: 'gpu', reason: 'RTX, 8192 MiB', devices: [{ name: 'Vulkan0', mib: 8192 }], exe: 'llama-server' }
  const passed = sink()
  const ok = await setup({ out: passed.out, isVoiceRunning: noHub, prepare: async () => gpu, test: async () => ({ ok: true, ms: 4000, heard: 'Oi, eu sou a Ceci.', problems: [] }) })
  assert.equal(ok.ok, true)
  assert.match(passed.lines.join(''), /Voz natural pronta.*Oi, eu sou a Ceci/)
  const failed = sink()
  const asked = []
  const prepare = async options => {
    asked.push(options)
    return options.override === 'light' ? { profile: 'light', reason: options.reason, devices: options.devices } : gpu
  }
  const bad = await setup({ out: failed.out, isVoiceRunning: noHub, prepare, test: async () => ({ ok: false, ms: 1, heard: '', problems: ['o servidor tts não iniciou'] }) })
  assert.equal(bad.ok, false)
  assert.match(failed.lines.join(''), /servidor tts não iniciou[\s\S]*voz leve[\s\S]*Voz leve pronta/)
  // The light profile is saved (prepared) in its place, so calls really use the light voice.
  assert.equal(asked.length, 2)
  assert.equal(asked[1].override, 'light')
  assert.deepEqual(asked[1].devices, gpu.devices)
  assert.match(asked[1].reason, /falhou no teste: o servidor tts não iniciou/)
  // Setup may try the natural voice again; its fallback remembers the failure for later preparations.
  assert.equal(asked[0].retryNatural, true)
  assert.equal(asked[1].failed, true)
  assert.equal(bad.fallback.profile, 'light')
  // With no internet for the light voice either, setup still ends and says so.
  const offline = sink()
  const worse = await setup({ out: offline.out, isVoiceRunning: noHub, prepare: async o => { if (o.override === 'light') throw new Error('fetch failed'); return gpu }, test: async () => ({ ok: false, ms: 1, heard: '', problems: ['x'] }) })
  assert.equal(worse.ok, false)
  assert.match(offline.lines.join(''), /não pôde ser baixada: sem conexão com a internet.*\(fetch failed\)/)
})

test('a disk without room for what is left to download stops setup before it, with the size and the folder', async () => {
  const { MODELS } = await import('./models.mjs')
  const dir = mkdtempSync(join(tmpdir(), 'luke-voice-space-'))
  const paths = ['native/qwen3-tts-1.7b-base-q5_k_m.gguf']
  const needed = MODELS[paths[0]].size * 1.1
  await assert.rejects(checkSpace({ paths, dir, free: async () => needed - 1 }), error => {
    assert.equal(error.code, 'LUKE_NO_SPACE')
    assert.equal(error.message, `Falta espaço: a voz precisa de 1,3 GB livres em ${dir}; libere espaço e rode de novo.`)
    return true
  })
  await checkSpace({ paths, dir, free: async () => needed + 1 })
  // A system that cannot say how much is free is not stopped.
  await checkSpace({ paths, dir, free: async () => null })
  // Through setup: the check runs before any model is downloaded, and the error reaches the caller.
  let downloaded = false
  const prepare = async ({ checkSpace: check }) => {
    await check({ paths, dir })
    downloaded = true
    return { profile: 'gpu' }
  }
  await assert.rejects(setup({ out: sink().out, isVoiceRunning: noHub, prepare, free: async () => 1 }), /Falta espaço/)
  assert.equal(downloaded, false)
})

test('why the voice could not be prepared is said in Portuguese, with what to do', () => {
  const failed = Object.assign(new TypeError('fetch failed'), { cause: { code: 'ENOTFOUND' } })
  const offline = explain(failed, { env: {} })
  assert.match(offline.reason, /sem conexão com a internet.*proxy.*ENOTFOUND/)
  assert.match(offline.help, /HTTPS_PROXY/)
  // Behind a proxy: check it, or, on a Node that cannot use one, get the installer's own Node.js.
  const proxied = { HTTPS_PROXY: 'http://proxy:8080' }
  assert.match(explain(failed, { env: proxied, versions: { node: '24.22.3' } }).help, /proxy http:\/\/proxy:8080/)
  assert.match(explain(failed, { env: proxied, versions: { node: '20.19.0' } }).help, /Node\.js 20\.19\.0 não baixa pelo proxy.*instalador de novo/)
  assert.match(explain(new Error('Download failed (404): https://x')).reason, /respondeu com erro 404/)
  assert.match(explain(new Error('Integrity check failed: https://x')).reason, /diferente do esperado/)
  assert.match(explain(Object.assign(new Error('no space'), { code: 'ENOSPC' })).reason, /disco encheu/)
  assert.equal(explain(Object.assign(new Error('Falta espaço: x'), { code: 'LUKE_NO_SPACE' })).help, '')
  for (const { help } of [offline, explain(new Error('something else'))]) assert.ok(help.length > 10)
})

test('the light profile needs no test', async () => {
  const { lines, out } = sink()
  let tested = false
  const result = await setup({ out, prepare: async () => ({ profile: 'light', reason: 'nenhuma placa de vídeo encontrada', devices: [] }), test: async () => (tested = true) })
  assert.equal(result.ok, true)
  assert.equal(tested, false)
  assert.match(lines.join(''), /voz leve, no navegador \(nenhuma placa de vídeo encontrada\)/)
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

test('a voice made slower than real time (an integrated GPU) fails the install test, so the light voice is used', async () => {
  const { createServer } = await import('node:http')
  // 0.3 s of 48 kHz 16-bit mono speech, by its WAV header (at 24 kHz it would last twice as long).
  const wav = Buffer.alloc(44 + 28_800)
  wav.write('RIFF', 0)
  wav.write('WAVEfmt ', 8)
  wav.writeUInt32LE(96_000, 28)
  wav.write('data', 36)
  let delayMs = 0
  const server = createServer((req, res) => {
    req.resume()
    req.on('end', () => {
      if (req.url === '/v1/audio/speech') return setTimeout(() => res.end(wav), delayMs)
      if (req.url === '/v1/audio/transcriptions') return res.end(JSON.stringify({ text: 'language Portuguese<asr_text>Oi, eu sou a Ceci. Estou pronta!' }))
      res.end(JSON.stringify({ choices: [{ message: { content: '{"intent":"greeting"}' } }] }))
    })
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const url = `http://127.0.0.1:${server.address().port}`
  const engine = { start: async () => {}, status: () => ({ tts: true, asr: true, router: true }), warm: async () => {}, url: () => url, stop: () => {} }
  try {
    delayMs = 450
    const slow = await smokeTest({ profile: 'gpu' }, { engine, voice: 'missing.wav' })
    assert.equal(slow.ok, false)
    assert.match(slow.problems.join('; '), /a placa de vídeo é lenta demais para a voz natural/)
    delayMs = 0
    const fast = await smokeTest({ profile: 'gpu' }, { engine, voice: 'missing.wav' })
    assert.equal(fast.ok, true, fast.problems.join('; '))
  } finally {
    server.close()
  }
})

test('lean (the ears on the CPU): the engine starts lean, and ears too slow on that CPU fail the install test', async () => {
  const { createServer } = await import('node:http')
  let earsDelayMs = 0
  const server = createServer((req, res) => {
    req.resume()
    req.on('end', () => {
      if (req.url === '/v1/audio/speech') return res.end(Buffer.alloc(60_000))
      if (req.url === '/v1/audio/transcriptions') return setTimeout(() => res.end(JSON.stringify({ text: 'language Portuguese<asr_text>Oi, eu sou a Ceci. Estou pronta!' })), earsDelayMs)
      res.end(JSON.stringify({ choices: [{ message: { content: '{"intent":"greeting"}' } }] }))
    })
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const url = `http://127.0.0.1:${server.address().port}`
  const starts = []
  const engine = { start: async (_names, options) => starts.push(options), status: () => ({ tts: true, asr: true, router: true }), warm: async () => {}, url: () => url, stop: () => {} }
  const lean = { profile: 'gpu', lean: true, exe: 'llama-server' }
  try {
    const fast = await smokeTest(lean, { engine, voice: 'missing.wav' })
    assert.equal(fast.ok, true, fast.problems.join('; '))
    assert.deepEqual(starts[0], { exe: 'llama-server', lean: true })
    earsDelayMs = 2100
    const slow = await smokeTest(lean, { engine, voice: 'missing.wav' })
    assert.equal(slow.ok, false)
    assert.match(slow.problems.join('; '), /o processador é lento demais para os ouvidos/)
    // On the GPU the ears are never timed this way.
    assert.equal((await smokeTest({ profile: 'gpu', exe: 'llama-server' }, { engine, voice: 'missing.wav' })).ok, true)
  } finally {
    server.close()
  }
})

test('a first failed test is run again: one failure alone does not switch the calls to the light voice', async () => {
  const gpu = { profile: 'gpu', reason: 'RTX, 8192 MiB', devices: [{ name: 'Vulkan0', mib: 8192 }], exe: 'llama-server' }
  const results = [{ ok: false, ms: 1, heard: '', problems: ['o servidor tts não iniciou'] }, { ok: true, ms: 4000, heard: 'Oi, eu sou a Ceci.', problems: [] }]
  const asked = []
  const { lines, out } = sink()
  const result = await setup({ out, isVoiceRunning: noHub, prepare: async options => (asked.push(options), gpu), test: async () => results.shift() })
  assert.equal(result.ok, true)
  assert.equal(asked.length, 1, 'the light profile was saved after one failure')
  assert.match(lines.join(''), /não passou no teste: o servidor tts não iniciou\. Testando de novo[\s\S]*Voz natural pronta/)
  // Two failures: the light voice, saying why.
  let tests = 0
  const twice = sink()
  const prepare = async options => (options.override === 'light' ? { profile: 'light', reason: options.reason, devices: [] } : gpu)
  const failed = await setup({ out: twice.out, isVoiceRunning: noHub, prepare, test: async () => (tests++, { ok: false, ms: 1, heard: '', problems: [`falha ${tests}`] }) })
  assert.equal(tests, 2)
  assert.equal(failed.ok, false)
  assert.match(failed.fallback.reason, /falhou no teste: falha 2/)
  assert.match(twice.lines.join(''), /falha 1\. Testando de novo[\s\S]*falha 2[\s\S]*voz leve/)
})

test('with a hub already running the natural voice, the test is left to it instead of failing for lack of video memory', async () => {
  const gpu = { profile: 'gpu', reason: 'RTX, 8192 MiB', devices: [{ name: 'Vulkan0', mib: 8192 }], exe: 'llama-server' }
  const { lines, out } = sink()
  let tested = false
  const result = await setup({ out, isVoiceRunning: async () => true, prepare: async () => gpu, test: async () => (tested = true) })
  assert.equal(result.ok, true)
  assert.equal(tested, false)
  assert.equal(result.test, null)
  assert.match(lines.join(''), /já está rodando no hub/)
})

test("the running hub's voice is read from its /health", async () => {
  const { createServer } = await import('node:http')
  let native = { tts: true, asr: true, router: false }
  const server = createServer((req, res) => res.end(JSON.stringify({ app: 'luke-voice', version: '0.10.1', profile: 'gpu', native })))
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const origin = `http://127.0.0.1:${server.address().port}`
  try {
    assert.equal(await hubRunsVoice({ origin }), true)
    native = { tts: false, asr: false, router: false }
    assert.equal(await hubRunsVoice({ origin }), false)
  } finally {
    server.close()
  }
  assert.equal(await hubRunsVoice({ origin }), false)
})
