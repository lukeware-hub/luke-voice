// Things the user says that the local voice handles at once, with no brain call (no wait, no tokens).

// A whole utterance that only asks to stop. "para" inside a longer sentence ("cria uma tarefa para...")
// is a preposition, so the stop words must be the whole utterance, with at most a few fillers.
const STOP_ONLY = /^\W*(luke\W+)?(pare|para|parar|cancela|cancelar|chega)(\W+(tudo|agora|o claude|isso|por favor|ai))*\W*$/i

const plain = text =>
  String(text ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .trim()

export const isStopOnly = text => STOP_ONLY.test(plain(text))
