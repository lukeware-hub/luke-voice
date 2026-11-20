// A small voice activity detector on audio level: no model to download, a few lines of math per frame.
// Frames are 512 samples at 16 kHz (32 ms). The noise floor follows the room while nobody speaks.
// While Ceci talks, the bar to interrupt is higher, so her own voice leaking into the mic does not cut it off.

export const FRAME = 512
export const RATE = 16_000

const DEFAULTS = {
  minLevel: 0.012, // below this RMS nothing counts as speech, however quiet the room
  ratio: 3, // speech is this many times louder than the noise floor
  bargeRatio: 2.5, // while Ceci speaks, the bar is this many times higher
  startFrames: 3, // ~100 ms of speech starts an utterance
  bargeFrames: 8, // ~250 ms of loud speech interrupts Ceci
  endFrames: 25, // ~800 ms of silence ends it
  prerollFrames: 10, // ~320 ms kept from before the start, so the first syllable is not cut
  // While Ceci speaks, ~1.6 s is kept: speech has quiet dips between syllables, so a barge-in
  // fires a moment after the user started, and the words before it must not be lost.
  bargePrerollFrames: 50,
  maxFrames: 940, // ~30 s at most per utterance
  minSpeechFrames: 8, // shorter blips (a cough, a click) are dropped
}

export function rms(frame) {
  let sum = 0
  for (let i = 0; i < frame.length; i++) sum += frame[i] * frame[i]
  return Math.sqrt(sum / (frame.length || 1))
}

// push(frame, { isSpeaking }) returns null, or one event: { type: 'start' }, { type: 'barge' },
// { type: 'end', audio: Float32Array } or { type: 'drop' } for a blip too short to transcribe.
export function createVad(options = {}) {
  const o = { ...DEFAULTS, ...options }
  let floor = o.minLevel / o.ratio
  let loud = 0
  let quiet = 0
  let voiced = 0
  let inSpeech = false
  let preroll = []
  let frames = []

  function finish() {
    const enough = voiced >= o.minSpeechFrames
    const audio = new Float32Array(frames.length * FRAME)
    frames.forEach((f, i) => audio.set(f, i * FRAME))
    inSpeech = false
    frames = []
    preroll = []
    loud = quiet = voiced = 0
    return enough ? { type: 'end', audio } : { type: 'drop' }
  }

  return {
    get inSpeech() {
      return inSpeech
    },
    get floor() {
      return floor
    },
    push(frame, { isSpeaking = false } = {}) {
      const level = rms(frame)
      const normalBar = Math.max(o.minLevel, floor * o.ratio)
      const bar = normalBar * (isSpeaking ? o.bargeRatio : 1)
      const isLoud = level >= bar

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
        quiet = 0
      } else {
        quiet++
      }
      if (quiet >= o.endFrames || frames.length >= o.maxFrames) return finish()
      return null
    },
    reset() {
      inSpeech = false
      frames = []
      preroll = []
      loud = quiet = voiced = 0
    },
  }
}
