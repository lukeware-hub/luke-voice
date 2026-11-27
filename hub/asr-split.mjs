// Long speech is heard in pieces. The ears (Qwen3-ASR) run with a 1536-token context (engine.mjs),
// and that context holds the prompt (~250 to 400 tokens), the audio (12.5 tokens a second) and the
// transcript written back (~5 tokens a second). Speech joined across pauses (turn-join.js) grew
// past it: at ~65 s the transcript was cut short ("truncated" in the engine's log), and past ~75 s
// the engine refused the request ("exceeds the available context size"), so the user's whole
// request got no transcript and no answer.
//
// splitWav() cuts a 16-bit PCM WAV into pieces of at most MAX_PIECE_SECONDS, each cut at the
// quietest moment of the last few seconds before the limit, so a word is rarely split in two.
// A WAV it cannot read, or a short one, comes back whole.

// 30 s: ~375 audio tokens plus the prompt and ~150 tokens of transcript, well inside 1536.
export const MAX_PIECE_SECONDS = 30
// Where a cut is looked for: the last this many seconds of a piece.
export const CUT_SEARCH_SECONDS = 8
// The stretch whose loudness is compared when looking for the quietest moment.
const WINDOW_SECONDS = 0.1

// Where the samples are in a WAV: { rate, channels, start, end } (byte offsets), or null.
export function readWav(buffer) {
  if (buffer.length < 12 || buffer.toString('latin1', 0, 4) !== 'RIFF' || buffer.toString('latin1', 8, 12) !== 'WAVE') return null
  let at = 12
  let format = null
  while (at + 8 <= buffer.length) {
    const id = buffer.toString('latin1', at, at + 4)
    const size = buffer.readUInt32LE(at + 4)
    const body = at + 8
    if (id === 'fmt ' && body + 16 <= buffer.length) {
      format = { tag: buffer.readUInt16LE(body), channels: buffer.readUInt16LE(body + 2), rate: buffer.readUInt32LE(body + 4), bits: buffer.readUInt16LE(body + 14) }
    }
    if (id === 'data') {
      if (!format || format.tag !== 1 || format.bits !== 16 || format.channels < 1) return null
      const end = Math.min(buffer.length, body + size)
      return { rate: format.rate, channels: format.channels, start: body, end }
    }
    // Chunks are padded to an even size.
    at = body + size + (size % 2)
  }
  return null
}

// A WAV of these samples (bytes of 16-bit PCM), in the same format.
function wavOf(samples, rate, channels) {
  const header = Buffer.alloc(44)
  header.write('RIFF', 0, 'latin1')
  header.writeUInt32LE(36 + samples.length, 4)
  header.write('WAVEfmt ', 8, 'latin1')
  header.writeUInt32LE(16, 16)
  header.writeUInt16LE(1, 20)
  header.writeUInt16LE(channels, 22)
  header.writeUInt32LE(rate, 24)
  header.writeUInt32LE(rate * channels * 2, 28)
  header.writeUInt16LE(channels * 2, 32)
  header.writeUInt16LE(16, 34)
  header.write('data', 36, 'latin1')
  header.writeUInt32LE(samples.length, 40)
  return Buffer.concat([header, samples])
}

export function splitWav(buffer, { maxSeconds = MAX_PIECE_SECONDS, searchSeconds = CUT_SEARCH_SECONDS } = {}) {
  const wav = readWav(buffer)
  if (!wav || !wav.rate) return [buffer]
  const frame = wav.channels * 2 // bytes per sample, all channels
  const total = Math.floor((wav.end - wav.start) / frame)
  const max = Math.floor(maxSeconds * wav.rate)
  if (total <= max) return [buffer]
  const search = Math.min(Math.floor(searchSeconds * wav.rate), max - 1)
  const step = Math.max(1, Math.floor(WINDOW_SECONDS * wav.rate))
  // The loudness of `step` samples from sample i (first channel).
  const energy = i => {
    let sum = 0
    for (let k = i; k < i + step; k++) {
      const v = buffer.readInt16LE(wav.start + k * frame)
      sum += v * v
    }
    return sum
  }
  const pieces = []
  let from = 0
  while (total - from > max) {
    // The quietest stretch in the last `search` samples before the limit; the cut is in its middle.
    // Among equally quiet ones the latest wins, so the pieces stay as long and as few as they can.
    let cut = from + max
    let quietest = Infinity
    for (let i = from + max - search; i + step <= from + max; i += step) {
      const e = energy(i)
      if (e <= quietest) {
        quietest = e
        cut = i + Math.floor(step / 2)
      }
    }
    pieces.push(wavOf(buffer.subarray(wav.start + from * frame, wav.start + cut * frame), wav.rate, wav.channels))
    from = cut
  }
  pieces.push(wavOf(buffer.subarray(wav.start + from * frame, wav.start + total * frame), wav.rate, wav.channels))
  return pieces
}
