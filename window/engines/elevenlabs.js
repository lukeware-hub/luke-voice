// The ElevenLabs engine: speech to text, the agent's brain, the voice and turn-taking all run
// in an ElevenLabs agent over WebRTC. The ElevenLabs key never reaches this page; the hub hands
// it a per-call token. The client comes from a pinned CDN file that index.html loads with an
// integrity hash.

export const name = 'elevenlabs'

// Starts a call. `prepare` runs between the token and the connection (the window asks for the mic there).
// The session it returns is what the window drives: sendContextualUpdate, sendUserMessage,
// setMicMuted, getOutputVolume and endSession.
export async function startSession({ hub, prepare = async () => {}, ...options }) {
  const { Conversation } = window.ElevenLabsClient
  // The token first: it also sets up the agent, and its errors say what is missing.
  const { token } = await hub('POST', '/token')
  await prepare()
  return Conversation.startSession({ conversationToken: token, connectionType: 'webrtc', ...options })
}

// What to say when the call drops in its first seconds.
export function earlyDropMessage(reason) {
  return `A ElevenLabs encerrou a chamada logo no início${reason && reason !== 'agent' ? `: ${reason}` : ''}. Veja os créditos da sua conta em elevenlabs.io e tente de novo.`
}
