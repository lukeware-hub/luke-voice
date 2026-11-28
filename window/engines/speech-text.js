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
// Rechecked in 0.17.3 on 60 words the same way: release, front-end, checkout, pipeline, workflow
// and payload added, endpoint and cache changed, token and rebase dropped (plain won).
const NATIVE_RESPELL = {
  feature: 'Feature',
  review: 'Riviú',
  backend: 'Back End',
  frontend: 'front-end',
  endpoint: 'End Point',
  cache: 'quéche',
  changelog: 'tchêindj log',
  framework: 'Framework',
  hook: 'ruk',
  hooks: 'ruks',
  state: 'State',
  release: 'Rilíss',
  checkout: 'check out',
  pipeline: 'paip láin',
  workflow: 'work flow',
  payload: 'Payload',
  // The product names, checked in 0.23.1 the same way on the three voices (Ceci, Luke, João), 18
  // takes each: "luke-voice" came back 3 times as written and 17 as "Luke Vóiss"; "Claude Code" 2
  // times as written and 11 as "Clód Code,". The comma is part of it: without it "Code" ran into the
  // next word ("codeterminou"). It is dropped before other punctuation (respellNative).
  'luke-voice': 'Luke Vóiss',
  'luke voice': 'Luke Vóiss',
  'claude code': 'Clód Code,',
}
// "Clód Code," right before a mark of its own, or at the end, loses its comma: the mark already pauses.
const CLAUDE_CODE_COMMA = /Clód Code,(?=\s*[.,;:!?…)\]"'”’»]|\s*$)/gu
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

// Emoji and pictographs (with their joiners, skin tones, variation selectors and flags): never said.
const EMOJI = /[ \t]*[\p{Extended_Pictographic}\u{1F1E6}-\u{1F1FF}\u{1F3FB}-\u{1F3FF}\u{200D}\u{FE0E}\u{FE0F}\u{20E3}]+(?=(.?))/gu
// A bare domain (site.com.br, www.example.org). File names (app.js, auth.ts) have other endings.
const DOMAIN = /(?<![\p{L}\d@/.-])(?:www\.)?((?:[a-z\d][a-z\d-]*\.)+(?:com|net|org|br|io|dev|ai|app|gov|edu|co|me|info|tech))(?![\p{L}\d-]|\.[\p{L}\d])/giu

// Markdown and code read badly out loud: keep the words, drop the markup.
export function plainText(text) {
  return String(text ?? '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/https?:\/\/\S+/g, ' ')
    // A bare domain is read the way people say it: "site ponto com ponto bê erre".
    .replace(DOMAIN, (_, domain) => domain.replace(/\.br$/i, '.bê erre').split('.').join(' ponto '))
    .replace(EMOJI, (_, next) => (/[.!?…,;:]/.test(next) ? '' : ' '))
    .replace(/^\s{0,3}#{1,6}\s+/gm, '')
    .replace(/^\s*[-*+•]\s+/gm, '')
    .replace(/^\s*\d+[.)]\s+/gm, '')
    // Arithmetic keeps its "times": "2 * 3" and "2*3" are "2 vezes 3", not emphasis.
    .replace(/(\d)\s*[*×]\s*(?=\d)/g, '$1 vezes ')
    .replace(/(\*\*|\*|~~)(\S[\s\S]*?\S|\S)\1/g, '$2')
    // Underscores mark emphasis only around words; inside one (snake_case_names) they are spaces.
    .replace(/(?<![\p{L}\d])(__|_)(\S[\s\S]*?\S|\S)\1(?![\p{L}\d])/gu, '$2')
    .replace(/[|>#*_~]/g, ' ')
    // A line break ends a sentence, unless the line already ended with punctuation ("Itens:" before a list).
    .replace(/([.!?…:;,])?\s*\n+\s*/g, (_, mark) => (mark ? `${mark} ` : '. '))
    .replace(/\.(\s*\.)+/g, '.')
    .replace(/\s{2,}/g, ' ')
    .trim()
}

// Numbers in words, for the few places where digits cannot say it: the feminine of hours ("duas
// horas", "vinte e uma horas") and money ("mil e quinhentos reais"). Everything else stays in
// digits, which the voices read well.
const UNITS = ['zero', 'um', 'dois', 'três', 'quatro', 'cinco', 'seis', 'sete', 'oito', 'nove', 'dez', 'onze', 'doze', 'treze', 'catorze', 'quinze', 'dezesseis', 'dezessete', 'dezoito', 'dezenove']
const TENS = ['', '', 'vinte', 'trinta', 'quarenta', 'cinquenta', 'sessenta', 'setenta', 'oitenta', 'noventa']
const HUNDREDS = ['', 'cento', 'duzentos', 'trezentos', 'quatrocentos', 'quinhentos', 'seiscentos', 'setecentos', 'oitocentos', 'novecentos']

const unit = (n, isFeminine) => (isFeminine && n === 1 ? 'uma' : isFeminine && n === 2 ? 'duas' : UNITS[n])

function belowThousand(n, isFeminine) {
  if (n === 100) return 'cem'
  const parts = []
  const hundreds = Math.floor(n / 100)
  const rest = n % 100
  if (hundreds) parts.push(isFeminine && hundreds > 1 ? HUNDREDS[hundreds].replace(/os$/, 'as') : HUNDREDS[hundreds])
  if (rest >= 20) parts.push(rest % 10 ? `${TENS[Math.floor(rest / 10)]} e ${unit(rest % 10, isFeminine)}` : TENS[rest / 10])
  else if (rest) parts.push(unit(rest, isFeminine))
  return parts.join(' e ')
}

// 0 to 999 999 999 999 in pt-BR words: 1500 "mil e quinhentos", 2001 "dois mil e um",
// 1250000 "um milhão duzentos e cinquenta mil". `isFeminine` for a feminine noun ("duas horas").
export function numberWords(n, { isFeminine = false } = {}) {
  if (!Number.isInteger(n) || n < 0 || n >= 1e12) return String(n)
  if (n === 0) return 'zero'
  const groups = [
    [Math.floor(n / 1e9), c => (c === 1 ? 'um bilhão' : `${belowThousand(c, false)} bilhões`)],
    [Math.floor(n / 1e6) % 1000, c => (c === 1 ? 'um milhão' : `${belowThousand(c, false)} milhões`)],
    [Math.floor(n / 1000) % 1000, c => (c === 1 ? 'mil' : `${belowThousand(c, isFeminine)} mil`)],
    [n % 1000, c => belowThousand(c, isFeminine)],
  ].filter(([count]) => count > 0)
  return groups
    .map(([count, say], i) => {
      // "e" before the last group when it is below 100 or a round hundred: "mil e quinhentos", "mil quinhentos e cinquenta".
      const joiner = i === 0 ? '' : i === groups.length - 1 && (count < 100 || count % 100 === 0) ? ' e ' : ' '
      return joiner + say(count)
    })
    .join('')
}

// An hour count as said before "hora(s)": in words only where the digit would come out masculine
// (1, 2, 21, 22...: "uma", "duas", "vinte e uma"); otherwise the digits.
const hourCount = h => (h % 10 >= 1 && h % 10 <= 2 && h % 100 !== 11 && h % 100 !== 12 ? numberWords(h, { isFeminine: true }) : String(h))
const hours = h => `${hourCount(h)} ${h === 1 ? 'hora' : 'horas'}`
const minutes = m => `${m} ${m === 1 ? 'minuto' : 'minutos'}`
const seconds = s => `${s} ${s === 1 ? 'segundo' : 'segundos'}`
// A clock with seconds (10:30:45, 00:05:01): each part that is not zero, "10 horas, 30 minutos e 45 segundos".
function longClock(h, m, s) {
  const parts = [h && hours(h), m && minutes(m), s && seconds(s)].filter(Boolean)
  if (!parts.length) return seconds(0)
  return parts.length === 1 ? parts[0] : `${parts.slice(0, -1).join(', ')} e ${parts.at(-1)}`
}
// A time of day: "17 e 30", "vinte e uma e 15", "18 horas".
const clock = (h, m) => (m === '00' ? hours(h) : `${hourCount(h)} e ${m}`)

const MONTHS = ['janeiro', 'fevereiro', 'março', 'abril', 'maio', 'junho', 'julho', 'agosto', 'setembro', 'outubro', 'novembro', 'dezembro']
const DAYS_IN_MONTH = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]
// Words that make "N/M" a count, not a date: "12/12 passaram", "10/12 testes ok", "11/12 dos casos".
const COUNT_AFTER =
  /^\s*(?:passaram|passou|passando|falharam|falhou|falhando|rodaram|rodou|ok|d[oa]s|testes?|tests?|casos?|itens?|arquivos?|tarefas?|etapas?|passos?|checks?|verdes?|prontos?|prontas?|feit[oa]s?|conclu[ií]d[oa]s?|complet[oa]s?|aprovad[oa]s?)(?![\p{L}\d])/iu

// Money in reais, as a Brazilian says it: "R$ 1.500,00" is "mil e quinhentos reais", "R$ 2,50" is
// "dois reais e cinquenta centavos".
function reais(whole, cents) {
  const amount = Number(whole.replace(/\./g, ''))
  // One digit is tens of cents: "R$ 10,5" is ten reais and fifty.
  const cent = Number((cents ?? '0').padEnd(2, '0'))
  const parts = []
  if (amount > 0 || cent === 0) {
    const big = amount >= 1e6 && amount % 1e6 === 0 ? ' de' : ''
    parts.push(`${numberWords(amount)}${big} ${amount === 1 ? 'real' : 'reais'}`)
  }
  if (cent > 0) parts.push(`${numberWords(cent)} ${cent === 1 ? 'centavo' : 'centavos'}`)
  return parts.join(' e ')
}

// Abbreviations the native voice misreads, said in full (capitalized only where a sentence starts).
// The ears heard "Prof." as "Profer" and "p.ex." as "P X"; "Sr.", "Dra." and "nº" come out right
// as written, so they stay (the sentence splitter only must not cut after them).
const ABBREVIATIONS = [
  [/(?<![\p{L}\d])p\.\s?ex\./giu, 'por exemplo'],
  [/(?<![\p{L}\d])ex\.(?=[\s:]|$)/giu, 'por exemplo'],
  [/(?<![\p{L}\d])profa\.(?=\s)/giu, 'professora'],
  [/(?<![\p{L}\d])prof\.(?=\s)/giu, 'professor'],
  [/(?<![\p{L}\d])vs\.?(?=\s)/giu, 'versus'],
]
const isSentenceStart = (text, at) => /(^|[.!?…]\s+)$/.test(text.slice(0, at))

// Times, durations, dates, money, versions, percentages and abbreviations as a pt-BR speaker reads
// them: "às 17h30" and "17:30" become "17 e 30", "18h" "18 horas", "21h" "vinte e uma horas",
// "1h30min" "uma hora e 30 minutos", "22/11" "22 de novembro", "R$ 1.500,00" "mil e quinhentos
// reais", "5.5" "5 ponto 5", "35%" "35 por cento", "Prof." "professor". Each was checked on the
// native voice with its ears (old and new text, same seed). The voices read plain numbers well, and
// "30min" too, so those stay as written.
export function spokenForms(text) {
  let out = String(text ?? '')
  for (const [pattern, words] of ABBREVIATIONS) {
    out = out.replace(pattern, (match, ...rest) => {
      const at = rest[rest.length - 2]
      const whole = rest[rest.length - 1]
      return /\p{Lu}/u.test(match[0]) && isSentenceStart(whole, at) ? words[0].toUpperCase() + words.slice(1) : words
    })
  }
  return (
    out
      // R$ 2 milhões, R$ 1,5 mil: the number stays, "de reais" follows.
      .replace(/(?<![\p{L}\d])R\$\s?(\d+(?:,\d+)?)\s(mil|milhão|milhões|bilhão|bilhões)(?!\p{L})/gu, (_, n, scale) => `${n} ${scale}${scale === 'mil' ? '' : ' de'} reais`)
      .replace(/(?<![\p{L}\d])R\$\s?(\d{1,3}(?:\.\d{3})+|\d+)(?:,(\d{1,2}))?(?![\d,.]\d|\d)/gu, (_, whole, cents) => reais(whole, cents))
      // Dates: 22/11, 22/11/2026, 01/12/26. A bare "1/2" stays a fraction: a short date needs both
      // parts in two digits, or a day past 12.
      // A day the month does not have (30/02) is no date, nor a count ("12/12 passaram", "10/12 testes").
      .replace(/(?<![\p{L}\d/.,])(\d{1,2})\/(\d{1,2})(?:\/(\d{4}|\d{2}))?(?![\p{L}\d/])/gu, (match, d, m, y, at, whole) => {
        const [day, month] = [Number(d), Number(m)]
        if (day < 1 || month < 1 || month > 12 || day > DAYS_IN_MONTH[month - 1]) return match
        if (!y && !(d.length === 2 && m.length === 2) && day <= 12) return match
        if (!y && COUNT_AFTER.test(whole.slice(at + match.length))) return match
        const year = y ? ` de ${y.length === 2 ? `20${y}` : y}` : ''
        return `${day === 1 ? 'primeiro' : day} de ${MONTHS[month - 1]}${year}`
      })
      // Durations: "1h30min" always is one; "1h30" too, unless it is a time of day ("às 1h30", or past 12h).
      .replace(/(?<![\p{L}\d.,:])(\d{1,3})h([0-5]\d)\s?min(?![\p{L}\d])/gu, (_, h, m) => `${hours(Number(h))} e ${minutes(Number(m))}`)
      .replace(/(?<![\p{L}\d.,:])(\d{1,2}):([0-5]\d):([0-5]\d)(?![\p{L}\d]|[.,:]\d)/gu, (_, h, m, s) => longClock(Number(h), Number(m), Number(s)))
      .replace(/(?<![\p{L}\d.,:])(\d{1,2})([h:])([0-5]\d)(?![\p{L}\d]|:\d)/gu, (match, h, mark, m, at, whole) => {
        const hour = Number(h)
        const isClock = mark === ':' || hour >= 13 || /(?:^|[^\p{L}])(?:às|as|das|até|ate|à)\s+$/iu.test(whole.slice(0, at))
        if (isClock) return hour > 23 ? match : clock(hour, m)
        return m === '00' ? hours(hour) : `${hours(hour)} e ${minutes(Number(m))}`
      })
      .replace(/(?<![\p{L}\d.,:])(\d{1,3})h(?![\p{L}\d])/gu, (_, h) => hours(Number(h)))
      // "v1.2" is "versão 1.2"; after "versão" or "version" a number is always a version, even 1.234.
      .replace(/(?<![\p{L}\d])v(?=\d+(?:\.\d+)+(?![\p{L}\d]))/giu, 'versão ')
      // A period between digits is a version (Opus 5.5, 0.8.1), said "5 ponto 5"; "1.500" (thousands) stays.
      .replace(/(?<![\p{L}\d.,])\d+(?:\.\d+)+(?![\p{L}\d])/gu, (n, at, whole) =>
        /^\d{1,3}(?:\.\d{3})+$/.test(n) && !/(?:^|[^\p{L}])(?:versão|versao|version)\s+$/iu.test(whole.slice(0, at)) ? n : n.split('.').join(' ponto '),
      )
      .replace(/(\d)\s?%/g, '$1 por cento')
  )
}

// English tech words in the respelling a pt-BR voice needs; anything else stays as written.
export function respell(text) {
  return String(text ?? '').replace(/\p{L}[\p{L}\d]*/gu, word => RESPELL[word.toLowerCase()] ?? word)
}

// The native voice says "Bom dia!" as "bem dia" (3 of 4 seeds, by ear); "Bom dia!!" came out right on 10 of 10.
const BOM_DIA = /(?<![\p{L}\d])(bom\s+dia)!(?!!)/giu

// The native voice says a sentence-opening "Claro" as another word (the ASR heard "Se é o que
// sim"); mid-sentence it is fine. By ear, on the production path: a lone "Claro." came out right as
// "claro." and "Claro que sim" / "Claro, posso" as "Claaro que sim" / "Claaro, posso" ("Cla ro" was wrong).
const CLARO_ALONE = /(^|[.!?…]\s+)Claro(?=[.!?…]+(?:\s|$))/gu
const CLARO_QUE = /(^|[.!?…]\s+)Claro(?=,|\s+que(?![\p{L}\d]))/gu

// English tech words in the spelling the native voice says best; anything else stays as written.
export function respellNative(text) {
  return String(text ?? '')
    .replace(NATIVE_RE, word => NATIVE_RESPELL[word.toLowerCase().replace(/\s+/g, ' ')])
    .replace(CLAUDE_CODE_COMMA, 'Clód Code')
    .replace(BOM_DIA, '$1!!')
    .replace(CLARO_ALONE, '$1claro')
    .replace(CLARO_QUE, '$1Claaro')
}

// Where a sentence ends: a run of . ! ? … (and any closing quote or bracket) followed by a space or
// the end. A period inside a word or number (5.5, 1.500, app.js) never ends one, nor one after a
// common abbreviation (Sr., Dr., ex., vs.), nor "etc." when the sentence goes on in lower case.
const SENTENCE_END = /[.!?…]+["'”’»)\]]*(?=\s|$)/g
const ABBREVIATION_END = /(?:^|[^\p{L}\d])(?:sr|sra|srta|srs|dr|dra|drs|prof|profa|exmo|exma|ex|p\.\s?ex|n|vs|aprox|pág|pag|tel|av|obs|cap|fig|art|vol)\.$/iu

export function sentences(text) {
  const all = String(text ?? '')
  const out = []
  let from = 0
  for (const match of all.matchAll(SENTENCE_END)) {
    const end = match.index + match[0].length
    if (match[0] === '.') {
      const before = all.slice(Math.max(0, match.index - 8), end)
      if (ABBREVIATION_END.test(before)) continue
      if (/(?:^|[^\p{L}])etc\.$/iu.test(before) && /^\s+\p{Ll}/u.test(all.slice(end))) continue
    }
    out.push(all.slice(from, end))
    from = end
  }
  out.push(all.slice(from))
  // Nothing to say in a piece without a letter or digit (a stray "..." or "?").
  return out.map(s => s.trim()).filter(s => /[\p{L}\d]/u.test(s))
}

// Sentences; a sentence longer than `max` is cut at a comma or space. When the first sentence is
// longer than `first`, it is cut at its first comma (if that comma is within twice `first`), so the
// first audio starts sooner. Never mid-phrase for that early cut: the voice would pause where a
// person would not, so without a comma close by the first sentence goes whole. A question is never
// cut early: the voice rises at its end only when it sees the "?".
export function chunks(text, max = MAX_CHUNK, first = max) {
  const out = []
  for (let sentence of sentences(text)) {
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
