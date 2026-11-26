// The pauses between the parts Ceci says. The natural voice says a reply phrase by phrase
// (speech-text.js, phrases), and each phrase comes back with its own silence before and after it:
// 0 to 860 ms, measured on Qwen3-TTS with Ceci's voice. Back to back, that made a comma last 0.3 to
// 0.6 s and a sentence end up to 1.4 s, longer than a person pauses there. So the silence is cut from
// both sides of every phrase, and the page puts one steady pause of its own after it.

// A short, natural pause inside a sentence in pt-BR.
export const COMMA_PAUSE_S = 0.15
// After a sentence (. ! ?), a little longer; after "...", longer still, as a person trails off.
export const SENTENCE_PAUSE_S = 0.3
export const ELLIPSIS_PAUSE_S = 0.4
// A frame quieter than this share of the phrase's loudest frame is silence.
const SILENCE_SHARE = 0.06
// What is kept of the silence at a cut edge, so a soft start or a fading end is not clipped.
const KEEP_S = 0.03
const FRAME_S = 0.02

// The phrase without its silence at the start (`start`) and/or the end (`end`).
export function trimEdges(audio, rate, { start = false, end = false } = {}) {
  if ((!start && !end) || audio.length === 0) return audio
  const frame = Math.max(1, Math.round(rate * FRAME_S))
  const levels = []
  for (let at = 0; at < audio.length; at += frame) {
    let sum = 0
    const to = Math.min(audio.length, at + frame)
    for (let i = at; i < to; i++) sum += audio[i] * audio[i]
    levels.push(Math.sqrt(sum / (to - at)))
  }
  const bar = Math.max(...levels) * SILENCE_SHARE
  const first = levels.findIndex(level => level > bar)
  // All silence: nothing to say, nothing to keep.
  if (first < 0) return audio.subarray(0, 0)
  let last = levels.length - 1
  while (levels[last] <= bar) last--
  const keep = Math.round(rate * KEEP_S)
  const from = start ? Math.max(0, first * frame - keep) : 0
  const to = end ? Math.min(audio.length, (last + 1) * frame + keep) : audio.length
  return audio.subarray(from, to)
}

const SENTENCE_END = /[.!?…]["'”’»)\]]*$/
const ELLIPSIS_END = /(?:…|\.\.\.)["'”’»)\]]*$/

// The pause after a phrase, by how it ends.
export function pauseAfter(phrase) {
  if (ELLIPSIS_END.test(phrase)) return ELLIPSIS_PAUSE_S
  return SENTENCE_END.test(phrase) ? SENTENCE_PAUSE_S : COMMA_PAUSE_S
}

// The characters still to make in the sentence of phrase `i`: the phrases after it, up to the one
// that ends the sentence.
export function sentenceLeft(phrases, i) {
  let left = 0
  for (let j = i; j + 1 < phrases.length && !SENTENCE_END.test(phrases[j]); j++) left += phrases[j + 1].length
  return left
}

// Whether the held phrases may start playing. Once a phrase plays, the next must be ready by the
// time it and its pause end, or the pause stretches into a gap ("Certo," lasts 0.5 s, the long
// phrase after it takes 1.5 s to make). So a sentence starts once the audio ready to play covers
// what is left of it to make, at the speed the voice made it so far (with a margin); with nothing
// left of it to make, at once. Only the sentence counts, not the whole reply: Ceci starts as soon
// as her first sentence is ready, and the next one is made while she says it.
const MARGIN = 1.15
export function isReadyToStart({ readyS, madeS, madeChars, leftChars }) {
  if (leftChars <= 0 || madeChars <= 0) return leftChars <= 0
  return readyS >= (madeS / madeChars) * leftChars * MARGIN
}
