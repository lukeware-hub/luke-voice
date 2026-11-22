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
  const events = feed(vad, [...Array(20).fill(0).map(silence), ...Array(30).fill(0).map(() => tone(0.1)), ...Array(45).fill(0).map(silence)])
  assert.deepEqual(events.map(e => e.type), ['start', 'end'])
  const audio = events[1].audio
  assert.ok(audio instanceof Float32Array)
  // preroll (10 lead-in + 8 barge frames) + speech after start (27) + silence until end (40)
  assert.equal(audio.length, (18 + 27 + 40) * FRAME)
})

test('a breath of about 1 s in the middle of a sentence does not end the turn', () => {
  const vad = createVad()
  const speech = () => Array(20).fill(0).map(() => tone(0.1))
  const breath = Array(31).fill(0).map(silence) // ~1 s
  const events = feed(vad, [...Array(20).fill(0).map(silence), ...speech(), ...breath, ...speech(), ...Array(45).fill(0).map(silence)])
  assert.deepEqual(events.map(e => e.type), ['start', 'end'])
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
  const events = feed(vad, [...Array(20).fill(0).map(() => tone(0.2)), ...Array(45).fill(0).map(silence)], { isSpeaking: true })
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
  const events = feed(vad, [...syllables, ...Array(45).fill(0).map(silence)], { isSpeaking: true })
  assert.deepEqual(events.map(e => e.type), ['barge', 'end'])
  const kept = events[1].audio
  // The first syllable is in the audio: nothing before frame 20 was dropped.
  assert.equal(Math.floor(kept.findIndex(v => Math.abs(v) > 0.01) / FRAME), 20)
})

test('a short blip is dropped instead of being transcribed', () => {
  const vad = createVad()
  const events = feed(vad, [...Array(4).fill(0).map(() => tone(0.1)), ...Array(45).fill(0).map(silence)])
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

test('with a turn model, a short pause makes one candidate, and endNow ends the utterance there', () => {
  const vad = createVad({ candidateFrames: 12, endFrames: 38 })
  const events = feed(vad, [...Array(20).fill(0).map(() => tone(0.1)), ...Array(12).fill(0).map(silence)])
  assert.deepEqual(events.map(e => e.type), ['start', 'candidate'])
  const candidate = events[1]
  assert.ok(candidate.audio.length > 0)
  const end = vad.endNow(candidate.id)
  assert.equal(end.type, 'end')
  assert.equal(vad.inSpeech, false)
  // Only one candidate per pause, and nothing after the end.
  assert.deepEqual(feed(vad, Array(10).fill(0).map(silence)), [])
})

test('a candidate the turn model rejects waits for the long silence, and speech in between makes the answer stale', () => {
  const vad = createVad({ candidateFrames: 12, endFrames: 38 })
  const first = feed(vad, [...Array(20).fill(0).map(() => tone(0.1)), ...Array(12).fill(0).map(silence)])
  const stale = first.find(e => e.type === 'candidate')
  // The user goes on talking: the old candidate can no longer end the utterance.
  feed(vad, Array(10).fill(0).map(() => tone(0.1)))
  assert.equal(vad.endNow(stale.id), null)
  // No answer for the new pause: the long silence ends it.
  const rest = feed(vad, Array(38).fill(0).map(silence))
  assert.deepEqual(rest.map(e => e.type), ['candidate', 'end'])
})

test('without a turn model there are no candidates, as before', () => {
  const events = feed(createVad(), [...Array(20).fill(0).map(() => tone(0.1)), ...Array(45).fill(0).map(silence)])
  assert.deepEqual(events.map(e => e.type), ['start', 'end'])
})

// What a VAD makes of a list of frames: each event with the frame it came on and its audio length.
function trace(vad, frames, options) {
  return frames.flatMap((frame, i) => {
    const event = vad.push(frame, options)
    return event ? [{ type: event.type, at: i, samples: event.audio?.length ?? 0 }] : []
  })
}

// Speech as it comes: syllables with quiet dips, words, breaths, and a long sentence with no dip at all.
function speechFixture() {
  const out = Array.from({ length: 30 }, silence)
  const syllables = n => Array.from({ length: n }, (_, i) => (i % 4 === 3 ? tone(0.004) : tone(0.08 + 0.04 * Math.sin(i))))
  for (const length of [40, 90, 25, 150]) out.push(...syllables(length), ...Array.from({ length: 20 }, silence))
  // ~5 s with every frame loud (a fast speaker in a reverberant room), then the end of the turn.
  out.push(...Array.from({ length: 160 }, (_, i) => tone(0.06 + 0.03 * Math.sin(i / 2))), ...Array.from({ length: 70 }, silence))
  return out
}

test('the room creeping up changes nothing in how speech starts and ends', () => {
  for (const options of [{}, { candidateFrames: 22, endFrames: 62 }]) {
    const frames = speechFixture()
    const now = trace(createVad(options), frames)
    const before = trace(createVad({ ...options, creepFrames: 0 }), frames)
    assert.deepEqual(now, before)
    assert.ok(now.some(e => e.type === 'end'))
  }
})

test('a noise that switches on above the bar is absorbed in about 10 s, and speech over it still counts', () => {
  const frames = [...Array.from({ length: 30 }, silence), ...Array.from({ length: 625 }, () => noise(0.05))]
  const vad = createVad()
  const events = trace(vad, frames)
  // It looks like speech at first, then the floor catches up and the "utterance" ends (the speech
  // check drops it: no words in it).
  assert.equal(events[0].type, 'start')
  const end = events.find(e => e.type === 'end' || e.type === 'drop')
  const seconds = ((end.at - 30) * FRAME) / 16_000
  assert.ok(seconds >= 5 && seconds <= 20, `ended after ${seconds.toFixed(1)} s`)
  assert.equal(events.length, 2, 'nothing after: the noise is the room now')
  assert.ok(vad.floor * 3 > 0.05)
  // The user speaking over that noise still starts and ends a turn.
  const speech = trace(vad, [...Array.from({ length: 30 }, () => tone(0.3)), ...Array.from({ length: 45 }, () => noise(0.05))])
  assert.deepEqual(speech.map(e => e.type), ['start', 'end'])
  // Without the creep (as before 0.10.3) the same noise ran to the 30 s cap.
  const old = trace(createVad({ creepFrames: 0 }), frames)
  assert.deepEqual(old.map(e => e.type), ['start'])
})

test('the room is not learned from Ceci\'s own voice, even when it never pauses', () => {
  const vad = createVad()
  const floor = vad.floor
  feed(vad, Array.from({ length: 400 }, () => tone(0.05)), { isSpeaking: true })
  assert.equal(vad.floor, floor)
})

test('a pause hands the turn model only the last 8 s of a long utterance', () => {
  const vad = createVad({ candidateFrames: 12, endFrames: 38 })
  const talk = Array.from({ length: 400 }, (_, i) => (i % 5 === 4 ? silence() : tone(0.1)))
  const events = feed(vad, [...talk, ...Array.from({ length: 12 }, silence)])
  const candidate = events.find(e => e.type === 'candidate')
  assert.equal(candidate.audio.length, 8 * 16_000)
  // The tail: it ends with the 12 silent frames of the pause.
  assert.ok(candidate.audio.subarray(-12 * FRAME).every(v => v === 0))
  // The end still carries the whole utterance.
  const end = vad.endNow(candidate.id)
  assert.ok(end.audio.length > 8 * 16_000)
})
