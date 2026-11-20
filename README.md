# luke-voice

**Leia em português: [README.pt-BR.md](README.pt-BR.md)**

Ceci, a voice assistant beside your Claude Code session, in Brazilian Portuguese. You say what you want, she repeats it and asks "posso?", and after your "sim" a Claude Code subagent does the task on your computer. When it finishes, she tells you the result out loud.

> Not affiliated with ElevenLabs. luke-voice calls the public ElevenLabs API with your own key.

## Install in 6 steps

Each step says how to know it worked. Do them in order.

### 1. Have Claude Code working

Install it from [claude.com/claude-code](https://claude.com/claude-code), open it, and sign in once.
**Done when:** you can type a message in Claude Code and get an answer.

### 2. Install Node.js 20 or newer

Download the **LTS** version from [nodejs.org](https://nodejs.org) and install it with the default options. luke-voice uses it to run a small local server.
**Done when:** `node -v` in a terminal prints `v20` or higher.

### 3. Have Google Chrome

The call window opens in Chrome, in a profile of its own, so your normal Chrome does not change. Any browser with a microphone works if Chrome is missing, but then you may have to allow the microphone by hand.

### 4. Get an ElevenLabs key

1. Create a free account at [elevenlabs.io](https://elevenlabs.io).
2. Open [elevenlabs.io/app/settings/api-keys](https://elevenlabs.io/app/settings/api-keys) and click **Create API key**. If it asks which permissions, keep **Agents** and **Voices** allowed (the simplest is a key with no limits).
3. Copy the key. It is shown only once.

The free plan gives about **15 minutes of calls per month**. Calls are billed to your account.

### 5. Run the installer

- **Windows:** download [install-luke-voice-windows.cmd](https://github.com/lukeware-hub/luke-voice/releases/latest/download/install-luke-voice-windows.cmd) and double-click it. If Windows says "Windows protected your PC", click **More info** and then **Run anyway**.
- **macOS / Linux:** paste this in the Terminal:

  ```bash
  curl -fsSL https://raw.githubusercontent.com/lukeware-hub/luke-voice/main/install/install.sh | bash
  ```

When it asks for the **Key**, paste the key from step 4 and press Enter (it stays hidden).
**Done when:** it ends with the green message **Installation complete**. If it stops, read the **What to do** line, fix that one thing and run it again.

### 6. Restart Claude Code, then turn it on

1. **Close Claude Code completely and open it again.** `/reload-plugins` is not enough to load a new install or update.
2. Above the prompt you see **✦ luke-voice: off**. Click it. It turns **on**, a window opens and the call starts by itself.
3. The first call takes a few seconds more: luke-voice creates an agent named `luke-voice` and adds the voice "Roberta" to your ElevenLabs account.

**Done when:** you hear "Oi! Estou aqui. O que vamos fazer?". If anything is missing, type `/luke-voice help`: it checks your setup and says what to fix.

## Use

Speak normally, in Portuguese. Example: *"Verifica no repositório luke-voice onde o botão de ligar é desenhado."* She repeats it and asks "posso?". Say "sim". The request shows in **Histórico** in the window, and she tells you the answer when the subagent finishes. The main chat stays free.

| | |
| --- | --- |
| the **✦ luke-voice** button | turn it on (opens the window and starts the call) or off |
| `/luke-voice` | the same as the button |
| `/luke-voice call` | open the window and start the call |
| `/luke-voice end` | hang up |
| `/luke-voice window` | bring the window to the front |
| `/luke-voice status` | technical status: hub, call, key, queue |
| `/luke-voice help` | everything you need to know, plus a check of what is missing |

It starts **off**, and remembers your choice. When Claude Code opens with it already on, it only reconnects: it never starts a call you did not ask for. **While it is on**, what happens in the session (your prompts and Claude's tool calls) is sent to your agent at ElevenLabs. **While it is off**, nothing leaves your computer.

## If something does not work

| What you see | What to do |
| --- | --- |
| You hear nothing | Check that Windows sound is on and that the window says **Em chamada**. |
| "No ElevenLabs API key" or "Chave: faltando" | Save the key with `/plugin configure luke-voice@luke-voice` (or run the installer again), then restart Claude Code. |
| The window says **Hub offline** | Turn luke-voice on in Claude Code; the window reconnects by itself. |
| The call stopped connecting | Your free minutes for the month may be over. Check your usage at elevenlabs.io. |
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
printf '{"api_key":"%s"}' "$ELEVENLABS_API_KEY" | claude plugin configure luke-voice@luke-voice --values-stdin
```

Or export `ELEVENLABS_API_KEY` before you start Claude Code. Then restart Claude Code.

</details>

## How it works

```
Claude session ── luke-voice mod ── events, long-poll ──┐
Claude session ── luke-voice mod ── events, long-poll ──┤
                                                        ▼
                                              hub/server.mjs on 127.0.0.1:4848
                                                        │ SSE
                                                        ▼
                                              call window ── WebRTC ── ElevenLabs agent
```

- `hooks/register.tsx` is the mod. It reports activity, pulls commands from the hub and runs them in its own session. The hub never calls Claude.
- `hub/launch.mjs` starts the hub detached when it is down. The hub exits after ten idle minutes.
- `hub/agent.mjs` creates or updates your agent from `agent/agent.json` and `agent/prompt.md` (plain REST, no packages). Change those files and the next call syncs the agent.
- `window/` is the call window. It loads `@elevenlabs/client` from jsDelivr, pinned to one version.

## Security

- The hub listens on 127.0.0.1 only and refuses any other `Host` or `Origin`.
- The ElevenLabs key stays in the hub process. The window gets a short-lived conversation token per call.
- Three secrets: the service token in `~/.luke-voice/hub.json` (mode 600) lets a mod subscribe; each subscription gets its own session token for its inbox; the window key (in the window URL) can send commands but cannot read an inbox.
- The agent requires signed tokens, so its id alone cannot start a call.
- Prompts reach Claude framed as relayed by luke-voice, and the pane lists each one.
- The call window loads the ElevenLabs client from a pinned CDN file checked with Subresource Integrity.
- Session activity and task results reach the voice agent only as marked untrusted context, never as the user's words, and the tools that act on the computer are refused until the user speaks after an automatic update.

## Development

```bash
claude --plugin-dir .                 # load this clone, hot-reloads
claude plugin validate .
claude plugin test .
node --test hub/*.test.mjs window/*.test.mjs window/engines/*.test.mjs
```

## License

MIT. Written from scratch; it shares no code with other voice mods.
