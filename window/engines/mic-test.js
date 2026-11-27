// Judges a short microphone test recording: is the voice loud enough, clean and free of clipping?
// A local, deterministic check, so the user's audio never leaves this computer and the verdict is testable.
import { speechLevel } from './gain.js'

const FRAME = 512
// Best to worst; `score` is the lower bound of each band.
export const QUALITIES = [
  { id: 'perfeito', label: 'Perfeito', min: 90 },
  { id: 'bom', label: 'Bom', min: 70 },
  { id: 'mais-ou-menos', label: 'Mais ou menos', min: 50 },
  { id: 'ruim', label: 'Ruim', min: 25 },
  { id: 'pessimo', label: 'Péssimo', min: 0 },
]

const dbfs = value => (value > 0 ? 20 * Math.log10(value) : -120)
const clamp = (value, low, high) => Math.min(high, Math.max(low, value))

// Per-frame RMS of the clip.
function frameLevels(audio) {
  const levels = []
  for (let i = 0; i + FRAME <= audio.length; i += FRAME) {
    let sum = 0
    for (let j = i; j < i + FRAME; j++) sum += audio[j] * audio[j]
    levels.push(Math.sqrt(sum / FRAME))
  }
  return levels
}

// { quality, label, score, level, noise, snr, clipped, tips }: the verdict for a Float32Array at `sampleRate`.
export function analyzeRecording(audio, sampleRate = 16000) {
  const levels = frameLevels(audio)
  const seconds = audio.length / sampleRate
  if (levels.length === 0 || seconds < 0.5) return verdict(0, { tips: ['A gravação ficou curta demais. Grave de novo e fale por alguns segundos.'] })

  let peak = 0
  let clippedSamples = 0
  for (let i = 0; i < audio.length; i++) {
    const abs = Math.abs(audio[i])
    if (abs > peak) peak = abs
    if (abs >= 0.99) clippedSamples++
  }
  const clipped = clippedSamples / audio.length
  const sorted = [...levels].sort((a, b) => a - b)
  const loud = sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))]
  // Noise floor: the quietest fifth of the frames. Voice: the speech level (`speechLevel`, as the ears get it).
  const quiet = sorted.slice(0, Math.max(1, Math.floor(sorted.length * 0.2)))
  const noise = quiet.reduce((sum, value) => sum + value, 0) / quiet.length
  const level = speechLevel(audio)
  const levelDb = dbfs(level)
  const noiseDb = dbfs(noise)
  const snr = levelDb - noiseDb
  const metrics = { level: levelDb, noise: noiseDb, snr, clipped }

  // Nothing heard: a muted, unplugged or wrong microphone.
  if (peak < 0.003 || loud < 0.002) {
    return verdict(0, { ...metrics, tips: ['Não captei nada. Veja se o microfone está ligado, sem mudo, e se é o escolhido acima.'] })
  }

  const tips = []
  let score = 100
  // Level: ~-20 dBFS is a close, normal voice. Below -35 the ears have to lift it a lot.
  if (levelDb < -40) { score -= 55; tips.push('Voz muito baixa. Chegue mais perto do microfone ou aumente a entrada nas configurações do sistema.') }
  else if (levelDb < -32) { score -= 35; tips.push('Voz baixa. Chegue mais perto do microfone.') }
  else if (levelDb < -26) { score -= 12; tips.push('Voz um pouco baixa. Chegar mais perto ajuda.') }
  else if (levelDb > -6) { score -= 30; tips.push('Voz alta demais. Afaste-se do microfone ou diminua a entrada.') }
  // Clipping: samples stuck at full scale distort the voice.
  if (clipped > 0.01) { score -= 40; tips.push('O som está estourando (distorção). Afaste-se ou diminua a entrada do microfone.') }
  else if (clipped > 0.001) { score -= 15; tips.push('Há pequenos picos estourados. Fale um pouco mais longe do microfone.') }
  // Signal to noise: how far the voice stands above the room.
  if (snr < 10) { score -= 45; tips.push('Muito ruído de fundo perto da sua voz. Procure um lugar mais silencioso.') }
  else if (snr < 20) { score -= 25; tips.push('Ruído de fundo alto. Um lugar mais silencioso melhora a captação.') }
  else if (snr < 30) { score -= 8 }
  // A clip with no pause barely tells voice from room: the noise floor is a guess.
  if (loud > 0 && noise / loud > 0.7 && snr >= 10) tips.push('Deixe um instante de silêncio antes de falar, para eu medir o ruído do ambiente.')

  return verdict(clamp(Math.round(score), 0, 100), { ...metrics, tips })
}

function verdict(score, extra = {}) {
  const band = QUALITIES.find(quality => score >= quality.min)
  const tips = extra.tips ?? []
  return {
    quality: band.id,
    label: band.label,
    score,
    level: extra.level ?? -120,
    noise: extra.noise ?? -120,
    snr: extra.snr ?? 0,
    clipped: extra.clipped ?? 0,
    tips: tips.length ? tips : ['Captação ótima. Pode seguir assim.'],
  }
}

// Level of the last chunk, 0..1, for the live meter (-60..0 dBFS).
export function meterLevel(chunk) {
  let sum = 0
  for (let i = 0; i < chunk.length; i++) sum += chunk[i] * chunk[i]
  const db = dbfs(Math.sqrt(sum / (chunk.length || 1)))
  return clamp((db + 60) / 60, 0, 1)
}
