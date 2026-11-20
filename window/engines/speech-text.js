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

const MAX_CHUNK = 220
// The first chunk is short: on a CPU the voice takes ~0.7 s per second of audio, so the first sound comes sooner.
const FIRST_CHUNK = 70

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

// English tech words in the respelling a pt-BR voice needs; anything else stays as written.
export function respell(text) {
  return String(text ?? '').replace(/\p{L}[\p{L}\d]*/gu, word => RESPELL[word.toLowerCase()] ?? word)
}

// Sentences, and long ones cut at a comma or space. The first chunk is cut shorter, so the first audio starts sooner.
export function chunks(text, max = MAX_CHUNK, first = max) {
  const sentences = String(text ?? '').match(/[^.!?…]+[.!?…]*\s*/g) ?? []
  const out = []
  for (let sentence of sentences.map(s => s.trim()).filter(Boolean)) {
    for (let limit = out.length ? max : first; sentence.length > limit; limit = max) {
      const comma = sentence.lastIndexOf(', ', limit)
      const cut = comma > limit / 3 ? comma : sentence.lastIndexOf(' ', limit)
      const at = cut > limit / 3 ? cut + 1 : limit
      out.push(sentence.slice(0, at).trim())
      sentence = sentence.slice(at).trim()
    }
    if (sentence) out.push(sentence)
  }
  return out
}

// Everything at once: what the voice worker gets, one chunk at a time.
export function speechChunks(text) {
  return chunks(respell(plainText(text)), MAX_CHUNK, FIRST_CHUNK)
}
