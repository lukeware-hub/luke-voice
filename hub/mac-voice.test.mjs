import assert from 'node:assert/strict'
import { test } from 'node:test'

import { SYSTEM, bestVoice, isSiriSystemVoice, parseVoices, pickMacVoice } from './mac-voice.mjs'

// What the JXA listing prints: identifier, language, quality (1 compact, 2 enhanced, 3 premium).
const COMPACT = `com.apple.voice.compact.pt-BR.Luciana\tpt-BR\t1
com.apple.eloquence.pt-BR.Eddy\tpt-BR\t1
com.apple.voice.premium.en-US.Zoe\ten-US\t3
`
const ENHANCED = `${COMPACT}com.apple.voice.enhanced.pt-BR.Luciana\tpt-BR\t2
`
const PREMIUM = `${ENHANCED}com.apple.voice.premium.pt-BR.Fernanda\tpt-BR\t3
`

test('parseVoices keeps only the pt-BR voices, best first', () => {
  assert.deepEqual(parseVoices(ENHANCED).map(v => v.id), ['com.apple.voice.enhanced.pt-BR.Luciana', 'com.apple.voice.compact.pt-BR.Luciana', 'com.apple.eloquence.pt-BR.Eddy'])
  assert.deepEqual(parseVoices('garbage\n\n'), [])
})

test('bestVoice takes Premium over Enhanced, and never a compact voice', () => {
  assert.equal(bestVoice(parseVoices(PREMIUM)), 'com.apple.voice.premium.pt-BR.Fernanda')
  assert.equal(bestVoice(parseVoices(ENHANCED)), 'com.apple.voice.enhanced.pt-BR.Luciana')
  assert.equal(bestVoice(parseVoices(COMPACT)), null)
  assert.equal(bestVoice(parseVoices(PREMIUM), 'off'), null)
  assert.equal(bestVoice([], 'com.apple.voice.compact.pt-BR.Luciana'), 'com.apple.voice.compact.pt-BR.Luciana')
})

test('pickMacVoice is null off macOS, when turned off, or when the listing fails', async () => {
  const list = async () => PREMIUM
  const prefs = async () => '{ SystemTTSLanguage = pt; }'
  assert.equal(await pickMacVoice({ platform: 'darwin', env: {}, list, prefs }), 'com.apple.voice.premium.pt-BR.Fernanda')
  assert.equal(await pickMacVoice({ platform: 'win32', env: {}, list }), null)
  assert.equal(await pickMacVoice({ platform: 'darwin', env: { LUKE_VOICE_MAC_VOICE: 'off' }, list }), null)
  assert.equal(await pickMacVoice({ platform: 'darwin', env: {}, list: async () => Promise.reject(new Error('no osascript')), prefs }), null)
})

test('a Siri system voice wins: say speaks with no -v', async () => {
  // What `defaults read com.apple.Accessibility SpokenContentDefaultVoiceSelectionsByLanguage` printed with Siri Voz 2.
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
  assert.equal(await pickMacVoice({ platform: 'darwin', env: {}, list: async () => PREMIUM, prefs: siri }), SYSTEM)
  // A voice picked by name still wins over the system voice.
  assert.equal(await pickMacVoice({ platform: 'darwin', env: { LUKE_VOICE_MAC_VOICE: 'com.apple.voice.enhanced.pt-BR.Luciana' }, list: async () => PREMIUM, prefs: siri }), 'com.apple.voice.enhanced.pt-BR.Luciana')
})
