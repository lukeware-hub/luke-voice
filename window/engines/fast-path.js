// Things the user says that the local voice handles at once, with no brain call (no wait, no tokens).

// The assistant's name as the ears write it: Whisper and Qwen3-ASR sometimes write "Ceci" as
// "Cecy", "Sessi" or "Cessi", and "Nara" as "Narah" ("Nará" loses its accent in plain()).
const NAMES = ['luke', 'ceci', 'cecy', 'sessi', 'cessi', 'sesi', 'nara', 'narah']
const NAME = `(?:${NAMES.join('|')})`
const STOP_WORD = '(?:pare|para|parar|cancela|cancelar|chega|espera|cala)'
const STOP_FILLER = '(?:tudo|agora|o claude|as? tarefas?|isso|por favor|ai|a boca|de falar)'

// A whole utterance that only asks to stop. "para" inside a longer sentence ("cria uma tarefa para...")
// is a preposition, so the utterance must be stop words only: the name may come first, and after
// the first stop word come only more stop words, the name and a few fillers ("Para, Ceci, para!",
// "para, para", "Ceci, para, por favor", "chega, Ceci").
const STOP_ONLY = new RegExp(`^\\W*(${NAME}\\W+)*${STOP_WORD}(\\W+(${STOP_WORD}|${NAME}|${STOP_FILLER}))*\\W*$`, 'i')

const plain = text =>
  String(text ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .trim()

export const isStopOnly = text => STOP_ONLY.test(plain(text))

// A stop that names Claude's work ("para o Claude", "cancela a tarefa", "para tudo"). Said over
// Ceci, a bare "para" is for her alone: she stops talking and Claude's task goes on.
export const isStopClaude = text => isStopOnly(text) && /\b(claude|tarefas?|tudo)\b/.test(plain(text))

// Who a stop is for: 'claude' when it names Claude's work, 'ceci' for a bare one ("para", "cancela",
// "espera"), which only quiets her, null when it is not a stop.
export const stopTarget = text => (isStopClaude(text) ? 'claude' : isStopOnly(text) ? 'ceci' : null)

// Words a short answer to "ok?" is made of. A yes must have at least one YES word and nothing
// outside YES and FILLER; a no, at least one NO word and nothing outside NO and FILLER. Longer
// answers ("sim, mas só na pasta X") go to the brain.
// The ears cut short words: "Pode." comes back as "Pod." and "ok" as "Okei" (heard on Qwen3-ASR).
const YES = new Set([
  'sim', 'pode', 'pod', 'podi', 'claro', 'manda', 'bora', 'isso', 'ok', 'okay', 'okei', 'oquei', 'oke', 'okey', 'beleza', 'certo', 'positivo', 'faz', 'faca', 'vai', 'confirmo', 'confirmado',
  'perfeito', 'show', 'fechado', 'fechou', 'combinado', 'certeza', 'yes', 'ta', 'uhum', 'aham', 'exato', 'exatamente', 'segue',
  // More ways to agree: slang, formal and English ones ("blz", "autorizado", "yeah"), and "ahã" as the ears write it.
  'blz', 'logico', 'obvio', 'otimo', 'legal', 'tranquilo', 'joia', 'massa', 'bacana', 'demorou', 'certinho', 'aha', 'dale',
  'concordo', 'aceito', 'autorizo', 'autorizado', 'aprovado', 'confirma', 'confirmar', 'vamos', 'vamo',
  'yeah', 'yep', 'yup', 'sure',
  // Formal and slang yeses, "quero", and the grunts of agreeing ("ahan", "mhm", "hum").
  'correto', 'corretissimo', 'certissimo', 'afirmativo', 'certamente', 'quero', 'opa', 'simbora', 'partiu', 'exactamente', 'exacto',
  'ahan', 'anham', 'unhum', 'mhm', 'hum',
  // Asking to go on ("prosseguir", "pode continuar", "siga"): during a confirmation, going on is a yes.
  'prosseguir', 'prossegue', 'prossiga', 'continue', 'continua', 'continuar', 'siga', 'seguir', 'avanca', 'avancar', 'mande', 'comeca', 'comecar', 'comece',
])
// Agreements of several words, said as one: each becomes "sim" before the words are counted
// ("sem problema", "tudo bem", "de acordo"). Alone, their words are not a yes ("problema", "acordo").
// "pois não" and "não tem problema" are yeses that carry a "não": they become "sim" before any no is counted.
const YES_NAO_PHRASES = ['pois nao', 'nao tem problema', 'nao ha problema']
const YES_NAO_RE = new RegExp(`\\b(?:${YES_NAO_PHRASES.join('|')})\\b`, 'g')
const YES_PHRASES = [
  ...YES_NAO_PHRASES, 'sem duvida', 'sem duvidas', 'vai nessa', 'quero sim', 'por mim,? tudo bem', 'o\\.? ?k',
  'sem problema', 'sem problemas', 'tudo bem', 'tudo certo', 'esta bem', 'esta certo', 'ta bem', 'ta certo', 'ta legal', 'esta bom', 'de acordo(?! com)',
  'sim senhor', 'sim senhora', 'pode crer', 'vamos nessa', 'vamos la', 'bora la', 'manda brasa', 'vai fundo', 'toca ficha', 'da-lhe', 'da lhe',
  'com certeza', 'claro que sim', 'pode sim', 'isso mesmo', 'e isso', 'e isso ai',
  'pode ir', 'pode continuar', 'pode seguir', 'pode prosseguir', 'vai em frente', 'segue em frente', 'siga em frente', 'vamos em frente', 'manda bala', 'e pra ja',
]
const YES_PHRASES_RE = new RegExp(`\\b(?:${YES_PHRASES.join('|')})\\b`, 'g')
const NO = new Set([
  'nao', 'negativo', 'esquece', 'deixa', 'cancela', 'cancelar', 'nem',
  // More ways to refuse, and "não" as the ears write a quick or soft one ("Naum", "Num").
  'naum', 'num', 'nope', 'nah', 'nunca', 'jamais', 'negado', 'recuso', 'nada',
])
// Refusals of several words, said as one: each becomes "nao" before the words are counted, so
// "claro que não" is a no and not a yes beside a no.
const NO_PHRASES = ['claro que nao', 'logico que nao', 'obvio que nao', 'com certeza nao', 'certeza que nao', 'acho que nao', 'de jeito nenhum', 'de jeito algum', 'nem pensar', 'nem a pau', 'nem morto', 'nem morta', 'por enquanto nao', 'ainda nao']
const NO_PHRASES_RE = new RegExp(`\\b(?:${NO_PHRASES.join('|')})\\b`, 'g')
// A one-word answer the ears misheard, taken only when it is the whole answer to "ok?": a soft,
// quick "sim" comes back as "Fim." or "Sin.", and a "não" as "Mão." or "Nau." (heard on the real engine).
const LONE_YES = new Set(['fim', 'sin', 'si', 'cim', 'simm', 'siim', 't', 'assim', 'isto', 'okey', 'oki'])
const LONE_NO = new Set(['mao', 'nau', 'naao', 'naaao'])
const FILLER = new Set([
  ...NAMES, 'por', 'favor', 'pode', 'sim', 'ver', 'ai', 'ja', 'agora', 'mesmo', 'com', 'certeza',
  'fazer', 'mandar', 'ir', 'pra', 'para', 'la', 'precisa', 'obrigado', 'obrigada', 'e', 'o', 'a', 'se', 'ya', 'isso', 'melhor', 'tudo', 'bem', 'bom', 'ser', 'que', 'bala',
  'rodar', 'roda', 'seguir', 'continuar', 'continua', 'em', 'frente',
  // The going-on words fill a no too ("não, não prossiga"), so they are fillers as well as yes words.
  'prosseguir', 'prossegue', 'prossiga', 'continue', 'siga', 'avanca', 'avancar', 'comeca', 'comecar', 'comece',
  'gentileza', 'senhor', 'senhora', 'valeu',
  // A destination after the yes ("pode mandar pro Claude"), and "quero" and "hum", which also fill a no ("não quero", "hum, não").
  'claude', 'pro', 'manda', 'quero', 'hum',
])
const MAX_ANSWER_WORDS = 7

const words = text => plain(text).split(/[^a-z]+/).filter(Boolean)

// The one word of an answer, with at most the name beside it ("Fim.", "Ceci, mão"), or ''.
function loneWord(text) {
  const left = words(text).filter(w => !NAMES.includes(w))
  return left.length === 1 ? left[0] : ''
}

function shortAnswer(text, strong, phrases = null, as = 'sim') {
  const heard = phrases ? plain(text).replace(phrases, as) : plain(text)
  const said = heard.split(/[^a-z]+/).filter(Boolean)
  if (said.length === 0 || said.length > MAX_ANSWER_WORDS) return false
  return said.some(w => strong.has(w)) && said.every(w => strong.has(w) || FILLER.has(w))
}

// "sim", "pode", "manda ver", "Sim, pode-se." (as Whisper writes it), "claro, pode fazer".
// A question back ("tá aí?", "pode ser?", "o que?") is never a yes, even when made of yes words.
const QUESTION = new RegExp(`\\?\\W*$|^\\W*(${NAME}\\W+)*(o que|que|como|onde|quando|por que|porque|qual|quem|cade|ta ai)\\b`)
const isPlainYes = text => !QUESTION.test(plain(text)) && !isDeny(text) && !isMixed(text) && (shortAnswer(text, YES, YES_PHRASES_RE) || LONE_YES.has(loneWord(text)))

// How many of the words of `text` are words of `said`, from 0 to 1.
function shareOf(text, said) {
  const words = plain(text).split(/[^a-z]+/).filter(Boolean)
  if (words.length === 0) return 0
  const hers = new Set(plain(said).split(/[^a-z]+/).filter(Boolean))
  return words.filter(word => hers.has(word)).length / words.length
}

// Ceci's own voice can reach the mic and be written down in front of the user's yes ("...o
// resultado? Posso. Sim."), with some of her words misheard. `said` is what she said last: when the
// last sentences are a plain yes and what comes before them is mostly her words, it is a yes too.
export const ECHO_SHARE = 0.5
export function isConfirm(text, said = '') {
  if (isPlainYes(text)) return true
  if (!said || isDeny(text)) return false
  const sentences = String(text ?? '').split(/(?<=[.!?…])\s+/).filter(Boolean)
  for (let k = sentences.length - 1; k >= 1; k--) {
    const tail = sentences.slice(k).join(' ')
    if (!isPlainYes(tail)) continue
    if (shareOf(sentences.slice(0, k).join(' '), said) >= ECHO_SHARE) return true
  }
  return false
}

// "não", "agora não", "deixa pra lá", "melhor não", "esquece", "de jeito nenhum", "claro que não".
// A question back ("não?") is not a no, and neither is a yes beside a no ("sim, não": isMixed).
export const isDeny = text => !/\?\W*$/.test(plain(text)) && !isMixed(text) && (shortAnswer(plain(text).replace(YES_NAO_RE, 'sim'), NO, NO_PHRASES_RE, 'nao') || LONE_NO.has(loneWord(text)))

// The words that ask to go on: "não prossiga" and "não continua" are a no, not a yes beside a no.
const GO_ON = ['prosseguir', 'prossegue', 'prossiga', 'continue', 'continua', 'continuar', 'siga', 'seguir', 'avanca', 'avancar', 'comeca', 'comecar', 'comece']

// Words that only ever mean yes. "pode", "isso", "tá" and "vai" also fill a no ("isso não", "pode
// ser que não", "não tá bom"), so they do not make an answer mixed.
const CLEAR_YES = new Set([...YES].filter(w => !['pode', 'pod', 'podi', 'isso', 'ta', 'vai', 'faz', 'faca', 'segue', 'manda', 'mande', 'bora', 'vamos', 'vamo', 'certeza', 'quero', 'hum', 'opa', 'certamente', ...GO_ON].includes(w)))

// A short answer with both a yes and a no in it ("sim, não", "não, ok", "ok... não"): two voices
// over each other, or a word lost in the noise. Neither runs nor drops the action: Ceci asks again.
export function isMixed(text) {
  const said = words(plain(text).replace(YES_NAO_RE, 'sim').replace(NO_PHRASES_RE, 'nao'))
  if (said.length === 0 || said.length > MAX_ANSWER_WORDS) return false
  if (!said.every(w => YES.has(w) || NO.has(w) || FILLER.has(w))) return false
  return said.some(w => NO.has(w)) && said.some(w => CLEAR_YES.has(w))
}

// What the user can say to confirm Ceci's question and go on, kept in one place: the fast path
// takes every one of these as a yes (fast-path.test.mjs), and the README lists them.
export const CONFIRM_PHRASES = [
  'Sim.', 'Ok.', 'Prosseguir.', 'Pode continuar.', 'Pode ir.', 'Vai.',
  'Pode.', 'Pode sim.', 'Claro.', 'Com certeza.', 'Isso.', 'Isso mesmo.', 'Tá bom.', 'Tudo bem.', 'Beleza.', 'Fechado.',
  'Manda ver.', 'Manda bala.', 'Pode mandar.', 'Pode fazer.', 'Faz isso.', 'Pode seguir.', 'Segue em frente.', 'Vai em frente.',
  'Pode prosseguir.', 'Prossiga.', 'Continua.', 'Pode começar.', 'Bora.', 'Vamos lá.', 'Sim, pode ir.', 'Ok, pode continuar.',
  'Sim, vai.', 'Pode avançar.', 'Confirmo.', 'Autorizado.', 'De acordo.', 'Combinado.', 'Perfeito, pode ir.', 'É pra já.',
  'Correto.', 'Exatamente.', 'Pois não.', 'Sem dúvida.', 'Pode mandar pro Claude.', 'Afirmativo.', 'Quero sim.',
]
