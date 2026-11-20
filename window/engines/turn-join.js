// Joins speech that resumes right after a turn closed. People breathe mid-sentence: when the pause
// was long enough to end the turn but the user goes on talking before Ceci answers, the first part
// is dropped from the brain and sent again in front of the rest, as one utterance.
//
// Flow per turn: ended(audio) gives the audio to transcribe and a turn number. Every step with an
// effect (saying, running a tool, showing the user's words) first checks isCurrent(turn). Ceci
// answering or a tool starting calls commit(turn): from then on the turn stands. When the user
// starts talking again, resumed() drops the uncommitted last turn and carries its audio into the
// next one. If that next sound turns out to be no speech, dropped() gives the carried audio back,
// so a cough does not swallow the user's request.

export const JOIN_WINDOW_MS = 2500
const GAP_SAMPLES = 4800 // 0.3 s of silence between the joined parts, at 16 kHz

function join(first, second) {
  const out = new Float32Array(first.length + GAP_SAMPLES + second.length)
  out.set(first, 0)
  out.set(second, first.length + GAP_SAMPLES)
  return out
}

export function createTurnJoiner({ now = () => Date.now(), windowMs = JOIN_WINDOW_MS } = {}) {
  let turn = 0
  let last = null // { audio, endedAt, turn, isCommitted }
  let carry = null

  return {
    get turn() {
      return turn
    },
    // A turn ended with this audio: returns what to transcribe (joined with a carried part, if any).
    ended(audio) {
      const joined = carry ? join(carry, audio) : audio
      carry = null
      turn++
      // Its own copy: the caller may hand the returned array to a worker (a transfer empties it).
      last = { audio: joined.slice(), endedAt: now(), turn, isCommitted: false }
      return { audio: joined, turn, isJoined: joined !== audio }
    },
    // The next sound had no speech: the carried part, if any, comes back as its own turn.
    dropped() {
      if (!carry) return null
      const audio = carry
      carry = null
      return this.ended(audio)
    },
    // Ceci started answering this turn, or a tool started for it: it can no longer be joined.
    commit(n) {
      if (last && last.turn === n) last.isCommitted = true
    },
    // The user started talking again. True when the last turn is dropped and will be joined.
    resumed() {
      if (!last || last.isCommitted || now() - last.endedAt > windowMs) return false
      carry = last.audio
      last = null
      turn++
      return true
    },
    isCurrent(n) {
      return n === turn
    },
  }
}
