// Piper's phoneme ids, as piper1-gpl builds them: the start mark, then each phoneme followed by
// the pad, then the end mark. Phonemes are Unicode code points of the espeak-ng output (NFD).
// Phonemes the voice does not know are dropped.
export function phonemeIds(phonemes, idMap) {
  const id = symbol => idMap[symbol] ?? []
  const pad = id('_')
  const ids = [...id('^'), ...pad]
  for (const symbol of Array.from(String(phonemes ?? '').normalize('NFD'))) {
    const mapped = idMap[symbol]
    if (!mapped) continue
    ids.push(...mapped, ...pad)
  }
  ids.push(...id('$'))
  return ids
}
