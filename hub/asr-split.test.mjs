import assert from 'node:assert/strict'
import { test } from 'node:test'

import { MAX_PIECE_SECONDS, readWav, splitWav } from './asr-split.mjs'

const RATE = 16_000

// A 16 kHz mono PCM16 WAV, as the window sends it: `loud(i)` is the level of sample i (0 to 1).
function wav(seconds, loud = () => 0.5) {
  const n = Math.round(seconds * RATE)
  const out = Buffer.alloc(44 + n * 2)
  out.write('RIFF', 0, 'latin1')
  out.writeUInt32LE(36 + n * 2, 4)
  out.write('WAVEfmt ', 8, 'latin1')
  out.writeUInt32LE(16, 16)
  out.writeUInt16LE(1, 20)
  out.writeUInt16LE(1, 22)
  out.writeUInt32LE(RATE, 24)
  out.writeUInt32LE(RATE * 2, 28)
  out.writeUInt16LE(2, 32)
  out.writeUInt16LE(16, 34)
  out.write('data', 36, 'latin1')
  out.writeUInt32LE(n * 2, 40)
  // A tone, so every stretch of speech has energy.
  for (let i = 0; i < n; i++) out.writeInt16LE(Math.round(Math.sin(i / 3) * loud(i) * 0x7fff), 44 + i * 2)
  return out
}
const seconds = piece => (readWav(piece).end - readWav(piece).start) / 2 / RATE

test('a short turn, or a body that is not a WAV, goes to the ears whole', () => {
  const short = wav(12)
  assert.deepEqual(splitWav(short), [short])
  const odd = Buffer.from('RIFFWAV')
  assert.deepEqual(splitWav(odd), [odd])
})

test('long speech is cut into pieces the ears can hold, with no sample lost', () => {
  // 75 s: past the 1536-token context of the ears when sent whole (the engine refused it).
  const long = wav(75)
  const pieces = splitWav(long)
  assert.equal(pieces.length, 3)
  for (const piece of pieces) {
    assert.ok(seconds(piece) <= MAX_PIECE_SECONDS, `${seconds(piece)} s`)
    assert.equal(readWav(piece).rate, RATE)
  }
  const total = pieces.reduce((sum, piece) => sum + seconds(piece), 0)
  assert.equal(Math.round(total * RATE), 75 * RATE)
  // The samples come back in order.
  const joined = Buffer.concat(pieces.map(piece => piece.subarray(readWav(piece).start)))
  assert.ok(joined.equals(long.subarray(44)))
})

test('a piece is cut at the quietest moment before the limit, not in the middle of a word', () => {
  // A pause from 25.0 to 25.4 s (the user breathing); the rest is speech.
  const isPause = i => i >= 25 * RATE && i < 25.4 * RATE
  const pieces = splitWav(wav(40, i => (isPause(i) ? 0 : 0.5)))
  assert.equal(pieces.length, 2)
  const cut = seconds(pieces[0])
  assert.ok(cut > 25 && cut < 25.4, `cut at ${cut} s`)
})
