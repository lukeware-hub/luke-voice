// Brazilian question intonation, added after synthesis. A yes/no question in pt-BR rises on its
// last stressed syllable and falls a little after it; the voice model often ends flat, like a
// statement (measured on 20 questions: +2.0 semitones at the end, the same as statements).
// riseQuestion() raises the pitch over the last `tail` seconds of voiced speech, keeping the
// duration (TD-PSOLA: pitch-synchronous grains re-spaced at the new period). The owner picked
// this by ear among three versions. Pure function, no dependencies: it runs in the window and in
// node tests.

const MIN_HZ = 70 // low enough for the creaky end of a sentence, which is what most needs the rise
const MAX_HZ = 600
const YIN_THRESHOLD = 0.25 // below this normalized difference a frame is voiced
const MIN_VOICED_SECONDS = 0.15
const ANALYZED_SECONDS = 1.6 // only the end of the clip is analyzed: that is where the rise goes
const LEAD_SECONDS = 0.05 // changed audio starts this long before the tail, faded in
const FADE_SECONDS = 0.01

// Pitch per 10 ms frame from `from` on: { hop, frames: [{ t, hz }] }, hz = 0 when unvoiced.
export function pitchTrack(x, fs, from = 0) {
  const hop = Math.round(fs * 0.01)
  const win = Math.round(fs * 0.04)
  const minLag = Math.floor(fs / MAX_HZ)
  const maxLag = Math.ceil(fs / MIN_HZ)
  let peak = 0
  for (let i = from; i < x.length; i++) peak = Math.max(peak, Math.abs(x[i]))
  const frames = []
  for (let c = from; c + win + maxLag <= x.length; c += hop) {
    let energy = 0
    for (let i = 0; i < win; i++) energy += x[c + i] * x[c + i]
    let hz = 0
    if (Math.sqrt(energy / win) > peak * 0.03) {
      // YIN: the difference function, normalized by its running mean; the first dip under the
      // threshold is the period. It holds up on the creaky, low ends of sentences better than a
      // plain correlation, and it does not prefer two periods over one.
      const d = new Float32Array(maxLag + 2)
      let running = 0
      for (let lag = 1; lag <= maxLag + 1; lag++) {
        let sum = 0
        for (let i = 0; i < win; i++) {
          const diff = x[c + i] - x[c + i + lag]
          sum += diff * diff
        }
        running += sum
        d[lag] = (sum * lag) / (running || 1)
      }
      for (let lag = minLag; lag <= maxLag; lag++) {
        if (d[lag] < YIN_THRESHOLD) {
          while (lag + 1 <= maxLag && d[lag + 1] < d[lag]) lag++
          // Parabolic interpolation for a period between samples.
          const a1 = d[lag - 1]
          const a2 = d[lag]
          const a3 = d[lag + 1]
          const shift = (a1 - a3) / (2 * (a1 - 2 * a2 + a3) || 1)
          hz = fs / (lag + (Math.abs(shift) < 1 ? shift : 0))
          break
        }
      }
    }
    frames.push({ t: c + win / 2, hz })
  }
  // Median of 3 on voiced frames, against octave slips.
  const smooth = frames.map((f, i) => {
    if (!f.hz) return f
    const near = [frames[i - 1]?.hz, f.hz, frames[i + 1]?.hz].filter(Boolean).sort((a, b) => a - b)
    return { t: f.t, hz: near[Math.floor(near.length / 2)] }
  })
  return { hop, frames: smooth }
}

const median = values => {
  const s = [...values].sort((a, b) => a - b)
  return s[Math.floor(s.length / 2)]
}

// `keep`: samples before this index are never changed (the caller already played them).
export function riseQuestion(samples, fs, { semitones = 7, tail = 0.5, keep = 0 } = {}) {
  const x = samples
  const n = x.length
  const from = Math.max(0, n - Math.round(fs * ANALYZED_SECONDS))
  const { hop, frames } = pitchTrack(x, fs, from)
  const voiced = frames.filter(f => f.hz)
  if (voiced.length * hop < fs * MIN_VOICED_SECONDS) return x
  const med = median(voiced.map(f => f.hz))
  const end = voiced[voiced.length - 1].t
  const start = Math.max(from, end - Math.round(fs * tail))

  // Short dropouts inside a voiced stretch (up to 60 ms) are filled by interpolation, so pitch
  // marks run on through a word instead of switching grain sizes, which sounds rough.
  const hzs = frames.map(f => f.hz)
  for (let i = 0; i < hzs.length; i++) {
    if (hzs[i]) continue
    let j = i
    while (j < hzs.length && !hzs[j]) j++
    if (i > 0 && j < hzs.length && j - i <= 6) {
      for (let k = i; k < j; k++) hzs[k] = hzs[i - 1] * (hzs[j] / hzs[i - 1]) ** ((k - i + 1) / (j - i + 1))
    }
    i = j
  }
  // Pitch at a sample (0 when unvoiced) and the new pitch the prototype's shape asks for there.
  const hzAt = t => hzs[Math.max(0, Math.min(hzs.length - 1, Math.round((t - frames[0].t) / hop)))] ?? 0
  const ratioAt = t => {
    const hz = hzAt(t)
    if (!hz || t < start) return 1
    const k = Math.min(1, (t - start) / Math.max(1, end - start))
    const shape = semitones * (k < 0.7 ? k / 0.7 : 1 - (0.5 * (k - 0.7)) / 0.3)
    const target = med * 2 ** (shape / 12)
    let next = k < 1 ? hz ** (1 - k) * target ** k : target
    if (k > 0.3) next = Math.max(next, med * 2 ** ((shape - 1) / 12))
    // A creaky end (far below the median) may go up a lot, to the target; elsewhere at most a fifth,
    // so a wrong pitch reading cannot warp the voice.
    const most = hz < med / 1.5 ? 3.5 : 1.5
    return Math.max(0.9, Math.min(most, next / hz))
  }

  // Analysis marks from the lead-in on: one per period at the local peak while voiced, every
  // 10 ms while not.
  const region = Math.max(keep, start - Math.round(fs * LEAD_SECONDS))
  if (region >= n - fs * 0.05) return x
  const marks = []
  let t = region
  while (t < n) {
    const hz = hzAt(t)
    const period = hz ? Math.round(fs / hz) : hop
    if (hz) {
      let best = t
      const lo = Math.max(region, t - Math.round(period * 0.2))
      const hi = Math.min(n - 1, t + Math.round(period * 0.2))
      for (let i = lo; i <= hi; i++) if (x[i] > x[best]) best = i
      t = best
    }
    marks.push({ t, period })
    t += period
  }
  if (marks.length < 2) return x

  // Synthesis: grains of two periods (Hann), re-spaced at period / ratio, normalized by the
  // window sum so loudness stays the same.
  const out = new Float32Array(x)
  const y = new Float32Array(n - region)
  const w = new Float32Array(n - region)
  let m = 0
  for (let s = marks[0].t; s < n; ) {
    while (m + 1 < marks.length && Math.abs(marks[m + 1].t - s) <= Math.abs(marks[m].t - s)) m++
    const { t: a, period } = marks[m]
    for (let i = -period; i <= period; i++) {
      const src = a + i
      const dst = s + i - region
      if (src < 0 || src >= n || dst < 0 || dst >= y.length) continue
      const h = 0.5 + 0.5 * Math.cos((Math.PI * i) / period)
      y[dst] += x[src] * h
      w[dst] += h
    }
    s += Math.max(8, Math.round(period / ratioAt(s)))
  }
  const fade = Math.round(fs * FADE_SECONDS)
  for (let i = 0; i < y.length; i++) {
    if (w[i] < 0.3) continue // no grain covers this sample: keep the original
    const made = Math.max(-1, Math.min(1, y[i] / w[i]))
    const into = Math.min(1, i / fade) // fade in from the original at the start of the region
    out[region + i] = x[region + i] * (1 - into) + made * into
  }
  return out
}
