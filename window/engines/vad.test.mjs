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
  // preroll (10 lead-in + 8 barge frames) + speech after start (27) + silence until end (25)
  assert.equal(audio.length, (18 + 27 + 25) * FRAME)
})

test('the room is not learned while Ceci speaks, so the user talking over her still barges in', () => {
  const vad = createVad()
  const floorBefore = vad.floor
  // The user talks softly over Ceci: below the barge bar, so not an interruption yet.
  feed(vad, Array(200).fill(0).map(() => tone(0.025)), { isSpeaking: true })
  assert.equal(vad.floor, floorBefore)
  // Then louder: it must still interrupt.
  const events = feed(vad, Array(20).fill(0).map(() => tone(0.2)), { isSpeaking: true })
  assert.equal(events[0]?.type, 'barge')
})

test('an interruption keeps the frames that set it off and a lead-in before them', () => {
  const vad = createVad()
  feed(vad, Array(30).fill(0).map(silence), { isSpeaking: true })
  const events = feed(vad, [...Array(20).fill(0).map(() => tone(0.2)), ...Array(30).fill(0).map(silence)], { isSpeaking: true })
  assert.deepEqual(events.map(e => e.type), ['barge', 'end'])
  // 8 loud frames set it off; the 30 quiet frames before them fit in the 50 kept while Ceci speaks.
  const kept = events[1].audio
  const firstLoud = kept.findIndex(v => Math.abs(v) > 0.01)
  assert.equal(Math.floor(firstLoud / FRAME), 30)
})

test('speech with quiet dips between syllables still barges in, and keeps its first words', () => {
  const vad = createVad()
  feed(vad, Array(20).fill(0).map(silence), { isSpeaking: true })
  // Two loud frames, one quiet dip, over and over: never 8 in a row.
  const syllables = Array.from({ length: 30 }, (_, i) => (i % 3 === 2 ? silence() : tone(0.2)))
  const events = feed(vad, [...syllables, ...Array(30).fill(0).map(silence)], { isSpeaking: true })
  assert.deepEqual(events.map(e => e.type), ['barge', 'end'])
  const kept = events[1].audio
  // The first syllable is in the audio: nothing before frame 20 was dropped.
  assert.equal(Math.floor(kept.findIndex(v => Math.abs(v) > 0.01) / FRAME), 20)
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

test('while Ceci speaks, a quiet echo does not interrupt but loud speech barges in', () => {
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
