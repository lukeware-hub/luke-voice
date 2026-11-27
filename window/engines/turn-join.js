// Joins speech that resumes right after a turn closed. People breathe mid-sentence: when the pause
// was long enough to end the turn but the user goes on talking before Ceci answers, the first part
// is dropped from the brain and sent again in front of the rest, as one utterance.
//
// Flow per turn: ended(audio) gives the audio to transcribe and a turn number. Every step with an
// effect (saying, running a tool, showing the user's words) first checks isCurrent(turn). Ceci
// answering or a tool starting calls commit(turn): from then on the turn stands. When the user
// starts talking again, resumed() drops the uncommitted last turn and carries its audio into the
// next one. If that next sound turns out to be no speech, dropped() gives the carried audio back,
// so a cough does not swallow the user's request. A turn that itself turned out to be no speech
// (noSpeech()) is never carried: a soft "sim" the speech check dropped, said again a moment later,
// is heard alone instead of joined behind a part already judged noise.

export const JOIN_WINDOW_MS = 2500
const GAP_SAMPLES = 4800 // 0.3 s of silence between the joined parts, at 16 kHz
// The longest turn that is still carried into the next one: 90 s at 16 kHz. One more part (the
// detector ends a turn at ~30 s) keeps the joined turn near 2 minutes, under the hub's 4 MiB cap
// for /stt (~131 s). A longer turn stands as it is and is answered, and the speech goes on as a
// new turn, instead of the whole request being refused as too long.
export const MAX_CARRY_SAMPLES = 90 * 16_000

function join(first, second) {
  const out = new Float32Array(first.length + GAP_SAMPLES + second.length)
  out.set(first, 0)
  out.set(second, first.length + GAP_SAMPLES)
  return out
}

export function createTurnJoiner({ now = () => Date.now(), windowMs = JOIN_WINDOW_MS, maxCarry = MAX_CARRY_SAMPLES } = {}) {
  let turn = 0
  let last = null // { audio, endedAt, turn, isCommitted }
  let carry = null
  let carryTurn = 0 // the turn the carried part came from

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
      if (!last || last.isCommitted || now() - last.endedAt > windowMs || last.audio.length > maxCarry) return false
      carry = last.audio
      carryTurn = last.turn
      last = null
      turn++
      return true
    },
    // Turn n had no speech in it: it is not joined with what comes next, even if the user already
    // started talking again (then it was carried, and is let go).
    noSpeech(n) {
      if (last && last.turn === n) last = null
      if (carry && carryTurn === n) carry = null
    },
    isCurrent(n) {
      return n === turn
    },
  }
}

// A reply cut off because the user seemed to start talking. Its turn already stands, so nothing
// else brings it back: if the sound turns out to be no speech (a cough, a click), take() gives the
// reply to say again; if it was the user talking, take() still empties it and the reply is let go.
export function createCutReply() {
  let text = ''
  return {
    get isCut() {
      return text !== ''
    },
    cut(said) {
      text = said
    },
    take() {
      const said = text
      text = ''
      return said
    },
    clear() {
      text = ''
    },
  }
}

// How many turns of the call the brain reads (the hub keeps the last 12 too): older ones are let go,
// so a long call does not keep or send an ever-growing history.
export const MAX_TURNS = 12

// The call as the brain reads it. The user's words of a turn are held until that turn is committed
// (Ceci answers it, or a tool starts for it): a turn that is joined with what the user said next
// is dropped instead, so the brain never reads the first part twice, and what it was waiting on
// (the "posso?" a "sim" answers) is only let go once the turn stands. history() includes the held
// words, so the brain reading the turn it answers sees them, as before.
export function createTurnLog({ max = MAX_TURNS } = {}) {
  const turns = []
  let held = null // { text, onCommit }
  let lastSaid = ''
  const add = turn => {
    turns.push(turn)
    if (turns.length > max) turns.splice(0, turns.length - max)
  }
  return {
    // The user's words of the turn being answered; a turn still held (it was joined) is replaced.
    hold(text, onCommit = () => {}) {
      held = { text, onCommit }
    },
    // The held turn stands: it enters the history, and its effects run once.
    commit() {
      if (!held) return
      const { text, onCommit } = held
      held = null
      add({ role: 'user', text })
      onCommit()
    },
    // The held turn will be joined with the next one: forget it, with no effect.
    drop() {
      held = null
    },
    // Ceci said this.
    said(text) {
      add({ role: 'luke', text })
      lastSaid = text
    },
    // What the brain reads: the last `max` turns, the held one included.
    history() {
      return (held ? [...turns, { role: 'user', text: held.text }] : [...turns]).slice(-max)
    },
    // Ceci's last line, however many turns ago (the router reads it).
    get lastSaid() {
      return lastSaid
    },
    get size() {
      return turns.length
    },
  }
}
