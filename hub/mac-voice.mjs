// Ceci's voice on a Mac where the natural voice is too slow (an M1 makes 2.6 s of speech in 12 s):
// the best pt-BR voice of macOS itself, Premium or Enhanced (neural, faster than real time on any
// Apple Silicon). The compact voices sound no better than Kokoro, so they never count. The user
// downloads a Premium voice once, in System Settings > Accessibility > Spoken Content.
import { execFile } from 'node:child_process'
import { readdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'

// AVSpeechSynthesisVoiceQuality: 1 compact, 2 enhanced, 3 premium.
const MIN_QUALITY = 2

// AVSpeechSynthesisVoiceGender: 0 unspecified, 1 male, 2 female.
const GENDERS = { 1: 'male', 2: 'female' }

// The voices macOS has, one "identifier<TAB>language<TAB>quality<TAB>gender" per line.
// `say -v '?'` is not enough: it leaves the downloaded Enhanced and Premium voices out, and `say`
// with a voice it does not know speaks in the default voice, with no error. JXA ships with every Mac.
const LIST_VOICES = `ObjC.import('AVFoundation')
const voices = $.AVSpeechSynthesisVoice.speechVoices
const out = []
for (let i = 0; i < voices.count; i++) {
  const v = voices.objectAtIndex(i)
  out.push([v.identifier.js, v.language.js, v.quality, v.gender].join('\\t'))
}
out.join('\\n')`

// The pt-BR voices of that list, best first: [{ id, quality, gender }], gender 'male', 'female' or null.
export function parseVoices(output) {
  const voices = []
  for (const line of String(output).split('\n')) {
    const [id, language, quality, gender] = line.trim().split('\t')
    if (id && language === 'pt-BR' && Number(quality) >= 1) voices.push({ id, quality: Number(quality), gender: GENDERS[gender] ?? null })
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
// voiceId = "com.apple.siri.natural.Nando" (Siri Voz 1 in pt-BR on macOS 26).
export const SYSTEM = 'system'
export const isSiriSystemVoice = prefs => /voiceId\s*=\s*"?com\.apple\.siri\./i.test(String(prefs))
// The Siri voice's name in those settings: "com.apple.siri.natural.Nando" gives "nando".
export const siriVoiceName = prefs => /voiceId\s*=\s*"?com\.apple\.siri\.[a-z]+\.([a-z]+)/i.exec(String(prefs))?.[1]?.toLowerCase() ?? null

// Where macOS lists the Siri voices it can download, each with its gender.
const SIRI_CATALOGS = ['/System/Library/AssetsV2/com_apple_MobileAsset_UAF_Siri_TextToSpeech/purpose_auto', '/System/Library/AssetsV2/com_apple_MobileAsset_Trial_Siri_SiriTextToSpeech/purpose_auto']
// The pt-BR Siri voices when no catalog can be read: Siri Voz 1 is nando (male), Siri Voz 2 is sandra (female).
// ponytail: pt-BR only; the catalog covers every other voice.
const SIRI_GENDERS = { sandra: 'female', nando: 'male' }

// A Siri voice's gender from the catalog, as `plutil -p` prints it: each voice's
// "AssetSpecifier" => "com.apple.siri.tts.voice.pt_BR.nando.natural.premium" comes before its "gender".
export function siriGender(name, catalog = '') {
  if (!name) return null
  let current = null
  for (const line of String(catalog).split('\n')) {
    const spec = /"AssetSpecifier"\s*=>\s*"com\.apple\.siri\.tts\.voice\.pt_BR\.([a-z]+)\./i.exec(line)
    if (spec) current = spec[1].toLowerCase()
    else if (/"AssetSpecifier"/.test(line)) current = null
    const gender = /"gender"\s*=>\s*"(male|female)"/i.exec(line)
    if (gender && current === name) return gender[1].toLowerCase()
  }
  return SIRI_GENDERS[name] ?? null
}

// Every Siri catalog on this Mac, as `plutil -p` text ('' when there is none).
async function readSiriCatalogs() {
  const texts = []
  for (const dir of SIRI_CATALOGS) {
    const files = await readdir(dir).catch(() => [])
    for (const file of files.filter(name => name.endsWith('.xml'))) texts.push(await run('plutil', ['-p', join(dir, file)], { timeoutMs: 5000 }).catch(() => ''))
  }
  return texts.join('\n')
}

// The voice to use on this machine: { voice, gender, siri }, with gender 'male', 'female' or null,
// and siri the Siri voice's name ('nando', 'sandra') when the system voice is a Siri voice. A Siri system voice first, then the best Premium/Enhanced pt-BR voice; null
// off macOS or with neither.
export async function pickMacVoice({ platform = process.platform, env = process.env, list = () => run('osascript', ['-l', 'JavaScript', '-e', LIST_VOICES], { timeoutMs: 10_000 }), prefs = () => run('defaults', ['read', 'com.apple.Accessibility', 'SpokenContentDefaultVoiceSelectionsByLanguage'], { timeoutMs: 5000 }), catalogs = readSiriCatalogs } = {}) {
  if (platform !== 'darwin' || env.LUKE_VOICE_MAC_VOICE === 'off') return null
  const override = env.LUKE_VOICE_MAC_VOICE ?? ''
  if (!override) {
    const chosen = await prefs().catch(() => '')
    if (isSiriSystemVoice(chosen)) {
      const siri = siriVoiceName(chosen)
      return { voice: SYSTEM, gender: siriGender(siri, await catalogs().catch(() => '')), siri }
    }
  }
  const voices = parseVoices(await list().catch(() => ''))
  const voice = bestVoice(voices, override)
  return voice ? { voice, gender: voices.find(found => found.id === voice)?.gender ?? null, siri: null } : null
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
