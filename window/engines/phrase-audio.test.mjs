import assert from 'node:assert/strict'
import { test } from 'node:test'

import { COMMA_PAUSE_S, trimEdges } from './phrase-audio.js'

const RATE = 24_000
// `lead` s of silence, `speech` s of a tone, `trail` s of silence.
const phrase = (lead, speech, trail) => {
  const out = new Float32Array(Math.round((lead + speech + trail) * RATE))
  const from = Math.round(lead * RATE)
  const to = from + Math.round(speech * RATE)
  for (let i = from; i < to; i++) out[i] = 0.3 * Math.sin(i / 5)
  return out
}

test('the silence is cut only from the sides that meet at a comma, keeping a few ms', () => {
  const audio = phrase(0.4, 1, 0.3)
  const both = trimEdges(audio, RATE, { start: true, end: true })
  // ~1 s of speech plus at most ~2 x (20 ms frame + 30 ms kept).
  assert.ok(both.length / RATE >= 1 && both.length / RATE <= 1.1, String(both.length / RATE))
  const endOnly = trimEdges(audio, RATE, { end: true })
  assert.ok(Math.abs(endOnly.length / RATE - 1.4) < 0.06, String(endOnly.length / RATE))
  const startOnly = trimEdges(audio, RATE, { start: true })
  assert.ok(Math.abs(startOnly.length / RATE - 1.3) < 0.06, String(startOnly.length / RATE))
  // Nothing asked: the very same audio.
  assert.equal(trimEdges(audio, RATE), audio)
})

test('a phrase with no silence at its edges, or no sound at all, is handled', () => {
  const tight = phrase(0, 0.5, 0)
  assert.equal(trimEdges(tight, RATE, { start: true, end: true }).length, tight.length)
  assert.equal(trimEdges(new Float32Array(RATE), RATE, { start: true, end: true }).length, 0)
  assert.equal(trimEdges(new Float32Array(0), RATE, { start: true }).length, 0)
})

test('the comma pause is short: a breath inside the sentence, not a sentence end', () => {
  assert.ok(COMMA_PAUSE_S >= 0.15 && COMMA_PAUSE_S <= 0.3)
})
