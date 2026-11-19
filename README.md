# luke-voice

A voice coworker beside your Claude Code session. You talk things through with it on a call, and when you agree on something it writes the prompt and sends it to Claude for you. When Claude finishes, or waits on a permission, it tells you out loud.

An on/off button sits above the prompt (`✦ luke-voice: on` / `✦ luke-voice: off`). While it is off, nothing about the session leaves your machine.

> Not affiliated with ElevenLabs. luke-voice calls the public ElevenLabs API with your own key.

## What it does

luke-voice speaks **Brazilian Portuguese** with a Brazilian female voice (ElevenLabs "Roberta"). Whatever you ask out loud runs on your machine in a **Claude Code subagent**: the agent repeats the task, waits for your "sim", starts the subagent in the background, and tells you the result when it finishes. The main chat stays free.

**Example:** say *"Verifica no repositório luke-voice onde o botão de ligar é desenhado."* The agent answers *"Vou procurar no repositório luke-voice onde o botão de ligar é desenhado. Posso?"*. Say *"sim"*. The window log shows "▶" with the task, and a little later the agent says where it is (`hooks/register.tsx`, in the footer render).

- **Watches the session** while it is on: your prompts, Claude's tool calls and failures, final answers and permission waits reach the voice agent as context.
- **Talks with you** in a small call window: an orb that follows the agent's voice, the list of connected sessions, and every prompt it sent.
- **Sends prompts to Claude** with the `luke_send_to_claude` tool:
  - Claude idle: a new turn starts.
  - Claude busy, `now`: the prompt is added as a note to the running turn (queued if that is refused).
  - Claude busy, `after_current`: the prompt is queued until the turn ends.
- **Stops Claude** with `luke_stop_claude`, only when you ask.
- **Many sessions, one call.** Each session that turns luke-voice on joins one local hub under a short name (`api`, `api-2`); the agent sends to the focused one unless you name another.

## Install

**Easiest: use the installer.** It checks what you need, installs the mod, asks for your ElevenLabs key and tells you when it is done. Step-by-step guide: [INSTALL.md](INSTALL.md).

- **Windows:** download [install-luke-voice-windows.cmd](https://github.com/lukeware-hub/luke-voice/releases/latest/download/install-luke-voice-windows.cmd) and double-click it.
- **macOS / Linux:** paste this in the Terminal:

  ```bash
  curl -fsSL https://raw.githubusercontent.com/lukeware-hub/luke-voice/main/install/install.sh | bash
  ```

You need Claude Code, Node.js 20+ and an [ElevenLabs API key](https://elevenlabs.io/app/settings/api-keys). The first call creates a voice agent named `luke-voice` in your ElevenLabs account, and calls are billed to that account.

<details>
<summary>Manual install (for developers)</summary>

```bash
claude plugin marketplace add lukeware-hub/luke-voice
claude plugin install luke-voice@luke-voice
printf '{"api_key":"%s"}' "$ELEVENLABS_API_KEY" | claude plugin configure luke-voice@luke-voice --values-stdin
```

Or export `ELEVENLABS_API_KEY` before you start Claude Code. Then restart Claude Code.

</details>

## Use

| | |
| --- | --- |
| the footer button | turn luke-voice on (opens the window and **starts the call**) or off |
| `/luke-voice` | the same as the button |
| `/luke-voice on` / `off` | set it explicitly |
| `/luke-voice call` | turn it on, open the call window and start the call |
| `/luke-voice window` | open or raise the call window, focus this session |
| `/luke-voice end` | hang up |
| `/luke-voice status` | hub, call, key and queue |

It starts **off** on a fresh install. The choice is remembered across sessions. Turning it on starts the call right away, and the agent greets you. When Claude Code opens with luke-voice already on, it only reconnects: it never starts a call you did not ask for.

The call window is a Chrome window with a profile of its own (`~/.luke-voice/chrome`) that only loads the luke-voice page. It is started with the microphone and sound allowed, so the call needs no extra click. Your own Chrome profile is not changed.

**Off** means: this session leaves the hub, stops sending activity, drops prompts still queued for it, and closes its pane. When no session is left on the hub, the call ends. **On** joins the hub again.

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
node --test hub/server.test.mjs hub/launch.test.mjs hub/agent.test.mjs window/guard.test.mjs
```

## License

MIT. Written from scratch; it shares no code with other voice mods.
