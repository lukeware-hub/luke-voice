// A small voice activity detector on audio level: no model to download, a few lines of math per frame.
// Frames are 512 samples at 16 kHz (32 ms). The noise floor follows the room while nobody speaks,
// and creeps up when the room itself gets louder (a TV, an air conditioner switching on).
// While Ceci talks, the bar to interrupt is higher, so her own voice leaking into the mic does not cut it off.

export const FRAME = 512
export const RATE = 16_000

const DEFAULTS = {
  minLevel: 0.012, // below this RMS nothing counts as speech, however quiet the room
  ratio: 3, // speech is this many times louder than the noise floor
  bargeRatio: 3, // while Ceci speaks, the bar is this many times higher
  startFrames: 3, // ~100 ms of speech starts an utterance
  bargeFrames: 8, // ~250 ms of loud speech interrupts Ceci
  endFrames: 40, // ~1.3 s of silence ends it (breaths mid-sentence last up to ~1 s)
  // With a turn model (Smart Turn), ~400 ms of silence makes a candidate end: the model says
  // whether the user is done. If not, the silence must reach endFrames. 0 turns candidates off.
  candidateFrames: 0,
  prerollFrames: 10, // ~320 ms kept from before the start, so the first syllable is not cut
  // While Ceci speaks, ~1.6 s is kept: speech has quiet dips between syllables, so a barge-in
  // fires a moment after the user started, and the words before it must not be lost.
  bargePrerollFrames: 50,
  maxFrames: 940, // ~30 s at most per utterance
  minSpeechFrames: 8, // shorter blips (a cough, a click) are dropped
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
  let asked = false
  // Frames in a row above the bar, and the quietest of them (the creep of the floor).
  let above = 0
  let aboveMin = Infinity

  // The utterance so far, or only its last `samples`, as one array.
  function audioOf(samples = Infinity) {
    const count = Math.min(frames.length, Math.ceil(samples / FRAME))
    const audio = new Float32Array(count * FRAME)
    for (let i = 0; i < count; i++) audio.set(frames[frames.length - count + i], i * FRAME)
    return audio
  }

  function finish() {
    const enough = voiced >= o.minSpeechFrames
    const audio = audioOf()
    inSpeech = false
    frames = []
    preroll = []
    loud = quiet = voiced = 0
    asked = false
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
    push(frame, { isSpeaking = false, echo = 0 } = {}) {
      const level = rms(frame)
      const normalBar = Math.max(o.minLevel, floor * o.ratio)
      // The higher bar only keeps Ceci's voice from starting a turn: once the user is talking, Ceci
      // starting a line must not make their words count as quiet and end the turn under them.
      // `echo` is how loud Ceci's own voice is expected in the mic right now (local.js learns it
      // from her output level): while she speaks it is never speech, in or out of a turn, so her
      // echo neither interrupts her nor keeps a turn going after the user stopped.
      const echoBar = isSpeaking ? echo : 0
      const bar = Math.max(normalBar * (isSpeaking && !inSpeech ? o.bargeRatio : 1), echoBar)
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
          asked = false
        }
        quiet = 0
      } else {
        quiet++
      }
      if (quiet >= o.endFrames || frames.length >= o.maxFrames) return finish()
      if (o.candidateFrames && !asked && quiet >= o.candidateFrames && voiced >= o.minSpeechFrames) {
        asked = true
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
      frames = []
      preroll = []
      loud = quiet = voiced = 0
      asked = false
      pause++
    },
  }
}
