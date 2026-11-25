import assert from 'node:assert/strict'
import { test } from 'node:test'

import { MAX_GAIN, PEAK, TARGET_RMS, normalizeSpeech, speechLevel } from './gain.js'

const tone = (level, samples) => Float32Array.from({ length: samples }, (_, i) => level * Math.sin(i / 3) * Math.SQRT2)
const join = (...parts) => {
  const out = new Float32Array(parts.reduce((n, p) => n + p.length, 0))
  let at = 0
  for (const part of parts) {
    out.set(part, at)
    at += part.length
  }
  return out
}

test('the speech level ignores the silence around it', () => {
  const clip = join(new Float32Array(16_000), tone(0.02, 16_000), new Float32Array(16_000))
  assert.ok(Math.abs(speechLevel(clip) - 0.02) < 0.002)
})

test('a quiet voice is raised to the target level, in a new array', () => {
  const clip = join(new Float32Array(8000), tone(0.02, 16_000), new Float32Array(8000))
  const { audio, gain } = normalizeSpeech(clip)
  assert.notEqual(audio, clip)
  assert.ok(Math.abs(gain - TARGET_RMS / 0.02) < 0.5)
  assert.ok(Math.abs(speechLevel(audio) - TARGET_RMS) < 0.01)
  // The original is untouched (the detector and the echo estimate keep the mic as it is).
  assert.ok(Math.abs(speechLevel(clip) - 0.02) < 0.002)
})

test('a normal or loud voice goes through as is', () => {
  for (const level of [0.1, 0.3]) {
    const clip = tone(level, 16_000)
    const { audio, gain } = normalizeSpeech(clip)
    assert.equal(audio, clip)
    assert.equal(gain, 1)
  }
})

test('the gain is capped, so a near-silent clip is not blown up into hiss', () => {
  const { gain } = normalizeSpeech(tone(0.0005, 16_000))
  assert.equal(gain, MAX_GAIN)
})

test('nothing clips: a loud click caps the gain', () => {
  const clip = tone(0.01, 16_000)
  clip[100] = 0.5
  const { audio, gain } = normalizeSpeech(clip)
  assert.ok(gain <= PEAK / 0.5 + 1e-6)
  assert.ok(Math.max(...audio.map(Math.abs)) <= PEAK + 1e-6)
})

test('silence and empty clips come back unchanged', () => {
  for (const clip of [new Float32Array(0), new Float32Array(16_000), new Float32Array(100)]) {
    const { audio, gain } = normalizeSpeech(clip)
    assert.equal(audio, clip)
    assert.equal(gain, 1)
  }
})
