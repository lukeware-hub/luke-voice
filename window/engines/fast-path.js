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

// Words a short answer to "posso?" is made of. A yes must have at least one YES word and nothing
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
])
// Agreements of several words, said as one: each becomes "sim" before the words are counted
// ("sem problema", "tudo bem", "de acordo"). Alone, their words are not a yes ("problema", "acordo").
const YES_PHRASES = [
  'sem problema', 'sem problemas', 'tudo bem', 'tudo certo', 'esta bem', 'esta certo', 'ta bem', 'ta certo', 'ta legal', 'esta bom', 'de acordo(?! com)',
  'sim senhor', 'sim senhora', 'pode crer', 'vamos nessa', 'vamos la', 'bora la', 'manda brasa', 'vai fundo', 'toca ficha', 'da-lhe', 'da lhe',
  'com certeza', 'claro que sim', 'pode sim', 'isso mesmo', 'e isso', 'e isso ai',
]
const YES_PHRASES_RE = new RegExp(`\\b(?:${YES_PHRASES.join('|')})\\b`, 'g')
const NO = new Set(['nao', 'negativo', 'esquece', 'deixa', 'cancela', 'cancelar', 'nem'])
const FILLER = new Set([
  ...NAMES, 'por', 'favor', 'pode', 'sim', 'ver', 'ai', 'ja', 'agora', 'mesmo', 'com', 'certeza',
  'fazer', 'mandar', 'ir', 'pra', 'para', 'la', 'precisa', 'obrigado', 'obrigada', 'e', 'o', 'a', 'se', 'ya', 'isso', 'melhor', 'tudo', 'bem', 'bom', 'ser', 'que', 'bala',
  'rodar', 'roda', 'seguir', 'continuar', 'continua', 'em', 'frente',
  'gentileza', 'senhor', 'senhora', 'valeu',
])
const MAX_ANSWER_WORDS = 7

function shortAnswer(text, strong, phrases = null) {
  const heard = phrases ? plain(text).replace(phrases, 'sim') : plain(text)
  const words = heard.split(/[^a-z]+/).filter(Boolean)
  if (words.length === 0 || words.length > MAX_ANSWER_WORDS) return false
  return words.some(w => strong.has(w)) && words.every(w => strong.has(w) || FILLER.has(w))
}

// "sim", "pode", "manda ver", "Sim, pode-se." (as Whisper writes it), "claro, pode fazer".
// A question back ("tá aí?", "pode ser?", "o que?") is never a yes, even when made of yes words.
const QUESTION = new RegExp(`\\?\\W*$|^\\W*(${NAME}\\W+)*(o que|que|como|onde|quando|por que|porque|qual|quem|cade|ta ai)\\b`)
const isPlainYes = text => !QUESTION.test(plain(text)) && !isDeny(text) && shortAnswer(text, YES, YES_PHRASES_RE)

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

// "não", "agora não", "deixa pra lá", "melhor não", "esquece".
export const isDeny = text => shortAnswer(text, NO)
