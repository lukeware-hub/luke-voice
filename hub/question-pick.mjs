import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

// Brazilian yes/no questions, said by the voice model itself. Qwen3-TTS usually ends a question flat,
// like a statement, but some takes end with the rise a Brazilian question has (28% of takes on 10
// questions x 8 seeds reached +4 semitones). Changing the pitch after synthesis (PSOLA, 0.9.3-0.9.9)
// sounded robotic to the owner (6 of 10); the best of 4 takes was rated 8.5. A take costs ~1 s and
// the engine makes one at a time, so takes are only made in time nobody waits for, and kept on disk:
// see createQuestionTakes.
// Questions with a question word ("o que", "quando", "como"...) fall at the end in pt-BR, like a
// statement, so they are said once, as they come.

// Rise (semitones) of a natural Brazilian question end, and the one aimed at when none is in range.
export const NATURAL_RISE = [4, 9]
const TARGET_RISE = 6
// Longer questions are said once: each take must be made whole before it is heard.
export const MAX_PICK_CHARS = 90

const WH = /(?:^|[,;:]\s*|^(?:e|mas|então|e aí)\s+)(?:o\s+que|que|quem|qual|quais|quando|onde|aonde|como|por\s*que|pra\s+que|para\s+que|quant[oa]s?|cadê|em\s+que|de\s+que)\b/iu

// A yes/no question: the text ends with "?" and its last sentence does not start with a question word.
export function isYesNoQuestion(text) {
  const t = String(text ?? '').trim()
  if (!/\?$/.test(t)) return false
  const sentences = t.split(/(?<=[.!?])\s+/)
  return !WH.test(sentences[sentences.length - 1].toLowerCase())
}

// Pitch per 10 ms (0 when unvoiced), YIN at half the sample rate. Tuned against Praat on 80 takes
// (89% the same natural-rise call), ~9 ms per take.
export function pitchTrack(samples, fs, { threshold = 0.35, floor = 0.02, minHz = 75, maxHz = 600 } = {}) {
  const rate = fs / 2
  const x = new Float32Array(Math.floor(samples.length / 2))
  for (let i = 0; i < x.length; i++) x[i] = (samples[2 * i] + samples[2 * i + 1]) / 2
  const hop = Math.round(rate * 0.01)
  const win = Math.round(rate * 0.04)
  const minLag = Math.floor(rate / maxHz)
  const maxLag = Math.ceil(rate / minHz)
  let peak = 0
  for (const v of x) peak = Math.max(peak, Math.abs(v))
  const hz = []
  const d = new Float32Array(maxLag + 2)
  for (let c = 0; c + win + maxLag <= x.length; c += hop) {
    let energy = 0
    for (let i = 0; i < win; i++) energy += x[c + i] * x[c + i]
    let f = 0
    if (Math.sqrt(energy / win) > peak * floor) {
      let running = 0
      for (let lag = 1; lag <= maxLag + 1; lag++) {
        let sum = 0
        for (let i = 0; i < win; i++) {
          const q = x[c + i] - x[c + i + lag]
          sum += q * q
        }
        running += sum
        d[lag] = (sum * lag) / (running || 1)
      }
      for (let lag = minLag; lag <= maxLag; lag++) {
        if (d[lag] < threshold) {
          while (lag + 1 <= maxLag && d[lag + 1] < d[lag]) lag++
          f = rate / lag
          break
        }
      }
    }
    hz.push(f)
  }
  // Median of 3 on voiced frames, against octave slips.
  return hz.map((f, i) => {
    if (!f) return 0
    const near = [hz[i - 1], f, hz[i + 1]].filter(Boolean).sort((a, b) => a - b)
    return near[near.length >> 1]
  })
}

// How far the end of a take rises: the highest pitch over the last 35% of voiced frames against the
// median of the rest, in semitones. null when there is too little voice to tell.
export function endRise(samples, fs) {
  const f = pitchTrack(samples, fs).filter(Boolean)
  if (f.length < 15) return null
  const cut = Math.floor(f.length * 0.65)
  const base = [...f.slice(0, cut)].sort((a, b) => a - b)[cut >> 1]
  return 12 * Math.log2(Math.max(...f.slice(cut)) / base)
}

export const isNaturalRise = rise => rise !== null && rise >= NATURAL_RISE[0] && rise <= NATURAL_RISE[1]

// The take to keep when none rose naturally: the one nearest the aim, not past +10 (a squeak).
export function bestTake(takes) {
  const fair = takes.filter(t => t.rise !== null && t.rise <= 10)
  if (!fair.length) return takes[0]
  return fair.reduce((a, b) => (Math.abs(b.rise - TARGET_RISE) < Math.abs(a.rise - TARGET_RISE) ? b : a))
}

// The samples of a 16-bit mono WAV (as llama-server streams it: the data size may be unknown).
export function wavSamples(buffer) {
  let o = 12
  while (o + 8 <= buffer.length) {
    const id = buffer.toString('ascii', o, o + 4)
    const size = buffer.readUInt32LE(o + 4)
    if (id === 'fmt ') {
      const rate = buffer.readUInt32LE(o + 12)
      o += 8 + size
      while (o + 8 <= buffer.length && buffer.toString('ascii', o, o + 4) !== 'data') o += 8 + buffer.readUInt32LE(o + 4)
      const start = o + 8
      const end = Math.min(buffer.length, start + (buffer.readUInt32LE(o + 4) || buffer.length))
      const samples = new Float32Array(Math.floor((end - start) / 2))
      for (let i = 0; i < samples.length; i++) samples[i] = buffer.readInt16LE(start + i * 2) / 32768
      return { samples, rate }
    }
    o += 8 + size
  }
  return { samples: new Float32Array(0), rate: 24_000 }
}

// Questions Ceci asks often, improved in the background once the engine is up.
export const COMMON_QUESTIONS = ['Posso?', 'Posso começar?', 'Quer que eu faça mais alguma coisa?', 'Mais alguma coisa?', 'Tudo bem?', 'Pode ser?', 'Quer que eu continue?']
// Seeds tried for a question, after Ceci's own (the take said live): at most this many takes in all.
const MORE_SEEDS = [1, 2, 3, 4, 5, 6, 7, 8].map(s => s + 100)
const MAX_TAKES = 1 + MORE_SEEDS.length
// The background search waits this long after the last live line, so it never queues in front of one.
const IDLE_MS = 1500
// A background take that comes back empty at once (the voice server down or restarting) is tried
// again after this long, doubled on each failure up to the cap, instead of in a tight loop.
const RETRY_MS = 5000
const MAX_RETRY_MS = 5 * 60_000
// A cache entry per text; the oldest go past this many.
const MAX_CACHED = 300
// How long a whole take of a question takes, roughly (1.7B on a mid-range GPU): 0.5 s + 20 ms a character.
export const takeMs = text => 500 + 20 * String(text).length

// The takes of yes/no questions: kept on disk per text (and voice), the best one served at once,
// more made only in time nobody waits for: while the line before still plays (`budget`), or in the
// background when the engine is idle. Any live line stops the background search at once.
// `say(text, seed, signal)` makes one take and resolves to its WAV (or null).
export function createQuestionTakes({ say, dir, voiceKey, log = () => {}, now = () => Date.now(), idleMs = IDLE_MS, retryMs = RETRY_MS, maxRetryMs = MAX_RETRY_MS }) {
  const memory = new Map() // key -> { text, takes: [{ seed, rise }], best }
  const queue = []
  let lastLive = 0
  let liveCount = 0
  let background = null // { text, stop }
  let timer = null
  let failures = 0 // background takes in a row that came back empty
  let retryAt = 0
  const succeeded = () => {
    failures = 0
    retryAt = 0
  }
  const keyOf = text => createHash('sha1').update(`${voiceKey}\n${text}`).digest('hex').slice(0, 20)
  const entryOf = text => {
    const key = keyOf(text)
    if (!memory.has(key)) {
      let entry = { text, takes: [], best: null }
      try {
        const saved = JSON.parse(readFileSync(join(dir, `${key}.json`), 'utf8'))
        if (saved.text === text && existsSync(join(dir, `${key}.wav`))) entry = saved
      } catch {
        // Not cached yet.
      }
      memory.set(key, entry)
    }
    return { key, entry: memory.get(key) }
  }
  const wavOf = key => {
    try {
      return readFileSync(join(dir, `${key}.wav`))
    } catch {
      return null
    }
  }
  // Records a take; it becomes the served one when its rise is better.
  function remember(text, seed, wav) {
    const { key, entry } = entryOf(text)
    if (entry.takes.some(t => t.seed === seed)) return
    const { samples, rate } = wavSamples(wav)
    const rise = endRise(samples, rate)
    entry.takes.push({ seed, rise })
    const best = isNaturalRise(entry.best?.rise) ? entry.best : bestTake([...(entry.best ? [entry.best] : []), { seed, rise }])
    try {
      mkdirSync(dir, { recursive: true })
      if (best.seed === seed) writeFileSync(join(dir, `${key}.wav`), wav)
      entry.best = best
      writeFileSync(join(dir, `${key}.json`), JSON.stringify(entry))
      prune()
    } catch (error) {
      log(`question takes: ${error.message}`)
    }
  }
  function prune() {
    const files = readdirSync(dir).filter(f => f.endsWith('.json'))
    if (files.length <= MAX_CACHED) return
    const old = files.map(f => ({ f, t: statSync(join(dir, f)).mtimeMs })).sort((a, b) => a.t - b.t).slice(0, files.length - MAX_CACHED)
    for (const { f } of old) {
      rmSync(join(dir, f), { force: true })
      rmSync(join(dir, f.replace(/\.json$/, '.wav')), { force: true })
      memory.delete(f.replace(/\.json$/, ''))
    }
  }
  const untried = entry => MORE_SEEDS.filter(s => !entry.takes.some(t => t.seed === s))
  const isDone = entry => isNaturalRise(entry.best?.rise) || entry.takes.length >= MAX_TAKES

  // The served take for a question, made within `budget` ms when it can be: a WAV, or null when the
  // line should be said live (nothing cached and no time for two takes).
  async function take(text, { budget = 0, signal } = {}) {
    const { key, entry } = entryOf(text)
    const started = now()
    const fits = () => now() - started + takeMs(text) <= budget
    if (!isDone(entry) && fits()) {
      for (const seed of untried(entry)) {
        if (!fits() || signal?.aborted) break
        const wav = await say(text, seed, signal)
        if (!wav) break
        succeeded()
        remember(text, seed, wav)
        if (isNaturalRise(entry.best?.rise)) break
      }
    }
    if (!isDone(entry)) refine(text)
    return entry.best ? wavOf(key) : null
  }

  // Background search, one take at a time, only while no live line is wanted.
  function refine(text) {
    if (!queue.includes(text) && background?.text !== text) queue.push(text)
    schedule()
  }
  function schedule() {
    clearTimeout(timer)
    if (!queue.length || background) return
    const wait = Math.max(0, lastLive + idleMs - now(), retryAt - now())
    timer = setTimeout(step, wait)
    timer.unref?.()
  }
  async function step() {
    if (background || liveCount || now() - lastLive < idleMs || now() < retryAt) return schedule()
    const text = queue[0]
    const { entry } = entryOf(text)
    const seed = untried(entry)[0]
    if (isDone(entry) || seed === undefined) {
      queue.shift()
      return schedule()
    }
    const stop = new AbortController()
    background = { text, stop }
    let wav = null
    try {
      wav = await say(text, seed, stop.signal)
      if (wav && !stop.signal.aborted) {
        succeeded()
        remember(text, seed, wav)
      }
    } catch {
      // Stopped for a live line: the take is made again later.
    }
    // Empty without being stopped: the engine is down. Wait longer each time.
    if (!wav && !stop.signal.aborted) {
      failures++
      retryAt = now() + Math.min(retryMs * 2 ** (failures - 1), maxRetryMs)
    }
    background = null
    schedule()
  }
  // Every live line: stop the background take now, and resume after the line plus the idle wait.
  function live() {
    liveCount++
    lastLive = now()
    background?.stop.abort()
    return () => {
      liveCount--
      lastLive = now()
      schedule()
    }
  }
  const warm = texts => texts.forEach(refine)
  const stop = () => {
    clearTimeout(timer)
    queue.length = 0
    background?.stop.abort()
  }
  return { take, remember, refine, live, warm, stop, keyOf }
}
