import assert from 'node:assert/strict'
import { test } from 'node:test'

import { FS, take, wav } from './test-audio.mjs'
import { mkdtempSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { bestTake, createQuestionTakes, endRise, isNaturalRise, isYesNoQuestion, wavSamples } from './question-pick.mjs'

test('yes/no questions are picked; questions with a question word and statements are not', () => {
  for (const t of ['Posso começar?', 'Faço o commit agora?', 'Pronto, terminei. Quer que eu faça mais alguma coisa?', 'Você quer que eu abra o pull request?', 'Tudo bem?']) {
    assert.equal(isYesNoQuestion(t), true, t)
  }
  for (const t of ['O que vamos fazer hoje?', 'Olá, o que deseja?', 'Oi! Eu sou a Ceci. O que vamos fazer hoje?', 'Estou ótima! E você, o que vamos fazer hoje?', 'Em que posso ajudar?', 'Quando você quer o deploy?', 'Como foi?', 'Pronto, terminei.', '']) {
    assert.equal(isYesNoQuestion(t), false, t)
  }
})

test('the end rise is read off the voice: flat near 0, a glide up near its size', () => {
  assert.ok(Math.abs(endRise(take(1.5, 0), FS)) < 0.5)
  const up = endRise(take(1.5, 6), FS)
  assert.ok(up > 4.5 && up < 7, `rise ${up}`)
  assert.equal(endRise(new Float32Array(FS), FS), null) // silence: nothing to tell
  assert.equal(isNaturalRise(6), true)
  assert.equal(isNaturalRise(2), false)
  assert.equal(isNaturalRise(12), false)
  assert.equal(isNaturalRise(null), false)
})

test('with no natural take, the one nearest +6 semitones is kept, never a squeak', () => {
  assert.equal(bestTake([{ rise: 1 }, { rise: 3 }, { rise: 14 }]).rise, 3)
  assert.equal(bestTake([{ rise: null }, { rise: 12 }]).rise, null)
})

test('the samples of a streamed WAV are read even when its size is unknown', () => {
  const x = take(0.2, 0)
  const { samples, rate } = wavSamples(wav(x))
  assert.equal(rate, FS)
  assert.equal(samples.length, x.length)
  assert.ok(Math.abs(samples[100] - x[100]) < 1e-3)
})

test('in the background, takes are made only while no live line is wanted, and a live line stops them', async () => {
  const flat = wav(take(1.2, 0))
  const rising = wav(take(1.2, 6))
  const calls = []
  let release
  const say = (text, seed, signal) => {
    calls.push(seed)
    // The first background take hangs until a live line stops it.
    if (calls.length === 1) return new Promise(resolve => signal.addEventListener('abort', () => resolve(null)))
    return Promise.resolve(seed >= 104 ? rising : flat)
  }
  const dir = mkdtempSync(join(tmpdir(), 'luke-voice-takes-'))
  const takes = createQuestionTakes({ say, dir, voiceKey: 'v', idleMs: 20 })
  takes.warm(['Posso?'])
  await new Promise(r => setTimeout(r, 60))
  assert.deepEqual(calls, [101])
  const done = takes.live() // a live line: the hanging take is stopped
  await new Promise(r => setTimeout(r, 60))
  assert.deepEqual(calls, [101], 'nothing while the live line plays')
  done()
  await new Promise(r => setTimeout(r, 300))
  // Seed 101 again (it was stopped), then on until one rises (104); then it stops searching.
  assert.deepEqual(calls, [101, 101, 102, 103, 104])
  assert.ok((await takes.take('Posso?')).equals(rising))
  assert.equal(calls.length, 5)
  assert.equal(readdirSync(dir).filter(f => f.endsWith('.wav')).length, 1)
  // A new hub reads what was kept.
  const again = createQuestionTakes({ say: () => assert.fail('no take needed'), dir, voiceKey: 'v' })
  assert.ok((await again.take('Posso?')).equals(rising))
  // Another voice does not reuse it.
  const other = createQuestionTakes({ say: async () => null, dir, voiceKey: 'other' })
  assert.equal(await other.take('Posso?'), null)
  takes.stop()
  other.stop()
})

test('while the voice server is down, the background search backs off instead of spinning, and resumes when it is back', async () => {
  const flat = wav(take(1.2, 0))
  let isUp = false
  const calls = []
  const say = async seed => {
    calls.push(seed)
    return isUp ? flat : null
  }
  const dir = mkdtempSync(join(tmpdir(), 'luke-voice-takes-'))
  const takes = createQuestionTakes({ say: (_text, seed) => say(seed), dir, voiceKey: 'v', idleMs: 0, retryMs: 50 })
  takes.warm(['Posso?'])
  // Retries at about 0, 50, 150 and 350 ms: never a take every few milliseconds.
  await new Promise(r => setTimeout(r, 300))
  assert.ok(calls.length >= 2 && calls.length <= 4, `${calls.length} takes asked of a server that is down`)
  isUp = true
  await new Promise(r => setTimeout(r, 700))
  // Back up: the next retry works, and the search goes on at full speed through every seed.
  assert.deepEqual([...new Set(calls)], [101, 102, 103, 104, 105, 106, 107, 108])
  takes.stop()
})
