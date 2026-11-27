// Qwen3-ASR sometimes writes down its own prompt instead of the audio. On silence or soft noise
// that passed the speech check, it hands back the whole prompt word for word ("Conversa em
// português do Brasil com a Ceci... Ceci acabou de dizer: ... Posso?"), and the window took that
// for the user's words: Ceci heard her own last line, or the glossary, as if the user said it.
// Parts of the prompt can also come before what the user really said ("...Posso? Sim.").
//
// withoutPromptLeak() removes, from the transcript, every run of words that is a run of the
// prompt and looks like a leak: a long run that touches the fixed part (the glossary, the
// session list, "Ceci acabou de dizer"), or one that reaches the prompt's end (her last line
// copied to its question mark). A user who repeats a few of Ceci's words ("pode rodar os testes")
// keeps them: those runs are short and do not reach the end of her line.

// Runs shorter than this are never a leak: people repeat a few words of what they just heard.
export const MIN_LEAK_WORDS = 6
// What starts Ceci's own words in the prompt; everything before it is fixed text.
export const SAID_MARK = 'Ceci acabou de dizer:'

const normalize = word =>
  word
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '')

const wordsOf = text =>
  String(text ?? '')
    .split(/[\s,.;:!?()"]+/)
    .map(normalize)
    .filter(Boolean)

// Qwen3-ASR starts its text with "language Portuguese<asr_text>". With no words in the audio it can
// hand back its language tag alone, with no <asr_text> after it ("(language: pt)", heard as the
// answer to a "ok?"): nothing the user said. A long turn heard in pieces (asr-split.mjs) must
// not get the tag of one quiet piece in the middle of the user's words either.
const LANGUAGE_TAG = /^\s*\(?\s*language\s*:?\s*(?:pt|portuguese)(?:[\s_-]*br)?\s*\)?[\s.]*/i
const ASR_TEXT = '<asr_text>'

// The words of one Qwen3-ASR answer: what follows its last <asr_text>, or the text with a leading
// language tag removed.
export function asrWords(raw) {
  const text = String(raw ?? '')
  const tagged = text.lastIndexOf(ASR_TEXT)
  return (tagged >= 0 ? text.slice(tagged + ASR_TEXT.length) : text.replace(LANGUAGE_TAG, '')).trim()
}

export function withoutPromptLeak(text, prompt) {
  const tokens = String(text ?? '')
    .split(/\s+/)
    .filter(Boolean)
    .map(raw => ({ raw, word: wordsOf(raw).join('') }))
  const said = String(prompt ?? '').indexOf(SAID_MARK)
  const fixedEnd = wordsOf(said < 0 ? prompt : String(prompt).slice(0, said + SAID_MARK.length)).length
  const p = wordsOf(prompt)
  if (tokens.length === 0 || p.length === 0) return String(text ?? '').trim()

  // The words, with tokens that are only punctuation ("—", "...") glued to the word before.
  const words = []
  for (const token of tokens) {
    if (token.word) words.push({ ...token })
    else if (words.length) words.at(-1).raw += ` ${token.raw}`
  }

  const kept = []
  let i = 0
  while (i < words.length) {
    // The longest run of words from i that is a run of the prompt, and where it is in the prompt.
    let best = 0
    let at = -1
    for (let j = 0; j < p.length; j++) {
      let k = 0
      while (i + k < words.length && j + k < p.length && words[i + k].word === p[j + k]) k++
      if (k > best || (k === best && k > 0 && j + k === p.length)) {
        best = k
        at = j
      }
    }
    const touchesFixed = at >= 0 && at < fixedEnd
    const reachesEnd = at >= 0 && at + best === p.length
    if (best >= MIN_LEAK_WORDS && (touchesFixed || reachesEnd)) {
      i += best
      continue
    }
    kept.push(words[i].raw)
    i++
  }
  return kept.join(' ').trim()
}
