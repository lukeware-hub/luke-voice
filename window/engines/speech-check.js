// Is there speech in a clip, before the ears hear it? Silero scores every 32 ms frame; a clip with
// too few speech frames is noise (a fan, typing) and never reaches the ears, which would invent words.
//
// A short answer to Ceci's "ok?" is the hardest clip to pass: a quick "sim" has only ~200 ms of
// voice, and said softly (raised ~11x by gain.js) Silero scores most of its frames under 0.5, so the
// plain bar dropped it as noise and the user had to say it again. While a "ok?" waits for its
// answer, a frame also counts from a lower score, and fewer of them are enough: right after a
// question a short sound is far more likely the answer than noise, and the ears still have to
// write down a yes before anything runs (fast-path.js).

// A frame is speech from this Silero score.
export const SPEECH_SCORE = 0.5
// At least ~200 ms that Silero hears as speech, or the clip is noise.
export const MIN_SPEECH_FRAMES = 6
// While a "ok?" waits: a frame counts from this lower score...
export const ANSWER_SCORE = 0.3
// ...and ~130 ms of such frames is enough.
export const MIN_ANSWER_FRAMES = 4

// Counts so far ({ frames, soft }) from one more frame's score.
export function countFrame(counts, score) {
  return {
    frames: counts.frames + (score > SPEECH_SCORE ? 1 : 0),
    soft: counts.soft + (score > ANSWER_SCORE ? 1 : 0),
  }
}

// `isAnswer`: a "ok?" waits for this clip's answer.
export function hasSpeech({ frames = 0, soft = 0 } = {}, { isAnswer = false } = {}) {
  return frames >= MIN_SPEECH_FRAMES || (isAnswer && soft >= MIN_ANSWER_FRAMES)
}
