// The download percentage the window shows. The voice worker learns the size of each model file
// only when that file starts (Kokoro first, Whisper after), so its summed total grows and the raw
// percentage would jump back (74% to 20%). Shown, it only goes up; it stops at 99% until the
// voice is ready.
export function risingPercent() {
  let shown = 0
  return ({ loaded, total }) => {
    if (total > 0) shown = Math.max(shown, Math.min(99, Math.round((loaded / total) * 100)))
    return shown
  }
}
