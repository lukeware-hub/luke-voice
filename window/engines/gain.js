// Brings a quiet utterance up to a steady speaking level before the ears hear it. The mic runs with
// no automatic gain (local.js: it raised Ceci's echo and the echo interrupted her), so a soft voice,
// a far mic or a quiet headset reaches the ears at a fraction of a normal level. Whisper and
// Qwen3-ASR read log-mel features whose values shift with the level, Silero scores soft speech
// lower, and the 16-bit WAV for the native engine keeps only a few bits of a very quiet signal.
// Only the copy for the ears is raised: the detector and the echo estimate still see the mic as is.
// Never lowered, never clipped: a loud clip goes through untouched.

const FRAME = 512
// ~-20 dBFS of speech, a normal close-mic level.
export const TARGET_RMS = 0.1
// At most ~+22 dB: a whisper-quiet voice comes up, a silent room is not blown up into hiss.
export const MAX_GAIN = 12
// The loudest sample after the gain stays under this, so nothing clips.
export const PEAK = 0.95
// Below this gain the clip is left as is (a near-normal level gains nothing from a copy).
const MIN_GAIN = 1.1

// The level of the speech in a clip: the RMS of its frames within ~20 dB of the loud ones, so the
// silence before and after does not pull it down. The loud ones are the 95th percentile, so one
// click does not set the level alone.
export function speechLevel(audio) {
  const levels = []
  for (let i = 0; i + FRAME <= audio.length; i += FRAME) {
    let sum = 0
    for (let j = i; j < i + FRAME; j++) sum += audio[j] * audio[j]
    levels.push(sum / FRAME)
  }
  if (levels.length === 0) return 0
  const sorted = [...levels].sort((a, b) => a - b)
  const loud = sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))]
  const kept = levels.filter(level => level >= loud * 0.01)
  return Math.sqrt(kept.reduce((sum, level) => sum + level, 0) / (kept.length || 1))
}

// { audio, gain }: the clip raised to TARGET_RMS (a new array), or the same array with gain 1.
export function normalizeSpeech(audio, { target = TARGET_RMS, maxGain = MAX_GAIN, peak = PEAK } = {}) {
  const level = speechLevel(audio)
  let top = 0
  for (let i = 0; i < audio.length; i++) top = Math.max(top, Math.abs(audio[i]))
  if (level <= 0 || top <= 0) return { audio, gain: 1 }
  const gain = Math.min(maxGain, target / level, peak / top)
  if (gain < MIN_GAIN) return { audio, gain: 1 }
  const out = new Float32Array(audio.length)
  for (let i = 0; i < audio.length; i++) out[i] = audio[i] * gain
  return { audio: out, gain }
}
