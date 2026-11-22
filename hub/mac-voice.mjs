// Ceci's voice on a Mac where the natural voice is too slow (an M1 makes 2.6 s of speech in 12 s):
// the best pt-BR voice of macOS itself, Premium or Enhanced (neural, faster than real time on any
// Apple Silicon). The compact voices sound no better than Kokoro, so they never count. The user
// downloads a Premium voice once, in System Settings > Accessibility > Spoken Content.
import { execFile } from 'node:child_process'
import { readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'

// AVSpeechSynthesisVoiceQuality: 1 compact, 2 enhanced, 3 premium.
const MIN_QUALITY = 2

// The voices macOS has, with their quality, one "identifier<TAB>language<TAB>quality" per line.
// `say -v '?'` is not enough: it leaves the downloaded Enhanced and Premium voices out, and `say`
// with a voice it does not know speaks in the default voice, with no error. JXA ships with every Mac.
const LIST_VOICES = `ObjC.import('AVFoundation')
const voices = $.AVSpeechSynthesisVoice.speechVoices
const out = []
for (let i = 0; i < voices.count; i++) {
  const v = voices.objectAtIndex(i)
  out.push([v.identifier.js, v.language.js, v.quality].join('\\t'))
}
out.join('\\n')`

// The pt-BR voices of that list, best first: [{ id, quality }].
export function parseVoices(output) {
  const voices = []
  for (const line of String(output).split('\n')) {
    const [id, language, quality] = line.trim().split('\t')
    if (id && language === 'pt-BR' && Number(quality) >= 1) voices.push({ id, quality: Number(quality) })
  }
  return voices.sort((a, b) => b.quality - a.quality)
}

// The best Premium or Enhanced pt-BR voice's identifier, or null. LUKE_VOICE_MAC_VOICE=off turns
// this off, and LUKE_VOICE_MAC_VOICE=<identifier> picks a voice (when the detection misses one).
export function bestVoice(voices, override = '') {
  if (override === 'off') return null
  if (override) return override
  return voices.find(voice => voice.quality >= MIN_QUALITY)?.id ?? null
}

const run = (file, args, { signal, timeoutMs = 20_000 } = {}) =>
  new Promise((resolve, reject) =>
    execFile(file, args, { timeout: timeoutMs, signal, encoding: 'utf8' }, (error, stdout) => (error ? reject(error) : resolve(stdout))),
  )

// The Spoken Content system voice is a Siri voice. Apps cannot name a Siri voice: `say` with no
// -v speaks in the system voice, so SYSTEM means "leave -v out". System Settings keeps the choice
// in com.apple.Accessibility SpokenContentDefaultVoiceSelectionsByLanguage, as
// voiceId = "com.apple.siri.natural.Nando" (Siri Voz 2 in pt-BR on macOS 26).
export const SYSTEM = 'system'
export const isSiriSystemVoice = prefs => /voiceId\s*=\s*"?com\.apple\.siri\./i.test(String(prefs))

// The voice to use on this machine: a Siri system voice first, then the best Premium/Enhanced
// pt-BR voice; null off macOS or with neither.
export async function pickMacVoice({ platform = process.platform, env = process.env, list = () => run('osascript', ['-l', 'JavaScript', '-e', LIST_VOICES], { timeoutMs: 10_000 }), prefs = () => run('defaults', ['read', 'com.apple.Accessibility', 'SpokenContentDefaultVoiceSelectionsByLanguage'], { timeoutMs: 5000 }) } = {}) {
  if (platform !== 'darwin' || env.LUKE_VOICE_MAC_VOICE === 'off') return null
  if (!env.LUKE_VOICE_MAC_VOICE && isSiriSystemVoice(await prefs().catch(() => ''))) return SYSTEM
  const output = await list().catch(() => '')
  return bestVoice(parseVoices(output), env.LUKE_VOICE_MAC_VOICE ?? '')
}

// One line spoken with `say`, as 24 kHz mono PCM16 WAV. The signal stops it (Ceci cut off).
export async function sayWav(voice, text, signal) {
  const file = join(tmpdir(), `luke-voice-say-${randomBytes(6).toString('hex')}.wav`)
  try {
    await run('say', [...(voice === SYSTEM ? [] : ['-v', voice]), '-o', file, '--file-format=WAVE', '--data-format=LEI16@24000', '--', text], { signal })
    return await readFile(file)
  } finally {
    await rm(file, { force: true })
  }
}
