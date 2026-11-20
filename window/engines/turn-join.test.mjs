import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createTurnJoiner } from './turn-join.js'

const clock = () => {
  let t = 0
  const now = () => t
  now.advance = ms => (t += ms)
  return now
}
const audio = (n, v) => new Float32Array(n).fill(v)

test('speech that resumes before Ceci answers is joined with the first part', () => {
  const now = clock()
  const j = createTurnJoiner({ now })
  const first = j.ended(audio(10, 1))
  assert.equal(first.isJoined, false)
  now.advance(1500)
  assert.equal(j.resumed(), true)
  assert.equal(j.isCurrent(first.turn), false, 'the first part is no longer the current turn')
  const second = j.ended(audio(5, 2))
  assert.equal(second.isJoined, true)
  assert.equal(second.audio.length, 10 + 4800 + 5)
  assert.equal(second.audio[0], 1)
  assert.equal(second.audio[10 + 4800], 2)
  assert.equal(second.audio[12], 0, 'silence between the parts')
  assert.equal(j.isCurrent(second.turn), true)
})

test('after Ceci starts answering, new speech is a new turn', () => {
  const now = clock()
  const j = createTurnJoiner({ now })
  const first = j.ended(audio(10, 1))
  j.commit(first.turn)
  now.advance(500)
  assert.equal(j.resumed(), false)
  assert.equal(j.isCurrent(first.turn), true)
  assert.equal(j.ended(audio(5, 2)).isJoined, false)
})

test('speech after the join window is a new turn', () => {
  const now = clock()
  const j = createTurnJoiner({ now })
  j.ended(audio(10, 1))
  now.advance(2600)
  assert.equal(j.resumed(), false)
})

test('a cough after the pause gives the first part back, so the request is not lost', () => {
  const now = clock()
  const j = createTurnJoiner({ now })
  const first = j.ended(audio(10, 1))
  now.advance(800)
  assert.equal(j.resumed(), true)
  const back = j.dropped()
  assert.equal(back.audio.length, 10)
  assert.equal(back.isJoined, false)
  assert.equal(j.isCurrent(back.turn), true)
  assert.notEqual(back.turn, first.turn)
  assert.equal(j.dropped(), null, 'nothing carried any more')
})

test('commit on an old turn does nothing to the current one', () => {
  const now = clock()
  const j = createTurnJoiner({ now })
  const first = j.ended(audio(10, 1))
  j.resumed()
  const second = j.ended(audio(5, 2))
  j.commit(first.turn)
  now.advance(100)
  assert.equal(j.resumed(), true, 'the joined turn is still open')
  assert.equal(j.isCurrent(second.turn), false)
})

test('a part handed to a worker (transferred) is still joined whole', () => {
  const now = clock()
  const j = createTurnJoiner({ now })
  const first = j.ended(audio(10, 1))
  // The light profile transfers the audio to its worker, which empties the array here.
  structuredClone(first.audio, { transfer: [first.audio.buffer] })
  assert.equal(first.audio.length, 0)
  now.advance(800)
  assert.equal(j.resumed(), true)
  const joined = j.ended(audio(5, 2))
  assert.equal(joined.audio.length, 10 + 4800 + 5)
  assert.equal(joined.audio[0], 1)
})
