# luke-voice

**Leia em português: [README.pt-BR.md](README.pt-BR.md)**

Ceci, a voice assistant beside your Claude Code session, in Brazilian Portuguese. You say what you want, she repeats it and asks "posso?", and after your "sim" a Claude Code subagent does the task on your computer. When it finishes, she tells you the result out loud.

Ceci has two voices:

| | Free voice (default) | ElevenLabs voice (optional) |
| --- | --- | --- |
| Cost | Free. It uses your Claude account for the short replies. | Paid per use (the free plan gives about 15 minutes a month). |
| Where it runs | On your computer. Models run locally (natural voice on a computer with a good graphics card, light voice on any other). | In an ElevenLabs agent, over the internet. |
| What you need | Nothing extra. The installer downloads the voice once: about 2.8 GB (natural voice) or about 320 MB (light voice). | An ElevenLabs key. |
| Sound | Natural voice: cloned from a reference clip, in Brazilian Portuguese. Light voice: good, a little synthetic. | The most natural. |

> Not affiliated with ElevenLabs. The ElevenLabs voice calls the public ElevenLabs API with your own key.

### The two profiles of the free voice

luke-voice picks the profile by itself at install time:

| | gpu profile ("natural voice") | light profile ("light voice") |
| --- | --- | --- |
| When | llama.cpp sees a GPU with at least 6 GB of video memory (NVIDIA, AMD or Intel through Vulkan on Windows and Linux; Apple Silicon through Metal on macOS arm64). | Everything else. |
| Speaks | Qwen3-TTS 12Hz 0.6B Base, cloned at run time from `agent/ceci-voice.wav` and its transcript `agent/ceci-voice.txt`. | Kokoro-82M in the browser. Piper `pt_BR-faber` is the fallback on slow computers. |
| Listens | Qwen3-ASR 0.6B. | Whisper base in the browser. |
| Small talk | An instant local router, Qwen3.5 0.8B on the CPU. | Goes to Claude Haiku like everything else. |
| Download | About 2.8 GB, once. No Python, no PyTorch. | About 320 MB, once (about 480 MB on a machine with a small GPU, where Kokoro runs in fp32 on WebGPU). |

On the gpu profile, the hub downloads llama.cpp's official release build b12556 (pinned by sha256, about 39 MB) and runs three local `llama-server` processes: Ceci's voice, her ears and the router.

`LUKE_VOICE_PROFILE=gpu` or `light` forces a profile: an installer environment variable, or for the hub (it prepares that profile on its next start).

## Install in 5 steps

Each step says how to know it worked. Do them in order.

**Or let Claude Code do it:** with steps 1 and 2 done, send Claude Code this message: *"Instale o luke-voice seguindo https://github.com/lukeware-hub/luke-voice/blob/main/INSTALL.md"*. [INSTALL.md](INSTALL.md) has a section for AI agents with the exact commands.

### 1. Have Claude Code working

Install it from [claude.com/claude-code](https://claude.com/claude-code), open it, and sign in once.
**Done when:** you can type a message in Claude Code and get an answer.

### 2. Install Node.js 20 or newer

Download the **LTS** version from [nodejs.org](https://nodejs.org) and install it with the default options. luke-voice uses it to run a small local server.
**Done when:** `node -v` in a terminal prints `v20` or higher.

### 3. Have Google Chrome

The call window opens in Chrome, in a profile of its own, so your normal Chrome does not change. Any browser with a microphone works if Chrome is missing, but then you may have to allow the microphone by hand.

### 4. Run the installer

- **Windows:** open PowerShell and paste this line:

  ```powershell
  powershell -c "irm https://raw.githubusercontent.com/lukeware-hub/luke-voice/main/install/install-luke-voice-windows.cmd | iex"
  ```

  Or download [install-luke-voice-windows.cmd](https://raw.githubusercontent.com/lukeware-hub/luke-voice/main/install/install-luke-voice-windows.cmd) and double-click it. If Windows says "Windows protected your PC", click **More info** and then **Run anyway**.
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

The installer has 6 steps. The last one, **Downloading Ceci's voice (up to 3 GB, only once)**, runs `node hub/setup.mjs`. It picks the profile, downloads everything and checks each file by sha256. Downloads can resume if they are cut. On the gpu profile it also runs a short test: Ceci says a line, her ears write it back, and the router answers a greeting. If the test fails, setup downloads the light voice too (about 320 MB) and calls use it until `/luke-voice setup` passes the test.

**Done when:** it ends with the green message **Installation complete**. If it stops, read the **What to do** line, fix that one thing and run it again.

To install without questions, set `LUKE_VOICE_PROVIDER=local` (or `elevenlabs`) and `LUKE_VOICE_NO_PROMPT=1` before you run it. Add `LUKE_VOICE_PROFILE=gpu` or `light` to force the profile. `LUKE_VOICE_REF=<branch or tag>` installs that version instead of `main`, to test a change.

### 5. Restart Claude Code, then turn it on

1. **Close Claude Code completely and open it again.** `/reload-plugins` is not enough to load a new install or update.
2. Above the prompt you see **✦ luke-voice: off**. Click it. It turns **on**, a window opens and the call starts by itself.
3. The first call:
   - **Free voice:** the voice is already downloaded by the installer. If you updated through the marketplace and nothing was downloaded yet, run `/luke-voice setup`. Or just call: the first call prepares the voice, with the progress in the window.
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
| `/luke-voice setup` | download and check Ceci's free voice (for people who update through the marketplace) |
| `/luke-voice status` | technical status: hub, voice, profile, call, key, queue, setup progress |
| `/luke-voice help` | everything you need to know, plus a check of what is missing |

It starts **off**, and remembers your choice. When Claude Code opens with it already on, it only reconnects: it never starts a call you did not ask for.

`/luke-voice setup` does the same as installer step 6, from Claude Code. With luke-voice on, the hub prepares the voice in the background and `/luke-voice status` shows the progress. With it off, setup runs directly (up to 10 minutes per run; a cut download resumes on the next run).

### A faster brain

Ceci's brain is Claude Haiku 5.5, called directly through the mod engine's `$.model.complete` at effort low, with the prompt cached. The `claude -p` call remains only as a fallback. Measured brain turns take 0.9 to 2.8 s (they took 6 to 28 s before).

Some things need no model call at all:
- "pare" or "para" stops Claude.
- When Ceci asks "posso?", a plain "sim" runs the pending action at once, and a plain "não" cancels it.
- When the brain takes more than 600 ms, Ceci says a short acknowledgement ("Certo.", "Deixa eu ver.").
- On the gpu profile, a local router answers small talk (greetings, thanks, goodbyes, "who are you", her age, who created her) in about 0.3 s, with lines written in `hub/router.mjs`, so it never invents anything. Anything else, and any request, goes to Claude Haiku. A word check on top of the small model makes sure a request is never answered locally (0 of 49 test requests were).

### Knowing when you finished talking

Silero VAD (MIT) drops sounds without speech. Pipecat Smart Turn v3.2 (BSD-2-Clause) decides when you finished talking: it is asked after a 0.7 s pause, and only a clear "done" ends your turn. 2 s of silence always ends it (1.3 s without the model). A breath in the middle of a sentence lasts up to about 1 s, so it does not cut you off. If you go on talking before Ceci starts answering, both parts are joined into one request.

### How fast it is

Measured on an RTX 3060 Ti, gpu profile:
- first audio of a reply: 0.74 to 0.94 s;
- transcription: about 0.25 s;
- end of turn: about 0.18 s;
- "sim" after "posso?" until "Comecei": about 0.7 s.

The voice was chosen by the owner, listening:
- An earlier voice, designed with Qwen3-TTS VoiceDesign, scored well with automatic judges, but the owner heard a European Portuguese accent in it. The accent classifier used then also called some real Brazilian recordings European, so it was dropped as a judge.
- Ceci now clones a real Brazilian speaker: a clip from the CML-TTS Portuguese dataset (see Credits).
- The clip was made brighter (a little higher, more pitch movement, 8% faster), because the plain reading sounded sleepy.
- The owner compared candidates by ear and picked this one.

On 40 pt-BR sentences through the production path:
- no sentence failed or looped;
- word errors were 8% (Whisper large-v3-turbo), mostly English tech words ("branch", "main") and numbers written as digits.

Questions end with a Brazilian rise: the window raises the pitch of the last half second of a question after it is made, keeping its length (`window/engines/question-rise.js`). On 20 questions the end now rises +3.4 semitones (was +2.0, like a statement), and Whisper hears 9 of 20 as questions (was 6). The owner picked this by ear among three versions. `?voice-question=0` turns it off.

### Switching the voice

Pick it in any of these ways; the newest choice wins:
- `/luke-voice voz local` or `/luke-voice voz elevenlabs` in Claude Code (takes effect on the next call);
- the installer;
- `/plugin configure luke-voice@luke-voice`, option **voice_provider**.

With no choice at all, luke-voice uses ElevenLabs while a key is saved, and the free voice otherwise.

### What leaves your computer

- **While it is off:** nothing.
- **Free voice:** the audio never leaves your computer. Only the text of what you said, a short summary of what happens in the session, and finished task results go to Claude Haiku on your Claude account, which decides what Ceci says. The model files are downloaded once (from Hugging Face and GitHub): at install or setup, or on the first call if neither ran. After that, nothing is downloaded.
- **ElevenLabs voice:** your voice and what happens in the session (your prompts and Claude's tool calls) go to your agent at ElevenLabs.

## If something does not work

| What you see | What to do |
| --- | --- |
| You hear nothing | Check that your computer's sound is on and that the window says **Em chamada**. |
| The voice was not downloaded at install | Run `/luke-voice setup`. Or start a call: the first call downloads it, with the progress in the window. |
| Ceci uses the light voice on a computer with a graphics card | The GPU has less than 6 GB of video memory, or setup's test failed. `/luke-voice status` shows the profile. `/luke-voice setup` tries again. |
| Ceci takes a few seconds to answer | Requests that go to Claude Haiku take about 1 to 3 seconds. On the gpu profile, small talk is instant. On the light profile, a computer without a graphics card also takes 1 to 2 seconds longer to listen and speak. |
| The free voice sounds more robotic | On a slow computer, the light profile switches to Piper, a lighter voice, so she does not stutter. **Settings** in the window shows which voice model speaks. |
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

Or export `ELEVENLABS_API_KEY` and `LUKE_VOICE_PROVIDER` before you start Claude Code. Then restart Claude Code and run `/luke-voice setup` to download the free voice.

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
   light (browser): mic → VAD → Whisper → POST /brain → mod → Haiku            WebRTC ── ElevenLabs agent
                    Kokoro (or Piper) ← what Ceci says ←─────┘
   gpu (native):    mic → Silero VAD + Smart Turn → hub /stt, /tts, /route → llama-server (127.0.0.1)
                    Qwen3-ASR (ears), Qwen3-TTS (voice), Qwen3.5 0.8B (router) → POST /brain for requests
```

- `hooks/register.tsx` is the mod. It reports activity, pulls commands from the hub and runs them in its own session. For the free voice it also runs the brain: Claude Haiku 5.5 called directly through the mod engine's `$.model.complete` at effort low with the prompt cached (a `claude -p` call, with no tools, no MCP servers, no settings and no saved session, remains only as a fallback).
- `hub/launch.mjs` starts the hub detached when it is down. The hub exits after ten idle minutes. `LUKE_VOICE_PORT` moves it (and the mod follows).
- `hub/agent.mjs` creates or updates the ElevenLabs agent from `agent/agent.json` and `agent/prompt.md` (plain REST, no packages). Change those files and the next ElevenLabs call syncs the agent. The free voice's brain reads `agent/brain-prompt.md`.
- Models and engine, for the free voice:
  - `hub/models.mjs` is the manifest of every model file, pinned by Hugging Face revision and sha256 (the converted Qwen3-TTS projector `qwen3-tts-0.6b-base-mmproj-icl-q8_0.gguf` comes from this repo's GitHub prerelease `voice-models-v1`).
  - `hub/engine.mjs` holds the llama.cpp build manifest and starts the `llama-server` processes.
  - `hub/setup.mjs` is the setup CLI the installers and `/luke-voice setup` run.
  - `hub/router.mjs` is the instant local router for small talk.
  - The hub serves all model files from `~/.luke-voice/models`. The call window downloads nothing from Hugging Face.
- `window/` is the call window. `window/engines/elevenlabs.js` drives the ElevenLabs client. `window/engines/local.js` drives the free voice, on the native engine when it runs and in the browser otherwise:
  - **Listening:** Silero VAD and Pipecat Smart Turn find the end of the turn. Then Qwen3-ASR (native) or Whisper base in `voice-worker.js` (browser) transcribes.
  - **Speaking:** Qwen3-TTS (native), or Kokoro-82M with pt-BR phonemes from espeak-ng (browser). Piper `pt_BR-faber` is the fallback on slow computers.
  - **Speech text:** `speech-text.js` strips markdown and code and respells English tech words.
- `hub/vendor.mjs` lists the third-party browser code for the light voice (transformers.js, onnxruntime-web, espeak-ng): each file is pinned by version and sha384, downloaded once by the hub and served from `/vendor/`.

## Security

- The hub listens on 127.0.0.1 only and refuses any other `Host` or `Origin`.
- The ElevenLabs key stays in the hub process. The window gets a short-lived conversation token per call.
- Three secrets:
  - the service token in `~/.luke-voice/hub.json` (mode 600) lets a mod subscribe;
  - each subscription gets its own session token for its inbox;
  - the window key (in the window URL) can send commands but cannot read an inbox. The hub's `/stt`, `/tts` and `/route` also need the window key.
- The agent requires signed tokens, so its id alone cannot start a call.
- Prompts reach Claude framed as relayed by luke-voice, and the pane lists each one.
- The call window loads the ElevenLabs client from a pinned CDN file checked with Subresource Integrity.
- The llama.cpp binaries are official GitHub release assets, pinned by sha256.
- Every model file is pinned by revision and sha256 and checked before use.
- The native servers listen only on 127.0.0.1, on random ports.
- The light voice's code is checked by sha384 before the hub serves it.
- Session activity and task results reach either brain only as marked untrusted context, never as the user's words.
- The tools that act on the computer are refused until the user speaks after an automatic update.
- The window is cross-origin isolated (COOP and COEP), which the light voice needs to run on several CPU threads.

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
| `&voice-native=0` | Force the browser (light) voice even when the native engine runs |
| `&voice-debug=1` | Log the microphone levels |
| `&voice-device=wasm` | Run Kokoro on the CPU even with a graphics card |
| `&voice-tts=piper` or `kokoro` | Force the voice model |
| `&voice-dtype=`, `&voice-stt-dtype=`, `&voice-stt-device=`, `&voice-threads=` | Model precision, Whisper device, CPU threads |

Environment variables: `LUKE_VOICE_PROFILE=gpu|light` forces the profile, and `LUKE_VOICE_ENGINE=off` keeps the hub from starting the native engine.

The window console logs one `[luke-voice]` line per step with its time.

## License

MIT. Written from scratch; it shares no code with other voice mods.

The free voice downloads third-party parts at install time; none of them is in this repository:
- llama.cpp: MIT.
- Qwen3-TTS 0.6B Base, Qwen3-ASR 0.6B and Qwen3.5 0.8B: Apache-2.0.
- Pipecat Smart Turn v3.2: BSD-2-Clause.
- Silero VAD: MIT.
- Kokoro-82M: Apache-2.0.
- Whisper: MIT.
- transformers.js and onnxruntime-web: Apache-2.0 and MIT.
- The Piper voice: see its model card.
- espeak-ng (through espeak-phonemizer): GPL-3.0.

Ceci's reference voice clip `agent/ceci-voice.wav` comes from CML-TTS (Oliveira et al., 2023), Portuguese, speaker 3050, licensed CC-BY-4.0; the recording is a LibriVox public-domain reading. It was changed for this project: trimmed, raised one semitone, with more pitch movement and 8% faster.
