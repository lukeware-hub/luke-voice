# luke-voice

**Leia em português: [README.pt-BR.md](README.pt-BR.md)**

Ceci, a voice assistant beside your Claude Code session, in Brazilian Portuguese. You say what you want, she repeats it and asks "posso?", and after your "sim" a Claude Code subagent does the task on your computer. When it finishes, she tells you the result out loud.

Ceci has two voices:

| | Free voice (default) | ElevenLabs voice (optional) |
| --- | --- | --- |
| Cost | Free. It uses your Claude account for the short replies. | Paid per use (the free plan gives about 15 minutes a month). |
| Where it runs | On your computer, in the call window (Whisper to listen, Kokoro to speak). | In an ElevenLabs agent, over the internet. |
| What you need | Nothing extra. The first call downloads 270 to 430 MB, once. | An ElevenLabs key. |
| Sound | Good, a little synthetic in Portuguese. | The most natural. |

> Not affiliated with ElevenLabs. The ElevenLabs voice calls the public ElevenLabs API with your own key.

## Install in 5 steps

Each step says how to know it worked. Do them in order.

### 1. Have Claude Code working

Install it from [claude.com/claude-code](https://claude.com/claude-code), open it, and sign in once.
**Done when:** you can type a message in Claude Code and get an answer.

### 2. Install Node.js 20 or newer

Download the **LTS** version from [nodejs.org](https://nodejs.org) and install it with the default options. luke-voice uses it to run a small local server.
**Done when:** `node -v` in a terminal prints `v20` or higher.

### 3. Have Google Chrome

The call window opens in Chrome, in a profile of its own, so your normal Chrome does not change. Any browser with a microphone works if Chrome is missing, but then you may have to allow the microphone by hand.

### 4. Run the installer

- **Windows:** download [install-luke-voice-windows.cmd](https://github.com/lukeware-hub/luke-voice/releases/latest/download/install-luke-voice-windows.cmd) and double-click it. If Windows says "Windows protected your PC", click **More info** and then **Run anyway**.
- **macOS / Linux:** paste this in the Terminal:

  ```bash
  curl -fsSL https://raw.githubusercontent.com/lukeware-hub/luke-voice/main/install/install.sh | bash
  ```

When it asks **Which voice should Ceci use?**:
- Press **Enter** for the free voice. Nothing else is needed.
- Or type **e** for ElevenLabs. It then asks for the **Key**. To get one:
  1. Create an account at [elevenlabs.io](https://elevenlabs.io).
  2. Open [elevenlabs.io/app/settings/api-keys](https://elevenlabs.io/app/settings/api-keys) and click **Create API key**. If it asks which permissions, keep **Agents** and **Voices** allowed.
  3. Paste the key and press Enter. It stays hidden.

**Done when:** it ends with the green message **Installation complete**. If it stops, read the **What to do** line, fix that one thing and run it again.

To install without questions, set `LUKE_VOICE_PROVIDER=local` (or `elevenlabs`) and `LUKE_VOICE_NO_PROMPT=1` before you run it.

### 5. Restart Claude Code, then turn it on

1. **Close Claude Code completely and open it again.** `/reload-plugins` is not enough to load a new install or update.
2. Above the prompt you see **✦ luke-voice: off**. Click it. It turns **on**, a window opens and the call starts by itself.
3. The first call takes longer:
   - **Free voice:** the window shows "Baixando a voz gratuita… N%" while it downloads 270 to 430 MB, once.
   - **ElevenLabs:** luke-voice creates an agent named `luke-voice` and adds the voice "Roberta" to your account.

**Done when:** you hear "Oi! Eu sou a Ceci. O que vamos fazer hoje?". If anything is missing, type `/luke-voice help`: it checks your setup and says what to fix.

## Use

Speak normally, in Portuguese. Example: *"Verifica no repositório luke-voice onde o botão de ligar é desenhado."*
1. Ceci repeats it and asks "posso?". Say "sim".
2. The request shows in **Histórico** in the window.
3. She tells you the answer when the subagent finishes. The main chat stays free.

Say **"pare"** (or "para tudo", "Ceci, para") to stop Claude at once.

| | |
| --- | --- |
| the **✦ luke-voice** button | turn it on (opens the window and starts the call) or off |
| `/luke-voice` | the same as the button |
| `/luke-voice call` | open the window and start the call |
| `/luke-voice end` | hang up |
| `/luke-voice window` | bring the window to the front |
| `/luke-voice voz` | show the voice; `voz local` or `voz elevenlabs` switches it for the next call |
| `/luke-voice status` | technical status: hub, voice, call, key, queue |
| `/luke-voice help` | everything you need to know, plus a check of what is missing |

It starts **off**, and remembers your choice. When Claude Code opens with it already on, it only reconnects: it never starts a call you did not ask for.

### Switching the voice

Pick it in any of these ways; the newest choice wins:
- `/luke-voice voz local` or `/luke-voice voz elevenlabs` in Claude Code (takes effect on the next call);
- the installer;
- `/plugin configure luke-voice@luke-voice`, option **voice_provider**.

With no choice at all, luke-voice uses ElevenLabs while a key is saved, and the free voice otherwise.

### What leaves your computer

- **While it is off:** nothing.
- **Free voice:** the audio never leaves your computer. The text of what you said, a short summary of what happens in the session, and finished task results go to Claude Haiku on your Claude account, which decides what Ceci says. The models download from Hugging Face the first time.
- **ElevenLabs voice:** your voice and what happens in the session (your prompts and Claude's tool calls) go to your agent at ElevenLabs.

## If something does not work

| What you see | What to do |
| --- | --- |
| You hear nothing | Check that your computer's sound is on and that the window says **Em chamada**. |
| The first free call takes minutes | It is downloading the voice (270 to 430 MB), once. The window shows the percentage. |
| Ceci takes a few seconds to answer | Normal: she thinks with Claude Haiku. On a computer without a graphics card, the free voice also takes 1 to 2 seconds longer to listen and speak. |
| The free voice sounds more robotic | On a slow computer, Ceci switches to Piper, a lighter voice, so she does not stutter. **Settings** in the window shows which voice model speaks. |
| "Falta a chave da ElevenLabs" or "Chave: faltando" | Save the key with `/plugin configure luke-voice@luke-voice` (or run the installer again) and restart Claude Code. Or use the free voice: `/luke-voice voz local`. |
| You changed the ElevenLabs key and nothing changed | The key is stored by Claude Code (in the Keychain on macOS). A key exported in `~/.zshrc` does not reach a Claude Code opened from the Dock. Save it with `/plugin configure` and restart Claude Code. |
| The microphone does not work | In the call window, allow the microphone, then tap **Chamar** again. |
| The window says **Hub offline** | Turn luke-voice on in Claude Code; the window reconnects by itself. |
| ElevenLabs: the call stopped connecting | Your free minutes for the month may be over. Check your usage at elevenlabs.io, or switch to the free voice. |
| The window still has the old look | Close Claude Code completely and open it again. |
| Installer: "Claude Code was not found" or "Node.js was not found" | Do step 1 or step 2, then run the installer again. |
| Anything else | Type `/luke-voice status` and send the result to whoever maintains luke-voice. |

## Uninstall

In Claude Code, type `/plugin`, choose **luke-voice** and **Uninstall**. Or run `claude plugin uninstall luke-voice@luke-voice`.

<details>
<summary>Manual install (for developers)</summary>

```bash
claude plugin marketplace add lukeware-hub/luke-voice
claude plugin install luke-voice@luke-voice
printf '{"voice_provider":"local"}' | claude plugin configure luke-voice@luke-voice --values-stdin
# ElevenLabs instead:
printf '{"voice_provider":"elevenlabs","api_key":"%s"}' "$ELEVENLABS_API_KEY" | claude plugin configure luke-voice@luke-voice --values-stdin
```

Or export `ELEVENLABS_API_KEY` and `LUKE_VOICE_PROVIDER` before you start Claude Code. Then restart Claude Code.

</details>

## How it works

```
Claude session ── luke-voice mod ── events, long-poll ──┐
Claude session ── luke-voice mod ── events, long-poll ──┤
                                                        ▼
                                              hub/server.mjs on 127.0.0.1:4848
                                                        │ SSE
                                                        ▼
                                                   call window
                         free voice ┌─────────────────────┴─────────────────────┐ ElevenLabs voice
  mic → level detector → Whisper → POST /brain → mod → claude -p (Haiku)      WebRTC ── ElevenLabs agent
        Kokoro (or Piper) ← what Ceci says ←──────────────┘
```

- `hooks/register.tsx` is the mod. It reports activity, pulls commands from the hub and runs them in its own session. For the free voice it also runs the brain: one short `claude -p` call per turn (Claude Haiku 5.5, no tools, no MCP servers, no settings, no saved session).
- `hub/launch.mjs` starts the hub detached when it is down. The hub exits after ten idle minutes. `LUKE_VOICE_PORT` moves it (and the mod follows).
- `hub/agent.mjs` creates or updates the ElevenLabs agent from `agent/agent.json` and `agent/prompt.md` (plain REST, no packages). Change those files and the next ElevenLabs call syncs the agent. The free voice's brain reads `agent/brain-prompt.md`.
- `window/` is the call window. `window/engines/elevenlabs.js` drives the ElevenLabs client. `window/engines/local.js` drives the free voice:
  - **Listening:** `vad.js` (a voice detector on audio level) and Whisper base in `voice-worker.js`.
  - **Speaking:** Kokoro-82M, with pt-BR phonemes from espeak-ng. Piper `pt_BR-faber` is the fallback on slow computers.
  - **Speech text:** `speech-text.js` strips markdown and code and respells English tech words.
- `hub/vendor.mjs` lists the third-party browser code for the free voice (transformers.js, onnxruntime-web, espeak-ng): each file is pinned by version and sha384, downloaded once by the hub and served from `/vendor/`.

## Security

- The hub listens on 127.0.0.1 only and refuses any other `Host` or `Origin`.
- The ElevenLabs key stays in the hub process. The window gets a short-lived conversation token per call.
- Three secrets:
  - the service token in `~/.luke-voice/hub.json` (mode 600) lets a mod subscribe;
  - each subscription gets its own session token for its inbox;
  - the window key (in the window URL) can send commands but cannot read an inbox.
- The agent requires signed tokens, so its id alone cannot start a call.
- Prompts reach Claude framed as relayed by luke-voice, and the pane lists each one.
- The call window loads the ElevenLabs client from a pinned CDN file checked with Subresource Integrity.
- The free voice's code is checked by sha384 before the hub serves it. Model weights are data and come from Hugging Face; the Piper voice is pinned to one revision.
- Session activity and task results reach either brain only as marked untrusted context, never as the user's words.
- The tools that act on the computer are refused until the user speaks after an automatic update.
- The window is cross-origin isolated (COOP and COEP), which the free voice needs to run on several CPU threads.

## Development

```bash
claude --plugin-dir .                 # load this clone, hot-reloads
claude plugin validate .
claude plugin test .
node --test hub/*.test.mjs window/*.test.mjs window/engines/*.test.mjs
```

Free-voice switches for testing, added to the call window URL:

| Switch | What it does |
| --- | --- |
| `&voice-echo=1` | Ceci repeats what she heard instead of thinking |
| `&voice-device=wasm` | Run Kokoro on the CPU even with a graphics card |
| `&voice-tts=piper` or `kokoro` | Force the voice model |
| `&voice-stt=small` | Whisper small instead of base |
| `&voice-dtype=`, `&voice-stt-dtype=`, `&voice-stt-device=`, `&voice-threads=` | Model precision, Whisper device, CPU threads |

The window console logs one `[luke-voice]` line per step with its time.

## License

MIT. Written from scratch; it shares no code with other voice mods.

The free voice downloads third-party parts at run time; none of them is in this repository:
- Kokoro-82M: Apache-2.0.
- Whisper: MIT.
- transformers.js and onnxruntime-web: Apache-2.0 and MIT.
- The Piper voice: see its model card.
- espeak-ng (through espeak-phonemizer): GPL-3.0.
