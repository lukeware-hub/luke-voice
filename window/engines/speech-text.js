// Turns text into what the local voice should say: no markdown or code, English tech words
// spelled the way a Brazilian says them, and short sentences the voice can start on quickly.

// Words the pt-BR phonemizer reads letter by letter or with Portuguese rules. Keys are lower case.
const RESPELL = {
  api: 'a pê i',
  apis: 'a pê is',
  bug: 'bâg',
  bugs: 'bâgs',
  branch: 'brentch',
  branches: 'brentches',
  claude: 'clód',
  commit: 'comít',
  commits: 'comíts',
  deploy: 'diplói',
  backend: 'béquend',
  frontend: 'frôntend',
  github: 'guít rãb',
  git: 'guít',
  hub: 'rãb',
  json: 'djêisson',
  login: 'lóguin',
  logout: 'lógaut',
  merge: 'mêrdj',
  npm: 'ene pê eme',
  pull: 'pul',
  push: 'puch',
  request: 'riquést',
  readme: 'rídmi',
  token: 'tôquen',
  tokens: 'tôquens',
  url: 'u erre éle',
  website: 'uébsait',
  site: 'sáite',
  sites: 'sáites',
  ok: 'oquêi',
  online: 'onláine',
  offline: 'ofláine',
  email: 'imêiu',
  feature: 'fítcher',
  build: 'bild',
  script: 'iscrípt',
  plugin: 'plâguin',
  plugins: 'plâguins',
  hook: 'ruk',
  hooks: 'ruks',
  luke: 'luque',
  elevenlabs: 'éleven labs',
}

// The native voice (Qwen3-TTS 1.7B, told to speak Portuguese) reads some English tech words with
// Portuguese rules ("changelog" as "chão geloso", "cache" as "caixa"). Each spelling here was
// picked on the production path: several spellings per word in three sentences, judged by the ears
// (Qwen3-ASR, no glossary), then checked on four new sentences. A spelling is kept only when it
// brought the English word back at least twice more over the seven sentences and did not lose on
// the new ones (34 words, 11 kept). A capital letter alone is enough for some. Words that no
// spelling helped (main, README, branch, commit, push, lint) stay as written. Keys are lower case.
const NATIVE_RESPELL = {
  feature: 'Feature',
  review: 'Riviú',
  backend: 'Back End',
  endpoint: 'end-point',
  token: 'touken',
  cache: 'Cache',
  changelog: 'tchêindj log',
  framework: 'Framework',
  hooks: 'ruks',
  state: 'State',
  rebase: 're base',
}
const NATIVE_RE = new RegExp(
  `(?<![\\p{L}\\d-])(${Object.keys(NATIVE_RESPELL).sort((a, b) => b.length - a.length).map(k => k.replace(' ', '\\s+')).join('|')})(?![\\p{L}\\d-])`,
  'giu',
)

const MAX_CHUNK = 220
// The first chunk is short: on a CPU the voice takes ~0.7 s per second of audio, so the first sound comes sooner.
const FIRST_CHUNK = 70
// The native voice makes a whole chunk before sending it (~0.4 s per second of speech plus ~0.7 s
// for the reference): a first chunk of one short clause makes her start sooner.
const FIRST_CHUNK_NATIVE = 40

// Markdown and code read badly out loud: keep the words, drop the markup.
export function plainText(text) {
  return String(text ?? '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/^\s{0,3}#{1,6}\s+/gm, '')
    .replace(/^\s*[-*+]\s+/gm, '')
    .replace(/^\s*\d+[.)]\s+/gm, '')
    .replace(/(\*\*|__|\*|_|~~)(\S[\s\S]*?\S|\S)\1/g, '$2')
    .replace(/[|>#*_~]/g, ' ')
    .replace(/\s*\n+\s*/g, '. ')
    .replace(/\.(\s*\.)+/g, '.')
    .replace(/\s{2,}/g, ' ')
    .trim()
}

// Times and percentages as a pt-BR speaker reads them: "17h30" and "17:30" become "17 e 30",
// "18h" becomes "18 horas", "35%" becomes "35 por cento". The voices read plain numbers well.
export function spokenForms(text) {
  return String(text ?? '')
    .replace(/\b([01]?\d|2[0-3])[h:]([0-5]\d)\b/g, (_, h, m) => (m === '00' ? `${Number(h)} horas` : `${Number(h)} e ${m}`))
    .replace(/\b([01]?\d|2[0-3])h\b/g, (_, h) => `${Number(h)} ${Number(h) === 1 ? 'hora' : 'horas'}`)
    .replace(/(\d)\s?%/g, '$1 por cento')
}

// English tech words in the respelling a pt-BR voice needs; anything else stays as written.
export function respell(text) {
  return String(text ?? '').replace(/\p{L}[\p{L}\d]*/gu, word => RESPELL[word.toLowerCase()] ?? word)
}

// English tech words in the spelling the native voice says best; anything else stays as written.
export function respellNative(text) {
  return String(text ?? '').replace(NATIVE_RE, word => NATIVE_RESPELL[word.toLowerCase().replace(/\s+/g, ' ')])
}

// Sentences; a sentence longer than `max` is cut at a comma or space. When the first sentence is
// longer than `first`, it is cut at its first comma (if that comma is within twice `first`), so the
// first audio starts sooner. Never mid-phrase for that early cut: the voice would pause where a
// person would not, so without a comma close by the first sentence goes whole. A question is never
// cut early: the voice rises at its end only when it sees the "?".
export function chunks(text, max = MAX_CHUNK, first = max) {
  const sentences = String(text ?? '').match(/[^.!?…]+[.!?…]*\s*/g) ?? []
  const out = []
  for (let sentence of sentences.map(s => s.trim()).filter(Boolean)) {
    if (out.length === 0 && first < max && sentence.length > first && !sentence.endsWith('?')) {
      const comma = sentence.indexOf(', ')
      if (comma >= 4 && comma <= first * 2) {
        out.push(sentence.slice(0, comma + 1))
        sentence = sentence.slice(comma + 1).trim()
      }
    }
    while (sentence.length > max) {
      const comma = sentence.lastIndexOf(', ', max)
      const cut = comma > max / 3 ? comma : sentence.lastIndexOf(' ', max)
      const at = cut > max / 3 ? cut + 1 : max
      out.push(sentence.slice(0, at).trim())
      sentence = sentence.slice(at).trim()
    }
    if (sentence) out.push(sentence)
  }
  return out
}

// Everything at once: what the voice gets, one chunk at a time. The browser voices (Kokoro, Piper)
// read English words with Portuguese rules and need the full respelling; the native voice (Qwen3-TTS)
// knows most of them and gets only its own short list.
export function speechChunks(text, { isNative = false } = {}) {
  const spoken = spokenForms(plainText(text))
  return isNative ? chunks(respellNative(spoken), MAX_CHUNK, FIRST_CHUNK_NATIVE) : chunks(respell(spoken), MAX_CHUNK, FIRST_CHUNK)
}
