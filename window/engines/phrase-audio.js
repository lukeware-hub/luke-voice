// The pause at a comma. The natural voice says a chunk phrase by phrase (speech-text.js, phrases),
// and each phrase comes back with its own silence before and after it: 0 to 400 ms, measured on
// Qwen3-TTS with Ceci's voice. Back to back, that made a comma last 0.3 to 0.6 s, longer than a
// person pauses there. So the silence is cut from the sides that meet at a comma, and the page puts
// one steady pause of its own between them.

// A short, natural pause inside a sentence in pt-BR.
export const COMMA_PAUSE_S = 0.2
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
