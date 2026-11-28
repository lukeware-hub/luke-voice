import assert from 'node:assert/strict'
import { test } from 'node:test'

import { COMMA_PAUSE_S, ELLIPSIS_PAUSE_S, MAX_INNER_PAUSE_S, SENTENCE_PAUSE_S, capPauses, pauseAfter, sentenceLeft, trimEdges } from './phrase-audio.js'

test('a long silence inside a chunk is cut down to a sentence pause; short ones and the edges stay', () => {
  const rate = 24_000
  const tone = s => Float32Array.from({ length: Math.round(rate * s) }, (_, i) => 0.5 * Math.sin(i / 3))
  const quiet = s => new Float32Array(Math.round(rate * s))
  const join = parts => {
    const out = new Float32Array(parts.reduce((n, p) => n + p.length, 0))
    let at = 0
    for (const p of parts) (out.set(p, at), (at += p.length))
    return out
  }
  // "Boa noite! [1.38 s] Tudo bem? [0.1 s] Eu sou o Luke." -> the long silence becomes MAX_INNER_PAUSE_S.
  const take = join([quiet(0.3), tone(0.5), quiet(1.38), tone(0.4), quiet(0.1), tone(0.6), quiet(0.4)])
  const out = capPauses(take, rate)
  const lost = (take.length - out.length) / rate
  assert.ok(Math.abs(lost - (1.38 - MAX_INNER_PAUSE_S)) < 0.03, `cut ${lost} s`)
  // Nothing to cut: the same audio back.
  const short = join([tone(0.5), quiet(0.2), tone(0.5)])
  assert.equal(capPauses(short, rate), short)
  assert.equal(capPauses(new Float32Array(0), rate).length, 0)
  // The pauses after . ! ? are shorter than before (0.24 s, 0.34 s).
  assert.equal(SENTENCE_PAUSE_S, 0.2)
  assert.equal(ELLIPSIS_PAUSE_S, 0.3)
})

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
  assert.ok(COMMA_PAUSE_S >= 0.1 && COMMA_PAUSE_S <= 0.3)
})

test('a reply starts once the audio ready covers what is left to make, so no comma pause turns into a gap', async () => {
  const { isReadyToStart } = await import('./phrase-audio.js')
  // "Certo," (6 characters) made in 0.6 s and 0.5 s long; 40 characters still to make (~4 s): wait.
  assert.equal(isReadyToStart({ readyS: 0.7, madeS: 0.6, madeChars: 6, leftChars: 40 }), false)
  // Most of the line made, and plenty ready to play: start.
  assert.equal(isReadyToStart({ readyS: 3.5, madeS: 2, madeChars: 46, leftChars: 6 }), true)
  // The last phrase is in: start, however long it took.
  assert.equal(isReadyToStart({ readyS: 0.4, madeS: 3, madeChars: 50, leftChars: 0 }), true)
})

test('each mark gets its own steady pause: a comma short, a sentence end a little longer, "…" longest', () => {
  assert.ok(COMMA_PAUSE_S < SENTENCE_PAUSE_S && SENTENCE_PAUSE_S < ELLIPSIS_PAUSE_S)
  // Shorter than the voice's own silence at a sentence end (0.42 s on average, up to ~1 s).
  assert.ok(SENTENCE_PAUSE_S >= 0.2 && SENTENCE_PAUSE_S <= 0.35)
  assert.equal(pauseAfter('Certo,'), COMMA_PAUSE_S)
  for (const phrase of ['Pronto.', 'Bom dia, Diego!', 'Posso rodar?', 'Ele disse "oi."', 'Será?!']) assert.equal(pauseAfter(phrase), SENTENCE_PAUSE_S, phrase)
  for (const phrase of ['Bom…', 'Hmm...']) assert.equal(pauseAfter(phrase), ELLIPSIS_PAUSE_S, phrase)
  // A long sentence cut at a space goes on: the short pause, never a sentence end.
  assert.equal(pauseAfter('O build falhou por causa de uma variável que faltava no'), COMMA_PAUSE_S)
})

test('only the rest of the sentence counts before Ceci starts, not the rest of the reply', () => {
  const parts = ['Certo,', 'vou olhar isso agora.', 'Depois eu te conto,', 'tá?']
  assert.equal(sentenceLeft(parts, 0), 'vou olhar isso agora.'.length)
  assert.equal(sentenceLeft(parts, 1), 0)
  assert.equal(sentenceLeft(parts, 2), 3)
  assert.equal(sentenceLeft(parts, 3), 0)
  // A sentence cut at a space continues in the next part.
  assert.equal(sentenceLeft(['uma frase muito longa que', 'continua aqui.', 'Outra.'], 0), 'continua aqui.'.length)
})
