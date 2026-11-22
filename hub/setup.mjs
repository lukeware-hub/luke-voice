// Gets Ceci's free voice ready on this computer, at install time: picks the profile (gpu when
// llama.cpp sees a GPU with enough memory, light otherwise), downloads and checks everything that
// profile needs, and runs a short test. Run by the installers and by /luke-voice setup:
//   node hub/setup.mjs [--json] [--no-test]
// --no-test skips the short test (the hub already runs the voice, so a second copy would not fit).
// Without it the test is also skipped when a running hub reports the natural voice up, for the same
// reason; a failed test is run once more before the light voice is chosen.
// LUKE_VOICE_PROFILE=gpu|light forces the profile. Exit code 0 when the voice is ready, 2 when the
// disk has no room for it, 1 otherwise.
// Behind a proxy (HTTPS_PROXY or HTTP_PROXY set), the downloads go through it (hub/proxy.mjs).
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { ASR_GLOSSARY, createEngine, groupBytes, maxFrames, prepareEngine, profileGroups, VOICE_SETTINGS } from './engine.mjs'
import { freeBytes, modelsDir, remainingBytes } from './models.mjs'
import { ORIGIN, isMainModule } from './paths.mjs'
import { honorsEnvProxy, proxyEnv, proxyFrom } from './proxy.mjs'
import { route } from './router.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const VOICE = join(ROOT, 'agent', 'ceci-voice.wav')
const TEST_LINE = 'Oi, eu sou a Ceci. Estou pronta!'
// The voice must be made faster than it is spoken, with margin, or Ceci stutters in a call. An
// integrated GPU (shared memory reported as video memory) can pass every other check and still be
// too slow; a discrete one makes the test line in about half its length.
const MAX_REAL_TIME = 0.9

// How long a WAV lasts, in ms: its bytes after the header at the header's byte rate (Qwen3-TTS
// writes 24 kHz 16-bit mono, assumed when there is no header).
function wavMs(wav) {
  const hasHeader = wav.length > 44 && wav.toString('latin1', 0, 4) === 'RIFF' && wav.toString('latin1', 8, 12) === 'WAVE'
  const byteRate = hasHeader ? wav.readUInt32LE(28) : 0
  return ((wav.length - (hasHeader ? 44 : 0)) / (byteRate || 48_000)) * 1000
}

const gb = bytes => `${(bytes / 1e9).toFixed(2)} GB`
const mb = bytes => `${Math.round(bytes / 1e6)} MB`
export const size = bytes => (bytes >= 1e9 ? gb(bytes) : mb(bytes))
// In a sentence for the user: "3,6 GB", "540 MB".
const sizeText = bytes => (bytes >= 1e9 ? `${(bytes / 1e9).toFixed(1).replace('.', ',')} GB` : mb(bytes))

// Fails before a download that would not fit: what is left to download plus 10%, on the disk that
// holds the models. A system that cannot say how much is free is not stopped.
export async function checkSpace({ paths, dir, free = freeBytes }) {
  const needed = Math.ceil(remainingBytes(paths, { dir }) * 1.1)
  if (!needed) return
  const have = await free(dir)
  if (have === null || have >= needed) return
  const error = new Error(`Falta espaço: a voz precisa de ${sizeText(needed)} livres em ${dir}; libere espaço e rode de novo.`)
  error.code = 'LUKE_NO_SPACE'
  throw error
}

const NETWORK = /fetch failed|ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ECONNRESET|ETIMEDOUT|ENETUNREACH|EHOSTUNREACH|UND_ERR|CERT|certificate|socket|proxy/i

// Why the voice could not be prepared, for a person: { reason, help } in Portuguese. The original
// error stays in parentheses where it helps whoever looks into it.
export function explain(error, { env = process.env, versions = process.versions } = {}) {
  const message = String(error?.message ?? error)
  const code = String(error?.code ?? error?.cause?.code ?? '')
  if (code === 'LUKE_NO_SPACE') return { reason: message, help: '' }
  if (code === 'ENOSPC') return { reason: 'o disco encheu durante o download', help: 'Libere espaço e rode de novo: o download continua de onde parou.' }
  if (NETWORK.test(`${message} ${code} ${error?.cause?.message ?? ''}`)) {
    const proxy = proxyFrom(env)
    return {
      reason: `sem conexão com a internet, ou a rede (um proxy de empresa) bloqueou o download (${code || message})`,
      help: !proxy
        ? 'Confira a internet. Atrás de um proxy de empresa, defina HTTPS_PROXY=http://endereço:porta e rode de novo.'
        : honorsEnvProxy(versions)
          ? `Confira a internet e o proxy ${proxy} (endereço, porta e se ele libera github.com e huggingface.co) e rode de novo.`
          : `O Node.js ${versions.node} não baixa pelo proxy ${proxy}: rode o instalador de novo, ele traz um Node.js que baixa.`,
    }
  }
  const status = /Download failed \((\d+)\)/.exec(message)?.[1]
  if (status) return { reason: `o servidor de download respondeu com erro ${status}`, help: 'Tente de novo em alguns minutos. Se repetir, veja se a rede bloqueia github.com ou huggingface.co.' }
  if (/Integrity check failed/.test(message)) return { reason: 'um arquivo baixado veio diferente do esperado', help: 'Rode de novo: ele baixa esse arquivo outra vez. Se repetir, a rede (um proxy) pode estar mudando os downloads.' }
  if (/Could not unpack/.test(message)) return { reason: `não consegui abrir o motor de voz baixado (${message})`, help: 'Rode de novo. Se repetir, veja se um antivírus bloqueou a pasta .luke-voice.' }
  return { reason: message, help: 'Rode de novo. Se repetir, digite /luke-voice help no Claude Code.' }
}

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
    const line = `      ${label === 'llama.cpp' ? 'Motor de voz (llama.cpp)' : 'Modelos de voz'}: ${percent}% de ${size(total)}`
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
    for (const [name, isUp] of Object.entries(status)) if (!isUp) problems.push(`o servidor ${name} não iniciou`)
    const refB64 = existsSync(voice) ? readFileSync(voice).toString('base64') : ''
    const refText = existsSync(voice.replace(/\.wav$/, '.txt')) ? readFileSync(voice.replace(/\.wav$/, '.txt'), 'utf8').trim() : ''
    await engine.warm({ speakerRefB64: refB64, speakerRefText: refText })
    let heard = ''
    const tts = engine.url('tts')
    if (tts) {
      const body = { input: TEST_LINE, lang: 'pt', response_format: 'wav', n_predict: maxFrames(TEST_LINE), ...VOICE_SETTINGS, ...(refB64 ? { speaker_ref_b64: refB64, speaker_ref_text: refText } : {}) }
      const asked = Date.now()
      const res = await fetch(`${tts}/v1/audio/speech`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
      const wav = Buffer.from(await res.arrayBuffer())
      const madeMs = Date.now() - asked
      if (!res.ok || wav.length < 24_000) problems.push('a voz não gerou áudio')
      else if (madeMs > MAX_REAL_TIME * wavMs(wav)) problems.push(`a placa de vídeo é lenta demais para a voz natural (${(madeMs / 1000).toFixed(1)} s para ${(wavMs(wav) / 1000).toFixed(1)} s de fala)`)
      const asr = engine.url('asr')
      if (asr && res.ok) {
        const form = new FormData()
        form.append('file', new Blob([wav], { type: 'audio/wav' }), 'test.wav')
        form.append('model', 'qwen3-asr')
        form.append('language', 'pt')
        form.append('prompt', ASR_GLOSSARY)
        const answer = await fetch(`${asr}/v1/audio/transcriptions`, { method: 'POST', body: form })
        heard = answer.ok ? String((await answer.json()).text ?? '').replace(/^[\s\S]*<asr_text>/, '').trim() : ''
        if (!/ceci|pronta/i.test(heard)) problems.push(`os ouvidos ouviram "${heard}"`)
      }
    }
    const router = engine.url('router')
    if (router) {
      const ask = chat => fetch(`${router}/v1/chat/completions`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(chat) }).then(r => r.json())
      const { intent } = await route('oi, tudo bem?', { ask })
      if (intent === 'claude') problems.push('o roteador não respondeu a um cumprimento')
    }
    return { ok: problems.length === 0, ms: Date.now() - started, heard, problems }
  } catch (error) {
    problems.push(String(error?.message ?? error))
    return { ok: false, ms: Date.now() - started, heard: '', problems }
  } finally {
    engine.stop()
  }
}

// Whether a luke-voice hub already runs the natural voice on this machine (its /health lists the
// native servers up). Then a second copy for the test would not fit in video memory, and would
// fail for that reason only.
export async function hubRunsVoice({ origin = ORIGIN } = {}) {
  try {
    const res = await fetch(`${origin}/health`, { signal: AbortSignal.timeout(2000) })
    const health = await res.json()
    return health?.app === 'luke-voice' && health.native?.tts === true
  } catch {
    return false
  }
}

export async function setup({ out = process.stdout, prepare = prepareEngine, test = smokeTest, isTested = true, isVoiceRunning = hubRunsVoice, free = freeBytes } = {}) {
  const say = line => out.write(`${line}\n`)
  const spaceCheck = options => checkSpace({ ...options, free })
  const profile = await prepare({ onProgress: progressPrinter(out), checkSpace: spaceCheck })
  const bytes = groupBytes(profileGroups(profile.profile, profile.devices))
  if (profile.profile === 'gpu') {
    say(`      Perfil: voz natural na placa de vídeo (${profile.reason}). Modelos: ${size(bytes)} em ${modelsDir()}.`)
    if (!isTested) return { profile, test: null, ok: true }
    if (await isVoiceRunning()) {
      say('      A voz natural já está rodando no hub do luke-voice, que é o teste dela (uma segunda cópia não caberia na placa de vídeo).')
      return { profile, test: null, ok: true }
    }
    say('      Testando a voz, os ouvidos e o roteador...')
    let result = await test(profile)
    // A first failure can be passing (a slow first start, the video memory still being freed):
    // only two in a row switch the calls to the light voice.
    if (!result.ok) {
      say(`      A voz natural não passou no teste: ${result.problems.join('; ')}. Testando de novo...`)
      result = await test(profile)
    }
    if (!result.ok) {
      say(`      A voz natural não passou no teste: ${result.problems.join('; ')}.`)
      say('      As chamadas vão usar a voz leve, no navegador, até isso ser resolvido. Para tentar de novo: /luke-voice setup.')
      // Saved as the light profile, so the hub and the window do not use the broken natural voice.
      try {
        const fallback = await prepare({ onProgress: progressPrinter(out), checkSpace: spaceCheck, override: 'light', devices: profile.devices, reason: `a voz natural falhou no teste: ${result.problems.join('; ')}` })
        say(`      Voz leve pronta. Modelos: ${size(groupBytes(profileGroups(fallback.profile, fallback.devices)))} em ${modelsDir()}.`)
        return { profile, test: result, ok: false, fallback }
      } catch (error) {
        say(`      A voz leve também não pôde ser baixada: ${explain(error).reason}.`)
        return { profile, test: result, ok: false, fallback: null }
      }
    }
    say(`      Voz natural pronta (teste em ${(result.ms / 1000).toFixed(1)} s; ela disse "${result.heard}").`)
    return { profile, test: result, ok: true }
  }
  say(`      Perfil: voz leve, no navegador${profile.reason ? ` (${profile.reason})` : ''}. Modelos: ${size(bytes)} em ${modelsDir()}.`)
  return { profile, test: null, ok: true }
}

if (isMainModule(import.meta.url, process.argv[1])) {
  // Behind a proxy: this same script again, with Node told to use it (read only at Node's start).
  const withProxy = proxyEnv(process.env)
  if (Object.entries(withProxy).some(([name, value]) => process.env[name] !== value)) {
    const again = spawnSync(process.execPath, ['--disable-warning=UNDICI-EHPA', fileURLToPath(import.meta.url), ...process.argv.slice(2)], { stdio: 'inherit', env: { ...process.env, ...withProxy } })
    process.exit(again.status ?? 1)
  }
  const asJson = process.argv.includes('--json')
  try {
    const result = await setup({ out: asJson ? { write: () => true, isTTY: false } : process.stdout, isTested: !process.argv.includes('--no-test') })
    if (asJson) process.stdout.write(`${JSON.stringify({ ok: result.ok, profile: result.profile.profile, reason: result.profile.reason ?? '', heard: result.test?.heard ?? '', problems: result.test?.problems ?? [] })}\n`)
    process.exit(result.ok ? 0 : 1)
  } catch (error) {
    const { reason, help } = explain(error)
    if (asJson) process.stdout.write(`${JSON.stringify({ ok: false, error: reason, help })}\n`)
    else if (error?.code === 'LUKE_NO_SPACE') process.stderr.write(`      ${reason}\n`)
    else process.stderr.write(`      Não consegui preparar a voz: ${reason}.\n      O que fazer: ${help}\n`)
    // 2: the disk is full, and the installers say so instead of "the first call finishes it".
    process.exit(error?.code === 'LUKE_NO_SPACE' ? 2 : 1)
  }
}
