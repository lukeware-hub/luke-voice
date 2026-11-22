// The ElevenLabs engine: speech to text, the agent's brain, the voice and turn-taking all run
// in an ElevenLabs agent over WebRTC. The ElevenLabs key never reaches this page; the hub hands
// it a per-call token. The client comes from a pinned CDN file checked with its integrity hash,
// loaded only when an ElevenLabs call starts: the free voice never waits on the CDN.

export const name = 'elevenlabs'

export const CLIENT_URL = 'https://cdn.jsdelivr.net/npm/@elevenlabs/client@1.26.0/dist/lib.iife.js'
export const CLIENT_INTEGRITY = 'sha384-GAgUf1yx/dGreo/QTqLRVycB5sMQdsPKOmbMWlKec+fjMXzz+OXy4c6EfjB7Anb7'
const CLIENT_TIMEOUT_MS = 20_000
const CLIENT_FAILED = 'Não consegui carregar o cliente da ElevenLabs (cdn.jsdelivr.net). Verifique a internet e toque em Chamar de novo.'

// The ElevenLabs client, loaded once per page. A failed or slow load is not remembered: the next call tries again.
let clientLoad = null
function loadClient() {
  if (window.ElevenLabsClient) return Promise.resolve(window.ElevenLabsClient)
  clientLoad ??= new Promise((resolve, reject) => {
    const script = document.createElement('script')
    const fail = () => {
      clearTimeout(timer)
      script.remove()
      clientLoad = null
      reject(new Error(CLIENT_FAILED))
    }
    const timer = setTimeout(fail, CLIENT_TIMEOUT_MS)
    script.src = CLIENT_URL
    script.integrity = CLIENT_INTEGRITY
    script.crossOrigin = 'anonymous'
    script.referrerPolicy = 'no-referrer'
    script.onload = () => {
      clearTimeout(timer)
      if (window.ElevenLabsClient) resolve(window.ElevenLabsClient)
      else fail()
    }
    script.onerror = fail
    document.head.append(script)
  })
  return clientLoad
}

// Starts a call. `prepare` runs between the token and the connection (the window asks for the mic there).
// The session it returns is what the window drives: sendContextualUpdate, sendUserMessage,
// setMicMuted, getOutputVolume and endSession.
export async function startSession({ hub, prepare = async () => {}, ...options }) {
  // The token first: it also sets up the agent, and its errors say what is missing. The client
  // downloads meanwhile.
  const client = loadClient()
  client.catch(() => {})
  const { token } = await hub('POST', '/token')
  const { Conversation } = await client
  await prepare()
  return Conversation.startSession({ conversationToken: token, connectionType: 'webrtc', ...options })
}

// What to say when the call drops in its first seconds.
export function earlyDropMessage(reason) {
  return `A ElevenLabs encerrou a chamada logo no início${reason && reason !== 'agent' ? `: ${reason}` : ''}. Veja os créditos da sua conta em elevenlabs.io e tente de novo.`
}
