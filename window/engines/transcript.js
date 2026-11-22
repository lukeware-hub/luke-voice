// What the ears hand back that the user did not say: no letter or digit at all (a lone "." or
// "..."), or a phrase Whisper makes up from silence and noise (it learned them from video
// subtitles). A phrase drops the transcript only when it is the whole of it, so a real sentence
// that happens to contain one ("obrigado por assistir o deploy comigo") still reaches the brain.
// "Obrigado." and "tchau." alone are said to Ceci for real, so they are not on the list.
const PHANTOMS = [
  'obrigad[oa] por assistir(?:em)?',
  'legendas? pela comunidade amara org',
  'inscreva se(?: no canal)?',
  'se inscreva(?: no canal)?',
]
const PHANTOM_ONLY = new RegExp(`^(?: ?(?:${PHANTOMS.join('|')}))+$`)

// Lower case, no accents, words split by single spaces: "Inscreva-se!" is "inscreva se".
const normalize = text =>
  String(text ?? '')
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()

export function isNotSpeech(text) {
  const words = normalize(text)
  return !words || PHANTOM_ONLY.test(words)
}
