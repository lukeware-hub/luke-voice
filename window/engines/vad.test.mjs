import assert from 'node:assert/strict'
import { test } from 'node:test'

import { FRAME, createVad, rms } from './vad.js'

const tone = level => Float32Array.from({ length: FRAME }, (_, i) => level * Math.sin(i / 3) * Math.SQRT2)
const silence = () => new Float32Array(FRAME)
const noise = level => Float32Array.from({ length: FRAME }, (_, i) => (i % 2 ? level : -level))

function feed(vad, frames, options) {
  const events = []
  for (const frame of frames) {
    const event = vad.push(frame, options)
    if (event) events.push(event)
  }
  return events
}

test('rms of a constant-level signal is that level', () => {
  assert.ok(Math.abs(rms(noise(0.1)) - 0.1) < 1e-6)
})

test('speech after silence starts an utterance, and silence ends it with the audio and a preroll', () => {
  const vad = createVad()
  const events = feed(vad, [...Array(20).fill(0).map(silence), ...Array(30).fill(0).map(() => tone(0.1)), ...Array(30).fill(0).map(silence)])
  assert.deepEqual(events.map(e => e.type), ['start', 'end'])
  const audio = events[1].audio
  assert.ok(audio instanceof Float32Array)
  // preroll (10) + speech after start (27) + silence until end (25)
  assert.equal(audio.length, (10 + 27 + 25) * FRAME)
})

test('a short blip is dropped instead of being transcribed', () => {
  const vad = createVad()
  const events = feed(vad, [...Array(4).fill(0).map(() => tone(0.1)), ...Array(30).fill(0).map(silence)])
  assert.deepEqual(events.map(e => e.type), ['start', 'drop'])
})

test('steady room noise raises the floor, so it never counts as speech', () => {
  const vad = createVad()
  const events = feed(vad, Array(400).fill(0).map(() => noise(0.011)))
  assert.deepEqual(events, [])
  assert.ok(vad.floor > 0.005)
})

test('while Luke speaks, a quiet echo does not interrupt but loud speech barges in', () => {
  const echo = feed(createVad(), Array(40).fill(0).map(() => tone(0.02)), { isSpeaking: true })
  assert.deepEqual(echo, [])
  const loud = feed(createVad(), Array(40).fill(0).map(() => tone(0.2)), { isSpeaking: true })
  assert.equal(loud[0]?.type, 'barge')
})

test('a muted reset forgets a half-heard utterance', () => {
  const vad = createVad()
  feed(vad, Array(10).fill(0).map(() => tone(0.1)))
  assert.equal(vad.inSpeech, true)
  vad.reset()
  assert.equal(vad.inSpeech, false)
})
