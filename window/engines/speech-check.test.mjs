import assert from 'node:assert/strict'
import { test } from 'node:test'

import { MIN_SPEECH_FRAMES, countFrame, hasSpeech } from './speech-check.js'

const counted = scores => scores.reduce(countFrame, { frames: 0, soft: 0 })

// Silero's scores (one per 32 ms frame) for a soft, quick "sim" raised ~11x: only a few frames
// reach 0.5, the rest of the word sits between 0.3 and 0.5.
const SOFT_SIM = [0.05, 0.1, 0.35, 0.42, 0.55, 0.61, 0.48, 0.38, 0.2, 0.05]
// A fan or a click: low scores, maybe one frame over the lower bar.
const NOISE = [0.02, 0.05, 0.31, 0.12, 0.08, 0.04, 0.1, 0.06, 0.03, 0.02, 0.01, 0.04]

test('a frame counts as speech above 0.5, and as a soft frame above 0.3', () => {
  assert.deepEqual(counted([0.5, 0.51, 0.3, 0.31, 0.1]), { frames: 1, soft: 3 }, 'a speech frame is a soft frame too')
})

test('clear speech passes with or without a "ok?" waiting', () => {
  const clear = counted(Array(MIN_SPEECH_FRAMES).fill(0.9))
  assert.equal(hasSpeech(clear), true)
  assert.equal(hasSpeech(clear, { isAnswer: true }), true)
})

test('a soft short "sim" is noise to the plain check, but passes while a "ok?" waits', () => {
  const sim = counted(SOFT_SIM)
  assert.equal(hasSpeech(sim), false, 'the plain bar still drops it, as before')
  assert.equal(hasSpeech(sim, { isAnswer: true }), true, 'right after "ok?" the answer is heard')
})

test('noise is dropped even while a "ok?" waits', () => {
  assert.equal(hasSpeech(counted(NOISE)), false)
  assert.equal(hasSpeech(counted(NOISE), { isAnswer: true }), false)
  assert.equal(hasSpeech(counted([]), { isAnswer: true }), false)
  assert.equal(hasSpeech(undefined, { isAnswer: true }), false)
})
