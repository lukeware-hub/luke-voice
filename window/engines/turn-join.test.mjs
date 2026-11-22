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

test('a held user turn reaches the history once, when committed, and a joined one never does', async () => {
  const { createTurnLog } = await import('./turn-join.js')
  const log = createTurnLog()
  const effects = []
  log.said('Posso começar?')
  // "é..." ended a turn, then the user went on: that turn is dropped and its words replaced.
  log.hold('é', () => effects.push('é'))
  assert.deepEqual(log.history().map(t => t.text), ['Posso começar?', 'é'], 'the brain answering it reads the held words')
  log.drop()
  log.hold('é, sim, pode', () => effects.push('é, sim, pode'))
  log.commit()
  log.commit()
  assert.deepEqual(log.history(), [{ role: 'luke', text: 'Posso começar?' }, { role: 'user', text: 'é, sim, pode' }])
  assert.deepEqual(effects, ['é, sim, pode'], 'the effects of a turn (letting go of the "posso?") run once, only for the turn that stands')
  // A new hold replaces one that was never committed (it was joined), with no effect.
  log.hold('a', () => effects.push('a'))
  log.hold('a b', () => effects.push('a b'))
  log.commit()
  assert.deepEqual(effects, ['é, sim, pode', 'a b'])
})

test('the turn log keeps only what the brain reads, and remembers Ceci\'s last line', async () => {
  const { MAX_TURNS, createTurnLog } = await import('./turn-join.js')
  const log = createTurnLog()
  log.said('primeira')
  for (let i = 0; i < 50; i++) {
    log.hold(`u${i}`)
    log.commit()
  }
  assert.equal(log.size, MAX_TURNS)
  assert.equal(log.history().length, MAX_TURNS)
  assert.equal(log.history().at(-1).text, 'u49')
  assert.equal(log.lastSaid, 'primeira')
  log.hold('agora')
  assert.equal(log.history().length, MAX_TURNS)
  assert.equal(log.history().at(-1).text, 'agora')
})

test('a reply cut off by a sound comes back when the sound was no speech, once', async () => {
  const { createCutReply } = await import('./turn-join.js')
  const cut = createCutReply()
  assert.equal(cut.take(), '', 'nothing was cut')
  assert.equal(cut.isCut, false)
  cut.cut('O teste passou.')
  assert.equal(cut.isCut, true)
  assert.equal(cut.take(), 'O teste passou.', 'a cough: say it again')
  assert.equal(cut.isCut, false)
  assert.equal(cut.take(), '', 'only once')
  cut.cut('primeira')
  cut.cut('segunda')
  assert.equal(cut.take(), 'segunda', 'the last reply cut is the one to say again')
  cut.cut('esquecida')
  cut.clear()
  assert.equal(cut.take(), '', 'the mic was muted: let it go')
})
