// A small voice activity detector on audio level: no model to download, a few lines of math per frame.
// Frames are 512 samples at 16 kHz (32 ms). The noise floor follows the room while nobody speaks,
// and creeps up when the room itself gets louder (a TV, an air conditioner switching on).
// While Ceci talks, the bar to interrupt is higher, so her own voice leaking into the mic does not cut it off.

export const FRAME = 512
export const RATE = 16_000

const DEFAULTS = {
  // Below this RMS (~-42 dBFS) nothing counts as speech, however quiet the room. The mic has no
  // automatic gain, so a soft voice or a far mic speaks at ~0.01-0.02: at the old 0.012 its quiet
  // syllables fell under the bar, short words were dropped as blips and turns were cut mid-phrase.
  // A noisy room still sets a higher bar (ratio, below), and Silero drops noise before the ears.
  minLevel: 0.008,
  ratio: 3, // speech is this many times louder than the noise floor
  bargeRatio: 3, // while Ceci speaks, the bar is this many times higher
  // ...and never under this (the old 0.012 times bargeRatio): a lower minLevel for the user's own
  // turns must not let Ceci's echo or the room interrupt her more easily.
  bargeMinLevel: 0.036,
  // Once a turn has started in a quiet room, a frame counts as speech down to this share of
  // minLevel (hysteresis): soft word endings and the quiet consonants of fast speech no longer count
  // as silence, so a turn is not cut under the user and short words reach minSpeechFrames. In a
  // noisy room the bar is the room's (floor times ratio), as before, so a noise that switched on is
  // still absorbed; Ceci's echo bar is never lowered.
  holdRatio: 0.7,
  startFrames: 3, // ~100 ms of speech starts an utterance
  bargeFrames: 8, // ~250 ms of loud speech interrupts Ceci
  endFrames: 25, // ~0.8 s of silence ends it (a longer breath mid-sentence is joined, see turn-join.js)
  // With a turn model (Smart Turn), a pause of candidateFrames makes a candidate end: the model
  // says whether the user is done. If not, it is asked again every candidateEvery frames of the
  // same pause (0: once), and the silence still ends the turn at endFrames. 0 turns candidates off.
  candidateFrames: 0,
  candidateEvery: 0,
  // Silence kept at the end of an utterance: the rest is cut, so the speech check and the ears
  // do not spend time on up to 2 s of nothing.
  tailFrames: 5,
  prerollFrames: 10, // ~320 ms kept from before the start, so the first syllable is not cut
  // While Ceci speaks, ~1.6 s is kept: speech has quiet dips between syllables, so a barge-in
  // fires a moment after the user started, and the words before it must not be lost.
  bargePrerollFrames: 50,
  maxFrames: 940, // ~30 s at most per utterance
  // Shorter blips (a click, a knock) are dropped. ~190 ms: a quick "sim" or "não" has about that
  // much voiced sound; at 8 (~260 ms) it was often dropped. Silero still checks what passes.
  minSpeechFrames: 6,
  // While Ceci waits for the answer to her "ok?" (isAnswer), a soft, quick answer ("sim", "não",
  // "pode", "ok") must not be lost: the bar to start a turn drops to this share of minLevel
  // (~-46 dBFS), and ~130 ms of voice is enough. Silero still checks the clip (speech-check.js), and
  // nothing runs unless the ears write a clear yes; noise ends in "Pode repetir?".
  answerLevel: 0.6,
  answerSpeechFrames: 4,
  // A noise that switches on above the bar never has a quiet frame, so the floor, learned from quiet
  // frames only, would never reach it: every turn would run to the 30 s cap. After ~3 s with every
  // frame above the bar, the floor creeps toward the quietest of those frames, slowly (a step-up is
  // absorbed in ~10 s). Speech always dips below the bar between words and phrases, which starts the
  // count over; even speech with no dip at all would need ~11 s more before its quietest frames fell
  // under the bar. 0 turns it off.
  creepFrames: 94,
  creepRate: 0.0015,
  // The turn model reads the last 8 s: a pause hands it only that much of the utterance.
  candidateSamples: 8 * 16_000,
}

export function rms(frame) {
  let sum = 0
  for (let i = 0; i < frame.length; i++) sum += frame[i] * frame[i]
  return Math.sqrt(sum / (frame.length || 1))
}

// push(frame, { isSpeaking, echo }) returns null, or one event: { type: 'start' }, { type: 'barge' },
// { type: 'end', audio: Float32Array }, { type: 'drop' } for a blip too short to transcribe, or
// { type: 'candidate', audio, id } once per pause of candidateFrames. The caller asks the turn model
// and, if the user is done, calls endNow(id) to get the 'end' event without waiting longer.
export function createVad(options = {}) {
  const o = { ...DEFAULTS, ...options }
  let floor = o.minLevel / o.ratio
  let loud = 0
  let quiet = 0
  let voiced = 0
  let inSpeech = false
  let preroll = []
  let frames = []
  // Bumped on every new pause and every resumed speech, so a late answer about an old pause is ignored.
  let pause = 0
  // The silence (in frames) at which the turn model was last consulted on this pause; -1: not yet.
  let askedAt = -1
  // Frames in a row above the bar, and the quietest of them (the creep of the floor).
  let above = 0
  let aboveMin = Infinity
  // The turn being heard started while a "ok?" waited (its lower bars hold to its end).
  let isAnswerTurn = false

  // The utterance so far, or only its last `samples`, as one array.
  function audioOf(samples = Infinity) {
    const count = Math.min(frames.length, Math.ceil(samples / FRAME))
    const audio = new Float32Array(count * FRAME)
    for (let i = 0; i < count; i++) audio.set(frames[frames.length - count + i], i * FRAME)
    return audio
  }

  function finish() {
    const enough = voiced >= (isAnswerTurn ? Math.min(o.minSpeechFrames, o.answerSpeechFrames) : o.minSpeechFrames)
    isAnswerTurn = false
    if (quiet > o.tailFrames) frames = frames.slice(0, frames.length - (quiet - o.tailFrames))
    const audio = audioOf()
    inSpeech = false
    frames = []
    preroll = []
    loud = quiet = voiced = 0
    askedAt = -1
    pause++
    return enough ? { type: 'end', audio } : { type: 'drop' }
  }

  return {
    get inSpeech() {
      return inSpeech
    },
    get floor() {
      return floor
    },
    push(frame, { isSpeaking = false, echo = 0, isAnswer = false } = {}) {
      const level = rms(frame)
      const normalBar = Math.max(o.minLevel, floor * o.ratio)
      // The bar for the user's own turn: lower while an answer to "ok?" is awaited, in a quiet
      // room only (a noisy room keeps its own bar, floor times ratio).
      const minLevel = isAnswer || (inSpeech && isAnswerTurn) ? o.minLevel * o.answerLevel : o.minLevel
      const userBar = Math.max(minLevel, floor * o.ratio)
      // The higher bar only keeps Ceci's voice from starting a turn: once the user is talking, Ceci
      // starting a line must not make their words count as quiet and end the turn under them.
      // `echo` is how loud Ceci's own voice is expected in the mic right now (local.js learns it
      // from her output level): while she speaks it is never speech, in or out of a turn, so her
      // echo neither interrupts her nor keeps a turn going after the user stopped.
      const echoBar = isSpeaking ? echo : 0
      const turnBar = inSpeech ? Math.max(minLevel * o.holdRatio, floor * o.ratio) : isSpeaking ? Math.max(o.bargeMinLevel, floor * o.ratio * o.bargeRatio) : userBar
      const bar = Math.max(turnBar, echoBar)
      const isLoud = level >= bar

      // The room got louder: every frame above the bar for creepFrames, and Ceci quiet (her voice
      // in the mic is not the room). The bar to compare with is the normal one, in or out of speech.
      if (o.creepFrames && !isSpeaking && level >= normalBar) {
        above++
        aboveMin = Math.min(aboveMin, level)
        if (above >= o.creepFrames && aboveMin > floor) floor += (aboveMin - floor) * o.creepRate
      } else {
        above = 0
        aboveMin = Infinity
      }

      if (!inSpeech) {
        preroll.push(frame)
        // Room for the frames that set off the start plus a lead-in; more while Ceci speaks,
        // so an interruption keeps its first words.
        const keep = isSpeaking ? o.bargePrerollFrames : o.prerollFrames + o.bargeFrames
        while (preroll.length > keep) preroll.shift()
        // While Ceci speaks, a quiet dip between syllables only takes one back, instead of
        // starting the count over.
        loud = isLoud ? loud + 1 : isSpeaking ? Math.max(0, loud - 1) : 0
        // Learn the room only from quiet frames, slowly, and never while Ceci speaks: then the
        // mic also hears her and the user, and learning that as "room" would raise the bar.
        if (!isSpeaking && level < normalBar) floor = floor * 0.95 + level * 0.05
        if (loud >= (isSpeaking ? o.bargeFrames : o.startFrames)) {
          inSpeech = true
          isAnswerTurn = isAnswer && !isSpeaking
          frames = [...preroll]
          voiced = loud
          quiet = 0
          return { type: isSpeaking ? 'barge' : 'start' }
        }
        return null
      }

      frames.push(frame)
      if (isLoud) {
        voiced++
        if (quiet > 0) {
          pause++
          askedAt = -1
        }
        quiet = 0
      } else {
        quiet++
      }
      if (quiet >= o.endFrames || frames.length >= o.maxFrames) return finish()
      const isDue = askedAt < 0 ? quiet >= o.candidateFrames : o.candidateEvery > 0 && quiet - askedAt >= o.candidateEvery
      if (o.candidateFrames && isDue && voiced >= o.minSpeechFrames) {
        askedAt = quiet
        return { type: 'candidate', audio: audioOf(o.candidateSamples), id: pause }
      }
      return null
    },
    // The turn model says the user is done with the pause `id`: end now, unless they spoke since.
    endNow(id) {
      if (!inSpeech || id !== pause) return null
      return finish()
    },
    reset() {
      inSpeech = false
      isAnswerTurn = false
      frames = []
      preroll = []
      loud = quiet = voiced = 0
      askedAt = -1
      pause++
    },
  }
}
