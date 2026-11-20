// Gets Ceci's free voice ready on this computer, at install time: picks the profile (gpu when
// llama.cpp sees a GPU with enough memory, light otherwise), downloads and checks everything that
// profile needs, and runs a short test. Run by the installers and by /luke-voice setup:
//   node hub/setup.mjs [--json] [--no-test]
// --no-test skips the short test (the hub already runs the voice, so a second copy would not fit).
// LUKE_VOICE_PROFILE=gpu|light forces the profile. Exit code 0 when the voice is ready.
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { createEngine, groupBytes, maxFrames, prepareEngine, profileGroups, VOICE_SETTINGS } from './engine.mjs'
import { modelsDir } from './models.mjs'
import { route } from './router.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const VOICE = join(ROOT, 'agent', 'ceci-voice.wav')
const TEST_LINE = 'Oi, eu sou a Ceci. Estou pronta!'

const gb = bytes => `${(bytes / 1e9).toFixed(2)} GB`
const mb = bytes => `${Math.round(bytes / 1e6)} MB`
export const size = bytes => (bytes >= 1e9 ? gb(bytes) : mb(bytes))

// A progress line: redrawn in place on a terminal, every 10% otherwise (installer logs).
export function progressPrinter(out = process.stdout) {
  let label = ''
  let shown = -1
  return (loaded, total, next) => {
    if (!total) return
    if (next !== label) {
      if (out.isTTY && label) out.write('\n')
      label = next
      shown = -1
    }
    const percent = Math.min(100, Math.floor((loaded / total) * 100))
    if (percent === shown || (!out.isTTY && percent < shown + 10 && percent !== 100)) return
    shown = percent
    const line = `      ${label === 'llama.cpp' ? 'Voice engine (llama.cpp)' : 'Voice models'}: ${percent}% of ${size(total)}`
    out.write(out.isTTY ? `\r${line}   ${percent === 100 ? '\n' : ''}` : `${line}\n`)
    if (out.isTTY && percent === 100) label = ''
  }
}

// The gpu profile's test: the three servers start, Ceci says a line, her ears write it back, and
// the router answers a greeting. Returns { ok, ms, heard, problems }.
export async function smokeTest(profile, { engine = createEngine(), voice = VOICE } = {}) {
  const problems = []
  const started = Date.now()
  try {
    await engine.start(undefined, { exe: profile.exe })
    const status = engine.status()
    for (const [name, isUp] of Object.entries(status)) if (!isUp) problems.push(`the ${name} server did not start`)
    const refB64 = existsSync(voice) ? readFileSync(voice).toString('base64') : ''
    const refText = existsSync(voice.replace(/\.wav$/, '.txt')) ? readFileSync(voice.replace(/\.wav$/, '.txt'), 'utf8').trim() : ''
    await engine.warm({ speakerRefB64: refB64, speakerRefText: refText })
    let heard = ''
    const tts = engine.url('tts')
    if (tts) {
      const body = { input: TEST_LINE, lang: 'pt', response_format: 'wav', n_predict: maxFrames(TEST_LINE), ...VOICE_SETTINGS, ...(refB64 ? { speaker_ref_b64: refB64, speaker_ref_text: refText } : {}) }
      const res = await fetch(`${tts}/v1/audio/speech`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
      const wav = Buffer.from(await res.arrayBuffer())
      if (!res.ok || wav.length < 24_000) problems.push('the voice made no audio')
      const asr = engine.url('asr')
      if (asr && res.ok) {
        const form = new FormData()
        form.append('file', new Blob([wav], { type: 'audio/wav' }), 'test.wav')
        form.append('model', 'qwen3-asr')
        form.append('language', 'pt')
        const answer = await fetch(`${asr}/v1/audio/transcriptions`, { method: 'POST', body: form })
        heard = answer.ok ? String((await answer.json()).text ?? '').replace(/^[\s\S]*<asr_text>/, '').trim() : ''
        if (!/ceci|pronta/i.test(heard)) problems.push(`the ears heard "${heard}"`)
      }
    }
    const router = engine.url('router')
    if (router) {
      const ask = chat => fetch(`${router}/v1/chat/completions`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(chat) }).then(r => r.json())
      const { intent } = await route('oi, tudo bem?', { ask })
      if (intent === 'claude') problems.push('the router did not answer a greeting')
    }
    return { ok: problems.length === 0, ms: Date.now() - started, heard, problems }
  } catch (error) {
    problems.push(String(error?.message ?? error))
    return { ok: false, ms: Date.now() - started, heard: '', problems }
  } finally {
    engine.stop()
  }
}

export async function setup({ out = process.stdout, prepare = prepareEngine, test = smokeTest, isTested = true } = {}) {
  const say = line => out.write(`${line}\n`)
  const profile = await prepare({ onProgress: progressPrinter(out) })
  const bytes = groupBytes(profileGroups(profile.profile, profile.devices))
  if (profile.profile === 'gpu') {
    say(`      Profile: natural voice on the GPU (${profile.reason}). Models: ${size(bytes)} in ${modelsDir()}.`)
    if (!isTested) return { profile, test: null, ok: true }
    say('      Testing the voice, the ears and the router...')
    const result = await test(profile)
    if (!result.ok) {
      say(`      The natural voice did not pass its test: ${result.problems.join('; ')}.`)
      say('      Calls will use the light voice in the browser until this is fixed. Run /luke-voice setup to try again.')
      return { profile, test: result, ok: false }
    }
    say(`      Natural voice ready (test in ${(result.ms / 1000).toFixed(1)} s; she said "${result.heard}").`)
    return { profile, test: result, ok: true }
  }
  say(`      Profile: light voice in the browser${profile.reason ? ` (${profile.reason})` : ''}. Models: ${size(bytes)} in ${modelsDir()}.`)
  return { profile, test: null, ok: true }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const asJson = process.argv.includes('--json')
  try {
    const result = await setup({ out: asJson ? { write: () => true, isTTY: false } : process.stdout, isTested: !process.argv.includes('--no-test') })
    if (asJson) process.stdout.write(`${JSON.stringify({ ok: result.ok, profile: result.profile.profile, reason: result.profile.reason ?? '', heard: result.test?.heard ?? '', problems: result.test?.problems ?? [] })}\n`)
    process.exit(result.ok ? 0 : 1)
  } catch (error) {
    const message = String(error?.message ?? error)
    if (asJson) process.stdout.write(`${JSON.stringify({ ok: false, error: message })}\n`)
    else process.stderr.write(`      Could not prepare the voice: ${message}\n`)
    process.exit(1)
  }
}
