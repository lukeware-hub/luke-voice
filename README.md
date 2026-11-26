# luke-voice

**Leia em português: [README.pt-BR.md](README.pt-BR.md)**

Ceci, a voice assistant beside your Claude Code session, in Brazilian Portuguese. You say what you want, she repeats it and asks "posso?", and after your "sim" a Claude Code subagent does the task on your computer. When it finishes, she tells you the result out loud, without waiting for you to speak: if no call is running she starts one, and a result that comes while the window is closed is kept until she has told it.

Ceci has two voices:

| | Free voice (default) | ElevenLabs voice (optional) |
| --- | --- | --- |
| Cost | Free. It uses your Claude account for the short replies. | Paid per use (the free plan gives about 15 minutes a month). |
| Where it runs | On your computer. Models run locally (natural voice on a computer with a good graphics card, light voice on any other). | In an ElevenLabs agent, over the internet. |
| What you need | Nothing extra. The installer downloads the voice once: about 3.3 GB (natural voice) or about 360 MB (light voice). | An ElevenLabs key. |
| Sound | Natural voice: cloned from a reference clip, in Brazilian Portuguese. Light voice: good, a little synthetic. | The most natural. |

> Not affiliated with ElevenLabs. The ElevenLabs voice calls the public ElevenLabs API with your own key.

### The two profiles of the free voice

luke-voice picks the profile by itself at install time:

| | gpu profile ("natural voice") | light profile ("light voice") |
| --- | --- | --- |
| When | llama.cpp sees a GPU with at least 6 GB of video memory (NVIDIA, AMD or Intel through Vulkan on Windows and Linux; Apple Silicon through Metal on macOS arm64). From 3.8 GB (a 4 GB card, a Mac with 8 GB) it is still Ceci's original voice, with her ears on the CPU: about half a second more to hear each turn. | Everything else. |
| Speaks | Qwen3-TTS 12Hz 1.7B Base, cloned at run time from `agent/ceci-voice.wav` and its transcript `agent/ceci-voice.txt`. | Kokoro-82M in the browser. Piper `pt_BR-faber` is the fallback on slow computers. |
| Listens | Qwen3-ASR 0.6B (Q6). | Whisper base in the browser. |
| Small talk | An instant local router, Qwen3.5 0.8B on the CPU. | Goes to Claude Sonnet like everything else. |
| Download | About 3.3 GB, once (3.24 GB of models and the 39 MB llama.cpp engine). No Python, no PyTorch. | About 360 MB, once (about 520 MB on a machine with a small GPU, where Kokoro runs in fp32 on WebGPU). |
| Video memory in a call | About 5.4 GB for the voice and the ears together, and about 3.2 GB of RAM for the whole engine (measured on an RTX 3060 Ti). | None beyond the browser's. |

On the gpu profile, the hub downloads llama.cpp's official release build b12556 (pinned by sha256, about 39 MB) and runs three local `llama-server` processes: Ceci's voice, her ears and the router.

`LUKE_VOICE_PROFILE=gpu` or `light` forces a profile: an installer environment variable, or for the hub (it prepares that profile on its next start).

## Requirements

- **Claude Code**, installed and signed in with a Claude account (the only thing you install yourself). Current version of luke-voice: v0.17.0.
- **Windows, macOS or Linux.** On a Mac with Apple silicon you get the natural voice; an Intel Mac gets the light voice.
- **Node.js 20 or newer and Git** (Windows) are brought by the installer when missing, for your user only.
- **Disk space:** about 3.3 GB for the natural voice, about 360 MB for the light voice (the installer checks first).
- **A microphone and speakers.** Google Chrome is best for the call window; Chromium and Edge also work.
- **Internet** during install, and for the short replies (Claude). The ElevenLabs voice also needs an ElevenLabs key (optional).

## Install in 3 steps

Each step says how to know it worked. Do them in order.

**Or let Claude Code do it:** with step 1 done, send Claude Code this message: *"Instale o luke-voice seguindo https://github.com/lukeware-hub/luke-voice/blob/main/INSTALL.md"*. [INSTALL.md](INSTALL.md) has a section for AI agents with the exact commands.

### 1. Have Claude Code working

Install it from [claude.com/claude-code](https://claude.com/claude-code), open it, and sign in once.
**Done when:** you can type a message in Claude Code and get an answer.

Nothing else is needed first. The installer brings Node.js and Git when they are missing (only for you: no administrator, no password). Google Chrome is best for the call window, which opens in a profile of its own; any browser with a microphone works too, but then you may have to allow the microphone by hand.

### 2. Run the installer

- **Windows:** press **Windows + R**, paste this line and press **Enter**:

  ```
  powershell -NoProfile -ExecutionPolicy Bypass -c "irm https://raw.githubusercontent.com/lukeware-hub/luke-voice/main/install/install-luke-voice-windows.cmd | iex"
  ```

  The same line works typed in PowerShell or in a Command Prompt. Started from Windows + R, the window waits for Enter before it closes. Or download [install-luke-voice-windows.cmd](https://raw.githubusercontent.com/lukeware-hub/luke-voice/main/install/install-luke-voice-windows.cmd) and double-click it. If Windows says "Windows protected your PC", click **More info** and then **Run anyway**.
- **macOS / Linux:** paste this in the Terminal:

  ```bash
  curl -fsSL https://raw.githubusercontent.com/lukeware-hub/luke-voice/main/install/install.sh | bash
  ```

  Without curl: `wget -qO- https://raw.githubusercontent.com/lukeware-hub/luke-voice/main/install/install.sh | bash`.

The installer speaks Brazilian Portuguese. When it asks **Qual voz a Ceci deve usar?** (which voice should Ceci use):
- Press **Enter** for the free voice. Nothing else is needed.
- Or type **e** for ElevenLabs. It then asks for the **Chave** (key). To get one:
  1. Create an account at [elevenlabs.io](https://elevenlabs.io).
  2. Open [elevenlabs.io/app/settings/api-keys](https://elevenlabs.io/app/settings/api-keys) and click **Create API key**. If it asks which permissions, keep **Agents** and **Voices** allowed.
  3. Paste the key and press Enter. It stays hidden.

The installer has 6 steps:
1. Finds Claude Code.
2. Gets Node.js and Git ready. A missing one is downloaded from its official site, checked by sha256 and kept in `~/.luke-voice` for you alone: Node.js 24 LTS (about 30 MB), and on Windows MinGit, Git for Windows' portable build (about 40 MB). A Node.js older than 20, or one that cannot download through your proxy, counts as missing: luke-voice gets its own and leaves yours as it is. Without git on macOS or Linux, luke-voice is downloaded as an archive instead.
3. Installs the luke-voice mod into Claude Code.
4. Asks for the voice.
5. Checks the mod is installed and turned on.
6. **Baixando a voz da Ceci (até 3,3 GB, só uma vez)** (downloading Ceci's voice) runs `node hub/setup.mjs`. It picks the profile, checks the disk has room (what is left to download plus 10%; otherwise it stops with **Falta espaço**), downloads everything and checks each file by sha256. Downloads can resume if they are cut. On the gpu profile it also runs a short test: Ceci says a line, her ears write it back, and the router answers a greeting. If the test fails, setup downloads the light voice too (320 to 480 MB) and calls use it until `/luke-voice setup` passes the test.

**Done when:** it ends with the green message **Instalação concluída: luke-voice <versão>** (installation complete). If it stops with **A instalação parou**, read the **O que fazer** (what to do) line, fix that one thing and run it again. Running it again is always safe.

To install without questions, set `LUKE_VOICE_NO_PROMPT=1` before you run it; add `LUKE_VOICE_PROVIDER=local` (or `elevenlabs`) to choose the voice, and `LUKE_VOICE_PROFILE=gpu` or `light` to force the profile. `LUKE_VOICE_REF=<branch or tag>` installs that version instead of `main`, to test a change.

### 3. Open Claude Code

1. **Close Claude Code completely and open it again.** If the installer just installed Node.js or Git, open it from a new terminal window. `/reload-plugins` is not enough to load a new install or update.
2. The first time, luke-voice turns on by itself, the call window opens and Ceci greets you. Just talk.
   - **Free voice:** the installer already downloaded it. If you updated through the marketplace and nothing was downloaded yet, the first call prepares it, with the progress in the window (or run `/luke-voice setup`).
   - **ElevenLabs:** luke-voice creates an agent named `luke-voice` and adds the voice "Roberta" to your account.
3. From then on: **✦ luke-voice: on/off** above the prompt turns it on and off, and `/luke-voice call` starts a call.

**On a Mac:** the first call asks whether Chrome may use the microphone: click **Allow**. A Mac with Apple silicon gets the natural voice; an Intel Mac gets the light voice.

**Done when:** you hear Ceci greet you, for example "Bom dia! Eu sou a Ceci. O que vamos fazer hoje?" ("bom dia", "boa tarde" or "boa noite" by the clock, and the words change each call). If anything is missing, type `/luke-voice help`: it checks your setup and says what to fix.

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
| `/luke-voice uninstall` | remove luke-voice and the downloaded voice (asks for `/luke-voice uninstall confirmar` first) |

It starts **off**, and remembers your choice. When Claude Code opens with it already on, it only reconnects: it never starts a call you did not ask for.

`/luke-voice setup` does the same as installer step 6, from Claude Code. With luke-voice on, the hub prepares the voice in the background and `/luke-voice status` shows the progress. With it off, setup runs directly (up to 10 minutes per run; a cut download resumes on the next run).

### A faster brain

The brain (Ceci, Luke or Nara) is Claude Sonnet 5.5, called directly through the mod engine's `$.model.complete` at medium effort, with the prompt cached. The `claude -p` call remains only as a fallback. Measured brain turns take about 2 to 3 s (Claude Haiku 5.5 at low effort, the brain up to 0.10.9, took about 1.2 to 2.1 s).

Some things need no model call at all:
- "pare" or "para" stops Claude, with or without her name and as many times as you say it ("Para, Ceci, para!", "chega, Ceci").
- When Ceci asks "posso?", a plain "sim" runs the pending action at once, and a plain "não" cancels it.
- When the brain takes more than 600 ms, Ceci says a short acknowledgement: a quick "Entendi." after a short sentence, and a listening line such as "Deixa eu entender o que você está falando." after a long one, never the same twice in a row (`window/engines/acks.js`). They are made once per window, only while nobody is talking, so they never delay her first answer.
- On the gpu profile, a local router answers small talk (greetings, thanks, goodbyes, "who are you", her age, who created her) in about 0.3 s, with lines written in `hub/router.mjs`, so it never invents anything. Anything else, and any request, goes to Claude Sonnet. A word check on top of the small model makes sure a request is never answered locally (0 of 49 test requests were).

### Knowing when you finished talking

Silero VAD (MIT) drops sounds without speech. Pipecat Smart Turn v3.2 (BSD-2-Clause) decides when you finished talking: it is asked after a 0.4 s pause and again every 0.2 s while the pause goes on, and a "done" ends your turn there. 1.1 s of silence always ends it (1.3 s without the model). If a breath in the middle of a sentence ends your turn and you go on talking before Ceci starts answering, both parts are joined into one request. While Ceci speaks, a sound that may be you talking over her lowers her voice; she stops once your words are heard, and goes on at full volume if it was only her own echo. A noise that starts and stays (a TV, an air conditioner) is learned as the room in about 10 s, so your turns still end on time.

### How fast it is

Measured on an RTX 3060 Ti, gpu profile:
- first audio of a reply: 0.74 to 0.94 s;
- transcription: about 0.25 s;
- end of turn: about 0.18 s;
- "sim" after "posso?" until "Comecei": about 0.7 s.

Ceci says a reply phrase by phrase, cut at each comma. She starts as soon as her first sentence is ready, and the next sentence is made while she says it; she no longer waits until the audio ready covers the whole reply, which took up to 17 s on a long reply. The voice's own silence around each phrase is cut, and the window puts a steady pause after it: 0.15 s after a comma, 0.3 s after a sentence end (. ! ?) and 0.4 s after "…". The voice's own silence at a sentence end was 0.42 s on average and up to about 1 s.

The voice was chosen by the owner, listening:
- An earlier voice, designed with Qwen3-TTS VoiceDesign, scored well with automatic judges, but the owner heard a European Portuguese accent in it. The accent classifier used then also called some real Brazilian recordings European, so it was dropped as a judge.
- Ceci now clones a real Brazilian speaker: a clip from the CML-TTS Portuguese dataset (see Credits).
- The clip was made brighter (a little higher, more pitch movement, 8% faster), because the plain reading sounded sleepy.
- The owner compared candidates by ear and picked this one.

Since 0.10.0 the voice is the 1.7B model, which the owner heard as clearly better than the 0.6B. On 40 pt-BR sentences through the production path:
- no sentence failed or looped (none in 100 more takes over 5 seeds either);
- word errors were 8.9% (the production ears), mostly English tech words ("branch", "main") and numbers written as digits.

She sounded robotic at first, because her pitch barely moved. An automatic panel (pitch spread and synthetic-speech detectors, anchored on real pt-BR recordings = 10 and Kokoro = 3) rated her pitch spread 2.9 of 10. Sampling at temperature 0.9 instead of 0.75 gives her melody back (6.2 of 10; the panel's score went from 7.6 to 8.8), and the owner's rating went from 6 to 8.5.

English tech words: the voice speaks Portuguese, so it reads some of them with Portuguese rules ("changelog" as "chão geloso", "cache" as "caixa"). `speech-text.js` gives it its own spelling for 11 of them. 34 words got several spellings each, said in three sentences and judged by the ears, then checked on four new sentences. A spelling is kept only when it brought the English word back at least twice more over the seven sentences. Over 5 seeds on 10 sentences, the ears heard 79 of 125 English terms right with the spellings, against 63 without. No spelling helped "main", "README", "branch", "commit", "push" or "lint", so they stay as written. In 0.17.3, 60 words were checked again the same way: release, front-end, checkout, pipeline, workflow and payload got a spelling, and token and rebase went back to plain, where they did better. "Bom dia!" is sent as "Bom dia!!", because with one mark she said "bem dia" on 3 of 4 seeds and with two she said it right on 10 of 10.

Numbers and text: `speech-text.js` cuts sentences only at a period followed by a space, never inside "5.5", "1.500", "app.js" or after "Sr.". It writes out what the voice misread, each change checked by her ears against the old text: money ("R$ 1.500,00" as "mil e quinhentos reais"), the feminine of hours ("21h" as "vinte e uma horas"), durations ("1h30" as "uma hora e 30 minutos"), dates ("22/11/2026" as "22 de novembro de 2026"), versions ("Opus 5.5" as "5 ponto 5"), "Prof." and "p.ex.", and "2 * 3" as "2 vezes 3". It drops emoji and reads "site.com.br" as "site ponto com ponto bê erre". Plain numbers stay as digits, which she reads well. Everyday sentences are cut and spelled exactly as before (a test checks 52 of them on both voices).

Questions: a Brazilian yes/no question rises at the end, and one with a question word ("o que", "quando") falls, like a statement. The voice usually ends both flat. Raising the pitch after synthesis (0.9.3 to 0.9.9) sounded robotic to the owner. About 1 in 4 takes of the model itself ends with a natural rise, and the owner rated the best of 4 takes 8.5 of 10. A take costs about 1 s and the engine makes one at a time, so the hub (`hub/question-pick.mjs`) only makes more takes in time nobody waits for:
- while the line before the question still plays (the window says how long);
- in the background when the engine is idle, starting with the questions Ceci asks most. Any live line stops it at once.

The best take of each question is kept on disk (`~/.luke-voice/cache/questions`) and served at once next time. On 7 questions, none waited longer than before. 2 of 7 rose naturally the first time, and 7 of 7 after a minute idle. `?voice-question=0` turns it off.

### Switching the voice

Pick it in any of these ways; the newest choice wins:
- `/luke-voice voz local` or `/luke-voice voz elevenlabs` in Claude Code (takes effect on the next call);
- the installer;
- `/plugin configure luke-voice@luke-voice`, option **voice_provider**.

With no choice at all, luke-voice uses ElevenLabs while a key is saved, and the free voice otherwise.

### Ceci's memory

Ceci never forgets a conversation. Every call is recorded whole in one memory per computer, shared by every Claude Code session: what you said, what she said, the tasks and their results, and what the sessions did. It lives in `~/.ceci/memory.db` (a SQLite file, outside luke-voice's folder), is created by itself the first time luke-voice starts, and nothing in it is ever removed on its own.

- **Remembering:** on every turn Ceci reads a summary of everything since the first conversation, the latest conversations and what matches what you just said. Ask her "lembra da primeira conversa?" or "o que a gente falou semana passada?" and she searches the memory.
- **Reviewing:** the **Memória** tab in the call window lists every conversation by day, with a search; in Claude Code, `/luke-voice memoria` and `/luke-voice memoria buscar <texto>`.
- **Deleting (the only way anything leaves):** ask Ceci ("apaga a conversa de ontem"; she asks "posso?" first), use the **Apagar** buttons in the Memória tab, or `/luke-voice memoria apagar <#conversa | AAAA-MM-DD | AAAA-MM | palavras | tudo>`. A delete also rewrites the summaries that mentioned it and compacts the file, so the words are gone from the disk. Uninstalling asks whether to delete the memory too.
- Summaries are written by Claude Haiku on your Claude account, while no call is live. Remembered lines go to the brain with each turn, like the conversation does.
- **Knowledge graph:** a minute after a call ends (with the summaries), the hub starts a [Graphify](https://github.com/Graphify-Labs/graphify) update in the background, at most once every 10 minutes and never during a call. It opens the memory read-only, writes one transcript per new or grown call to `~/.ceci/graph/corpus/` and runs `graphify extract` incrementally, so only those transcripts are read again; the graph lands in `~/.ceci/graph/graphify-out/` (`graph.json`, `GRAPH_REPORT.md`, `graph.html`), never in the database. A call you delete from the memory leaves the corpus on the next update. It needs `graphify` on the PATH (`pip install graphifyy`) and uses Claude Code on your account (Haiku) by default. Settings: `CECI_GRAPH=0` turns it off, `CECI_GRAPH_MODEL`, `CECI_GRAPH_BACKEND`, `CECI_GRAPHIFY` (the command), `CECI_GRAPH_HOME` (the folder). `node hub/graph.mjs` runs one update by hand; `~/.ceci/graph/graph.log` and `state.json` say how the last one went.

### What leaves your computer

- **While it is off:** nothing.
- **Free voice:** the audio never leaves your computer. Only the text of what you said, a short summary of what happens in the session, and finished task results go to Claude Sonnet on your Claude account, which decides what Ceci says. The model files are downloaded once (from Hugging Face and GitHub): at install or setup, or on the first call if neither ran. After that, nothing is downloaded.
- **ElevenLabs voice:** your voice and what happens in the session (your prompts and Claude's tool calls) go to your agent at ElevenLabs.

## If something does not work

| What you see | What to do |
| --- | --- |
| You hear nothing | Check that your computer's sound is on and that the window says **Em chamada**. |
| The voice was not downloaded at install | Run `/luke-voice setup`. Or start a call: the first call downloads it, with the progress in the window. |
| Ceci uses the light voice on a computer with a graphics card | The GPU has less than 3.8 GB of video memory, or setup's test failed. `/luke-voice status` shows the profile. `/luke-voice setup` tries again. |
| Ceci takes a few seconds to answer | Requests that go to Claude Sonnet take about 2 to 3 seconds. On the gpu profile, small talk is instant. On the light profile, a computer without a graphics card also takes 1 to 2 seconds longer to listen and speak. |
| The free voice sounds more robotic | On a slow computer, the light profile switches to Piper, a lighter voice, so she does not stutter. **Settings** in the window shows which voice model speaks. |
| The free voice sounds robotic on a Mac | When the natural voice is too slow for the Mac (as on an M1), the assistant speaks with the Mac's own voice: the Siri voice set as the system voice in Spoken Content, or else a pt-BR Premium or Enhanced voice. The installer asks for **Siri Voz 1** (System Settings > Accessibility > Spoken Content > System Voice); it downloads once, about 230 MB, and not over a phone's hotspot (macOS does not download voices on a network it marks as expensive). With Siri Voz 1 (male) the assistant is **Luke**, a 22-year-old man who speaks of himself in the masculine; with Siri Voz 2 (female) she is **Nara**, Ceci with another name. Another male Mac voice is Luke; any other voice is Ceci. The name follows the voice from the next call. Windows, Linux and ElevenLabs are always Ceci. `LUKE_VOICE_MAC_VOICE=off` turns this off, `LUKE_VOICE_MAC_VOICE=<identifier>` picks a voice. |
| "Falta a chave da ElevenLabs" or "Chave: faltando" | Save the key with `/plugin configure luke-voice@luke-voice` (or run the installer again) and restart Claude Code. Or use the free voice: `/luke-voice voz local`. |
| You changed the ElevenLabs key and nothing changed | The key is stored by Claude Code (in the Keychain on macOS). A key exported in `~/.zshrc` does not reach a Claude Code opened from the Dock. Save it with `/plugin configure` and restart Claude Code. |
| The microphone does not work | In the call window, allow the microphone, then tap **Chamar** again. |
| The window says **Hub offline** | Turn luke-voice on in Claude Code; the window reconnects by itself. |
| ElevenLabs: the call stopped connecting | Your free minutes for the month may be over. Check your usage at elevenlabs.io, or switch to the free voice. |
| The window still has the old look | Close Claude Code completely and open it again. |
| Installer: "o Claude Code não foi encontrado" | Do step 1, then run the installer again. If you just installed Claude Code, close and open the terminal first. |
| Installer: "sem conexão com a internet, ou a rede (um proxy de empresa) bloqueou o download" | Check the internet. Behind a company proxy, set `HTTPS_PROXY=http://address:port` and run the installer again (on Windows it also uses the proxy set in Windows). |
| Installer: "Falta espaço: a voz precisa de X GB livres" | Free that much space on the disk it names and run the installer again; the download resumes. |
| "Node.js não encontrado" | Close and open the terminal (or Claude Code) again. If it repeats, run the installer again. |
| "Não consegui abrir a janela da chamada" | No Chrome, Chromium or Edge was found. Open the address the message shows in a browser, or install Google Chrome. |
| Anything else | Type `/luke-voice status` and send the result to whoever maintains luke-voice. |

## Uninstall

One line removes everything: luke-voice from Claude Code, the downloaded voice, and the Node.js and Git the installer brought (and takes them off the PATH). It asks before it starts, and asks you to close Claude Code first (while it is open, luke-voice would start again); nothing else on the computer changes. Ceci's memory (`~/.ceci`) is kept unless you say to delete it too: the uninstaller asks, and from Claude Code you pick `/luke-voice uninstall confirmar manter-memoria` or `/luke-voice uninstall confirmar apagar-memoria`.

From inside Claude Code (macOS or Linux): type `/luke-voice uninstall`. It says what will be removed and asks for `/luke-voice uninstall confirmar`; then it ends the call, turns luke-voice off and runs the uninstaller below in the background. Close Claude Code and open it again when it says so. On Windows it gives you the line below.

- **Windows:** press **Windows + R**, paste this line and press **Enter**:

  ```
  powershell -NoProfile -ExecutionPolicy Bypass -c "irm https://raw.githubusercontent.com/lukeware-hub/luke-voice/main/install/uninstall-luke-voice-windows.cmd | iex"
  ```

- **macOS / Linux:** paste this in the Terminal:

  ```bash
  curl -fsSL https://raw.githubusercontent.com/lukeware-hub/luke-voice/main/install/uninstall.sh | bash
  ```

  Without curl: `wget -qO- https://raw.githubusercontent.com/lukeware-hub/luke-voice/main/install/uninstall.sh | bash`.

To remove only the mod and keep the voice, see [Plugin commands](#plugin-commands-claude-code).

## Plugin commands (Claude Code)

luke-voice is a Claude Code plugin named `luke-voice@luke-voice`. The installer runs these for you; run them yourself in a terminal to install, update or remove it by hand. Restart Claude Code after each one: `/reload-plugins` is not enough.

| Task | Command |
| --- | --- |
| Add the marketplace | `claude plugin marketplace add lukeware-hub/luke-voice` |
| Install | `claude plugin install luke-voice@luke-voice` |
| Check it is installed and enabled | `claude plugin list --json` |
| Update (refresh the marketplace first) | `claude plugin marketplace update luke-voice` then `claude plugin update luke-voice@luke-voice` |
| Turn off or on | `claude plugin disable luke-voice@luke-voice` or `claude plugin enable luke-voice@luke-voice` |
| Remove the plugin only | `claude plugin uninstall luke-voice@luke-voice` |
| Remove the marketplace too | `claude plugin marketplace remove luke-voice` |
| Choose the free voice | `printf '{"voice_provider":"local"}' \| claude plugin configure luke-voice@luke-voice --values-stdin` |
| Choose ElevenLabs | `printf '{"voice_provider":"elevenlabs","api_key":"%s"}' "$ELEVENLABS_API_KEY" \| claude plugin configure luke-voice@luke-voice --values-stdin` |

Inside Claude Code, `/plugin` opens the same menu (choose **luke-voice**, then update or **Uninstall**), and `/plugin configure luke-voice@luke-voice` saves the options. After a manual install or update, run `/luke-voice setup` to download the free voice. `claude plugin uninstall` keeps the downloaded voice; the uninstall lines above remove everything.

You can also export `ELEVENLABS_API_KEY` and `LUKE_VOICE_PROVIDER` before you start Claude Code.

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
   light (browser): mic → VAD → Whisper → POST /brain → mod → Sonnet           WebRTC ── ElevenLabs agent
                    Kokoro (or Piper) ← what Ceci says ←─────┘
   gpu (native):    mic → Silero VAD + Smart Turn → hub /stt, /tts, /route → llama-server (127.0.0.1)
                    Qwen3-ASR (ears), Qwen3-TTS (voice), Qwen3.5 0.8B (router) → POST /brain for requests
```

- `hooks/register.tsx` is the mod. It reports activity, pulls commands from the hub and runs them in its own session. For the free voice it also runs the brain: Claude Sonnet 5.5 called directly through the mod engine's `$.model.complete` at medium effort with the prompt cached (a `claude -p` call, with no tools, no MCP servers, no settings and no saved session, remains only as a fallback).
- `hub/launch.mjs` starts the hub detached when it is down. The hub exits after ten idle minutes. `LUKE_VOICE_PORT` moves it (and the mod follows).
- `hub/agent.mjs` creates or updates the ElevenLabs agent from `agent/agent.json` and `agent/prompt.md` (plain REST, no packages). Change those files and the next ElevenLabs call syncs the agent. The free voice's brain reads `agent/brain-prompt.md`.
- Models and engine, for the free voice:
  - `hub/models.mjs` is the manifest of every model file, pinned by Hugging Face revision and sha256 (the converted Qwen3-TTS 1.7B voice and projector, and the Q6 Qwen3-ASR, come from this repo's GitHub prerelease `voice-models-v2`).
  - `hub/engine.mjs` holds the llama.cpp build manifest and starts the `llama-server` processes.
  - `hub/setup.mjs` is the setup CLI the installers and `/luke-voice setup` run.
  - `hub/router.mjs` is the instant local router for small talk.
  - The hub serves all model files from `~/.luke-voice/models`. The call window downloads nothing from Hugging Face.
- `window/` is the call window. `window/engines/elevenlabs.js` drives the ElevenLabs client. `window/engines/local.js` drives the free voice, on the native engine when it runs and in the browser otherwise:
  - **Listening:** Silero VAD and Pipecat Smart Turn find the end of the turn. Then Qwen3-ASR (native) or Whisper base in `voice-worker.js` (browser) transcribes.
  - **Speaking:** Qwen3-TTS (native), or Kokoro-82M with pt-BR phonemes from espeak-ng (browser). Piper `pt_BR-faber` is the fallback on slow computers.
  - **Speech text:** `speech-text.js` strips markdown and code, respells English tech words, and writes out money, hours, dates and versions the way a Brazilian says them.
- `hub/vendor.mjs` lists the third-party browser code for the light voice (transformers.js, onnxruntime-web, espeak-ng): each file is pinned by version and sha384, downloaded once by the hub and served from `/vendor/`.

## Security

- The hub listens on 127.0.0.1 only and refuses any other `Host` or `Origin`.
- The ElevenLabs key stays in the hub process. The window gets a short-lived conversation token per call.
- Three secrets:
  - the service token in `~/.luke-voice/hub.json` (mode 600) lets a mod subscribe;
  - each subscription gets its own session token for its inbox;
  - the window key can send commands but cannot read an inbox. The hub's `/stt`, `/tts` and `/route` also need the window key.
- The window key never goes on a command line, where other users of the computer could read it. The hub opens the window with a one-time launch code that expires in two minutes (fifteen when the user has to open the address by hand). The window trades it once for the key, keeps the key in its tab's sessionStorage so a reload still works, and removes the code from the address bar.
- The model and vendor files (`/models/`, `/vendor/`) start large downloads, so they are served only to the window: a same-origin `Sec-Fetch-Site`, or, from a browser that does not send it, the window's own address as `Origin` or `Referer`, or the window key.
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
- Qwen3-TTS 1.7B Base, Qwen3-ASR 0.6B and Qwen3.5 0.8B: Apache-2.0.
- Pipecat Smart Turn v3.2: BSD-2-Clause.
- Silero VAD: MIT.
- Kokoro-82M: Apache-2.0.
- Whisper: MIT.
- transformers.js and onnxruntime-web: Apache-2.0 and MIT.
- The Piper voice: see its model card.
- espeak-ng (through espeak-phonemizer): GPL-3.0.

Ceci's reference voice clip `agent/ceci-voice.wav` comes from CML-TTS (Oliveira et al., 2023), Portuguese, speaker 3050, licensed CC-BY-4.0; the recording is a LibriVox public-domain reading. It was changed for this project: trimmed, raised one semitone, with more pitch movement and 8% faster.
