import assert from 'node:assert/strict'
import { test } from 'node:test'

import { SYSTEM, bestVoice, isSiriSystemVoice, parseVoices, pickMacVoice, siriGender, siriVoiceName } from './mac-voice.mjs'

// What the JXA listing prints: identifier, language, quality (1 compact, 2 enhanced, 3 premium),
// gender (0 unspecified, 1 male, 2 female).
const COMPACT = `com.apple.voice.compact.pt-BR.Luciana\tpt-BR\t1\t2
com.apple.eloquence.pt-BR.Eddy\tpt-BR\t1\t1
com.apple.voice.premium.en-US.Zoe\ten-US\t3\t2
`
const ENHANCED = `${COMPACT}com.apple.voice.enhanced.pt-BR.Luciana\tpt-BR\t2\t2
`
const PREMIUM = `${ENHANCED}com.apple.voice.premium.pt-BR.Felipe\tpt-BR\t3\t1
`
// Part of the Siri catalog as `plutil -p` prints it on macOS 26 (com_apple_MobileAsset_UAF_Siri_TextToSpeech.xml).
const CATALOG = `      "AssetSpecifier" => "com.apple.siri.tts.voice.pt_BR.sandra.natural.premium"
      "_CompressionAlgorithm" => "AppleEncryptedArchive"
      "gender" => "female"
    }
      "AssetSpecifier" => "com.apple.siri.tts.resource.pt_BR"
    }
      "AssetSpecifier" => "com.apple.siri.tts.voice.pt_BR.nando.natural.premium"
      "gender" => "male"
`

test('parseVoices keeps only the pt-BR voices, best first', () => {
  assert.deepEqual(parseVoices(ENHANCED).map(v => v.id), ['com.apple.voice.enhanced.pt-BR.Luciana', 'com.apple.voice.compact.pt-BR.Luciana', 'com.apple.eloquence.pt-BR.Eddy'])
  assert.deepEqual(parseVoices('garbage\n\n'), [])
  assert.deepEqual(parseVoices(PREMIUM)[0], { id: 'com.apple.voice.premium.pt-BR.Felipe', quality: 3, gender: 'male' })
  // An older listing with no gender column still parses.
  assert.equal(parseVoices('com.apple.voice.enhanced.pt-BR.Luciana\tpt-BR\t2')[0].gender, null)
})

test('bestVoice takes Premium over Enhanced, and never a compact voice', () => {
  assert.equal(bestVoice(parseVoices(PREMIUM)), 'com.apple.voice.premium.pt-BR.Felipe')
  assert.equal(bestVoice(parseVoices(ENHANCED)), 'com.apple.voice.enhanced.pt-BR.Luciana')
  assert.equal(bestVoice(parseVoices(COMPACT)), null)
  assert.equal(bestVoice(parseVoices(PREMIUM), 'off'), null)
  assert.equal(bestVoice([], 'com.apple.voice.compact.pt-BR.Luciana'), 'com.apple.voice.compact.pt-BR.Luciana')
})

test('pickMacVoice is null off macOS, when turned off, or when the listing fails', async () => {
  const list = async () => PREMIUM
  const prefs = async () => '{ SystemTTSLanguage = pt; }'
  assert.deepEqual(await pickMacVoice({ platform: 'darwin', env: {}, list, prefs }), { voice: 'com.apple.voice.premium.pt-BR.Felipe', gender: 'male', siri: null })
  assert.deepEqual(await pickMacVoice({ platform: 'darwin', env: {}, list: async () => ENHANCED, prefs }), { voice: 'com.apple.voice.enhanced.pt-BR.Luciana', gender: 'female', siri: null })
  assert.equal(await pickMacVoice({ platform: 'win32', env: {}, list }), null)
  assert.equal(await pickMacVoice({ platform: 'darwin', env: { LUKE_VOICE_MAC_VOICE: 'off' }, list }), null)
  assert.equal(await pickMacVoice({ platform: 'darwin', env: {}, list: async () => Promise.reject(new Error('no osascript')), prefs }), null)
})

test('a Siri system voice wins: say speaks with no -v', async () => {
  // What `defaults read com.apple.Accessibility SpokenContentDefaultVoiceSelectionsByLanguage` printed with Siri Voz 1.
  const SIRI = `(
    pt,
        {
        "_type" = "Speech.VoiceSelection";
        "_version" = 0;
        boundLanguage = pt;
        pitch = 1;
        voiceId = "com.apple.siri.natural.Nando";
        volume = 1;
    }
)`
  const siri = async () => SIRI
  assert.equal(isSiriSystemVoice(SIRI), true)
  assert.equal(isSiriSystemVoice(SIRI.replace('com.apple.siri.natural.Nando', 'com.apple.voice.enhanced.pt-BR.Luciana')), false)
  assert.equal(isSiriSystemVoice('{ SystemTTSLanguage = pt; }'), false)
  assert.equal(siriVoiceName(SIRI), 'nando')
  assert.deepEqual(await pickMacVoice({ platform: 'darwin', env: {}, list: async () => PREMIUM, prefs: siri, catalogs: async () => CATALOG }), { voice: SYSTEM, gender: 'male', siri: 'nando' })
  const sandra = async () => SIRI.replace('Nando', 'Sandra')
  assert.deepEqual(await pickMacVoice({ platform: 'darwin', env: {}, list: async () => PREMIUM, prefs: sandra, catalogs: async () => CATALOG }), { voice: SYSTEM, gender: 'female', siri: 'sandra' })
  // A voice picked by name still wins over the system voice.
  assert.deepEqual(await pickMacVoice({ platform: 'darwin', env: { LUKE_VOICE_MAC_VOICE: 'com.apple.voice.enhanced.pt-BR.Luciana' }, list: async () => PREMIUM, prefs: siri }), { voice: 'com.apple.voice.enhanced.pt-BR.Luciana', gender: 'female', siri: null })
})

test('siriGender reads the catalog, and knows the pt-BR Siri voices without it', () => {
  assert.equal(siriGender('nando', CATALOG), 'male')
  assert.equal(siriGender('sandra', CATALOG), 'female')
  assert.equal(siriGender('nando', ''), 'male')
  assert.equal(siriGender('sandra', ''), 'female')
  assert.equal(siriGender('nobody', CATALOG), null)
  assert.equal(siriGender(null, CATALOG), null)
})
