// Things the user says that the local voice handles at once, with no brain call (no wait, no tokens).

// The assistant's name as the ears write it: Whisper and Qwen3-ASR sometimes write "Ceci" as
// "Cecy", "Sessi" or "Cessi", and "Nara" as "Narah" ("Nará" loses its accent in plain()).
const NAMES = ['luke', 'ceci', 'cecy', 'sessi', 'cessi', 'sesi', 'nara', 'narah']
const NAME = `(?:${NAMES.join('|')})`
const STOP_WORD = '(?:pare|para|parar|cancela|cancelar|chega)'
const STOP_FILLER = '(?:tudo|agora|o claude|as? tarefas?|isso|por favor|ai)'

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

// Words a short answer to "posso?" is made of. A yes must have at least one YES word and nothing
// outside YES and FILLER; a no, at least one NO word and nothing outside NO and FILLER. Longer
// answers ("sim, mas só na pasta X") go to the brain.
const YES = new Set(['sim', 'pode', 'claro', 'manda', 'bora', 'isso', 'ok', 'okay', 'beleza', 'certo', 'positivo', 'faz', 'faca', 'vai', 'confirmo', 'confirmado', 'perfeito', 'show', 'fechado', 'combinado', 'certeza', 'yes'])
const NO = new Set(['nao', 'negativo', 'esquece', 'deixa', 'cancela', 'cancelar', 'nem'])
const FILLER = new Set([
  ...NAMES, 'por', 'favor', 'pode', 'sim', 'ver', 'ai', 'ja', 'agora', 'mesmo', 'com', 'certeza',
  'fazer', 'mandar', 'ir', 'pra', 'para', 'la', 'precisa', 'obrigado', 'obrigada', 'e', 'o', 'a', 'se', 'ya', 'isso', 'melhor', 'tudo', 'bem',
])
const MAX_ANSWER_WORDS = 7

function shortAnswer(text, strong) {
  const words = plain(text).split(/[^a-z]+/).filter(Boolean)
  if (words.length === 0 || words.length > MAX_ANSWER_WORDS) return false
  return words.some(w => strong.has(w)) && words.every(w => strong.has(w) || FILLER.has(w))
}

// "sim", "pode", "manda ver", "Sim, pode-se." (as Whisper writes it), "claro, pode fazer".
export const isConfirm = text => !isDeny(text) && shortAnswer(text, YES)

// "não", "agora não", "deixa pra lá", "melhor não", "esquece".
export const isDeny = text => shortAnswer(text, NO)
