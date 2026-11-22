// Test audio for the question pick: synthetic voiced takes and streamed WAVs.
export const FS = 24_000

// A voiced take: a harmonic tone at 220 Hz that glides up `semitones` over its last 35%.
export function take(seconds = 1.5, semitones = 0) {
  const x = new Float32Array(Math.round(FS * seconds))
  let phase = 0
  for (let i = 0; i < x.length; i++) {
    const k = Math.max(0, (i / x.length - 0.65) / 0.35)
    phase += (2 * Math.PI * 220 * 2 ** ((semitones * k) / 12)) / FS
    x[i] = 0.3 * Math.sin(phase) + 0.15 * Math.sin(2 * phase) + 0.08 * Math.sin(3 * phase)
  }
  return x
}

// As llama-server streams it: 16-bit mono WAV whose data size is unknown (0xFFFFFFFF).
export function wav(samples) {
  const pcm = Buffer.alloc(samples.length * 2)
  samples.forEach((v, i) => pcm.writeInt16LE(Math.round(v * 32767), i * 2))
  const h = Buffer.alloc(44)
  h.write('RIFF', 0)
  h.writeUInt32LE(0xffffffff, 4)
  h.write('WAVE', 8)
  h.write('fmt ', 12)
  h.writeUInt32LE(16, 16)
  h.writeUInt16LE(1, 20)
  h.writeUInt16LE(1, 22)
  h.writeUInt32LE(FS, 24)
  h.writeUInt32LE(FS * 2, 28)
  h.writeUInt16LE(2, 32)
  h.writeUInt16LE(16, 34)
  h.write('data', 36)
  h.writeUInt32LE(0xffffffff, 40)
  return Buffer.concat([h, pcm])
}
