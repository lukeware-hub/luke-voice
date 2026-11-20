import { test } from 'node:test'
import assert from 'node:assert/strict'
import { pitchTrack, riseQuestion } from './question-rise.js'

const FS = 24_000
// A voiced-like sound: a 220 Hz tone with harmonics, phase-continuous.
const voice = (seconds, hz = 220) => {
  const x = new Float32Array(Math.round(FS * seconds))
  for (let i = 0; i < x.length; i++) {
    const p = (2 * Math.PI * hz * i) / FS
    x[i] = 0.4 * Math.sin(p) + 0.2 * Math.sin(2 * p) + 0.1 * Math.sin(3 * p)
  }
  return x
}
const semitonesOver = (x, fromSeconds, toSeconds) => {
  const { frames } = pitchTrack(x.subarray(Math.round(FS * fromSeconds), Math.round(FS * toSeconds)), FS)
  const hz = frames.filter(f => f.hz).map(f => f.hz).sort((a, b) => a - b)
  return 12 * Math.log2(hz[Math.floor(hz.length / 2)] / 220)
}

test('the pitch tracker finds a steady 220 Hz voice', () => {
  const st = semitonesOver(voice(1), 0, 1)
  assert.ok(Math.abs(st) < 0.3, `off by ${st.toFixed(2)} semitones`)
})

test('the end of a question rises, the start is untouched, and the length is kept', () => {
  const x = voice(1.5)
  const y = riseQuestion(x, FS)
  assert.equal(y.length, x.length)
  for (let i = 0; i < FS * 0.8; i++) assert.equal(y[i], x[i], `sample ${i} changed`)
  const rise = semitonesOver(y, 1.2, 1.45)
  assert.ok(rise > 3 && rise < 8, `rise at the end: ${rise.toFixed(1)} semitones`)
  assert.ok(Math.abs(semitonesOver(y, 0.2, 0.8)) < 0.3, 'the start keeps its pitch')
  assert.ok(y.every(v => v >= -1 && v <= 1))
})

test('silence and too little voice come back unchanged', () => {
  const silence = new Float32Array(FS)
  assert.equal(riseQuestion(silence, FS), silence)
  const short = new Float32Array(FS)
  short.set(voice(0.1), FS / 2)
  assert.equal(riseQuestion(short, FS), short)
})

test('noise is left alone', () => {
  let seed = 7
  const noise = Float32Array.from({ length: FS }, () => ((seed = (seed * 16807) % 2147483647) / 2147483647 - 0.5) * 0.2)
  assert.equal(riseQuestion(noise, FS), noise)
})
