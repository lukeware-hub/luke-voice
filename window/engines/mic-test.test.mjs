import assert from 'node:assert/strict'
import { test } from 'node:test'

import { analyzeRecording, encodeWav, meterLevel } from './mic-test.js'

const RATE = 16000

// A repeatable "speech": 0.4 s of room, then a voiced tone with a syllable rhythm, over a noise floor.
function clip({ voice, noise = 0, seconds = 5, clip: hard = false }) {
  let seed = 7
  const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647) * 2 - 1
  const audio = new Float32Array(RATE * seconds)
  for (let i = 0; i < audio.length; i++) {
    const t = i / RATE
    const speaking = t > 0.4
    const syllable = 0.55 + 0.45 * Math.sin(2 * Math.PI * 3 * t)
    let sample = speaking ? voice * syllable * Math.sin(2 * Math.PI * 180 * t) * 1.4 : 0
    sample += noise * rand()
    audio[i] = hard ? Math.max(-1, Math.min(1, sample * 6)) : sample
  }
  return audio
}

test('a clear voice over a quiet room is perfect or good', () => {
  const result = analyzeRecording(clip({ voice: 0.15, noise: 0.002 }), RATE)
  assert.ok(['perfeito', 'bom'].includes(result.quality), JSON.stringify(result))
  assert.ok(result.score >= 70)
})

test('silence is the worst', () => {
  const result = analyzeRecording(new Float32Array(RATE * 5), RATE)
  assert.equal(result.quality, 'pessimo')
  assert.equal(result.score, 0)
})

test('a clip that is too short is the worst, with a tip to record again', () => {
  const result = analyzeRecording(new Float32Array(1000), RATE)
  assert.equal(result.quality, 'pessimo')
  assert.match(result.tips[0], /curta/)
})

test('a very quiet voice is poor and says to get closer', () => {
  const result = analyzeRecording(clip({ voice: 0.004, noise: 0.0002 }), RATE)
  assert.ok(['pessimo', 'ruim', 'mais-ou-menos'].includes(result.quality), JSON.stringify(result))
  assert.ok(result.tips.some(tip => /perto|baixa/.test(tip)))
})

test('a loud room around the voice is poor', () => {
  const result = analyzeRecording(clip({ voice: 0.1, noise: 0.1 }), RATE)
  assert.ok(['pessimo', 'ruim', 'mais-ou-menos'].includes(result.quality), JSON.stringify(result))
  assert.ok(result.tips.some(tip => /ruído/i.test(tip)))
})

test('a clipped voice is penalised and says it distorts', () => {
  const clean = analyzeRecording(clip({ voice: 0.15, noise: 0.002 }), RATE)
  const hard = analyzeRecording(clip({ voice: 0.3, noise: 0.002, clip: true }), RATE)
  assert.ok(hard.score < clean.score)
  assert.ok(hard.clipped > 0.01)
  assert.ok(hard.tips.some(tip => /estour|distor/i.test(tip)))
})

test('the verdict is always one of the five names', () => {
  for (const voice of [0.001, 0.02, 0.1, 0.4]) {
    const { quality } = analyzeRecording(clip({ voice, noise: 0.003 }), RATE)
    assert.ok(['pessimo', 'ruim', 'mais-ou-menos', 'bom', 'perfeito'].includes(quality))
  }
})

test('the live meter runs from 0 (silence) to 1 (full scale)', () => {
  assert.equal(meterLevel(new Float32Array(512)), 0)
  assert.equal(meterLevel(new Float32Array(512).fill(1)), 1)
  const mid = meterLevel(new Float32Array(512).fill(0.03))
  assert.ok(mid > 0 && mid < 1)
})

test('encodeWav writes a playable 16-bit mono WAV of the clip', () => {
  const audio = new Float32Array([0, 0.5, -0.5, 1, -1, 2])
  const bytes = new Uint8Array(encodeWav(audio, RATE))
  const view = new DataView(bytes.buffer)
  const text = (at, n) => String.fromCharCode(...bytes.slice(at, at + n))
  assert.equal(bytes.length, 44 + audio.length * 2)
  assert.equal(text(0, 4), 'RIFF')
  assert.equal(view.getUint32(4, true), 36 + audio.length * 2)
  assert.equal(text(8, 4), 'WAVE')
  assert.equal(view.getUint16(20, true), 1, 'PCM')
  assert.equal(view.getUint16(22, true), 1, 'mono')
  assert.equal(view.getUint32(24, true), RATE)
  assert.equal(view.getUint16(34, true), 16, '16-bit')
  assert.equal(text(36, 4), 'data')
  assert.equal(view.getUint32(40, true), audio.length * 2)
  const samples = Array.from({ length: audio.length }, (_, i) => view.getInt16(44 + i * 2, true))
  assert.deepEqual(samples, [0, 16384, -16384, 32767, -32768, 32767])
})
