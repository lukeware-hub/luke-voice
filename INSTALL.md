# Install luke-voice

luke-voice gives Claude Code a voice: Ceci, an assistant you talk to in Brazilian Portuguese. Installing takes a few minutes, and you do not need to know how to program.

**The easiest way:** open Claude Code and send it this message:

> Instale o luke-voice seguindo https://github.com/lukeware-hub/luke-voice/blob/main/INSTALL.md

Claude Code reads this page and does the rest (see [For AI agents](#for-ai-agents) below). Or install it yourself:

## Before you start

You need one thing: **Claude Code**, installed and signed in once: https://claude.com/claude-code

The installer brings the rest when it is missing: Node.js and, on Windows, Git, both for your user only (no administrator, no password). No account or key is needed: Ceci's voice is free and runs on your computer. ElevenLabs is optional.

## Windows

Press **Windows + R**, paste this line and press **Enter**:

```
powershell -NoProfile -ExecutionPolicy Bypass -c "irm https://raw.githubusercontent.com/lukeware-hub/luke-voice/main/install/install-luke-voice-windows.cmd | iex"
```

The same line works typed in PowerShell or in a Command Prompt. Started from Windows + R, the window waits for Enter before it closes. Or download [install-luke-voice-windows.cmd](https://raw.githubusercontent.com/lukeware-hub/luke-voice/main/install/install-luke-voice-windows.cmd) and double-click it. If Windows shows "Windows protected your PC", click **More info**, then **Run anyway**.

## macOS and Linux

Open the **Terminal** (on macOS: `Cmd + Space`, type `Terminal`, Enter). Paste this line and press **Enter**:

```bash
curl -fsSL https://raw.githubusercontent.com/lukeware-hub/luke-voice/main/install/install.sh | bash
```

Without curl (some Linux installs have only wget):

```bash
wget -qO- https://raw.githubusercontent.com/lukeware-hub/luke-voice/main/install/install.sh | bash
```

## What the installer does

It speaks Brazilian Portuguese, runs 6 steps and stops with a clear message if one fails:

1. Finds Claude Code.
2. Gets Node.js and Git ready. A missing one is downloaded from its official site, checked by sha256 and kept in `~/.luke-voice`: Node.js 24 LTS, and on Windows MinGit (Git for Windows' portable build). A Node.js older than 20 (Ubuntu and Debian ship 12 or 18), or one that cannot download through your proxy, counts as missing: luke-voice gets its own and leaves yours as it is. Without git on macOS or Linux, luke-voice is downloaded as an archive instead.
3. Installs the luke-voice mod into Claude Code.
4. Asks which voice Ceci uses (**Qual voz a Ceci deve usar?**). Press **Enter** for the free voice (recommended). Type **e** for ElevenLabs, which then asks for your key (**Chave**).
5. Checks that the mod is installed and turned on.
6. Downloads Ceci's free voice, only once: about 3.3 GB on a computer with a good graphics card (6 GB or more; from 3.8 GB, such as a Mac with 8 GB, her ears run on the CPU), about 360 MB on any other (about 520 MB with a small graphics card). It first checks the disk has room for it, plus 10%. Each file is checked, and a cut download resumes.

**It worked when** it ends with the green message **Instalação concluída: luke-voice <versão>**.

If you see **A instalação parou**, read the **O que fazer** line under it, fix that one thing and run the installer again. Running it again is always safe: it keeps what is installed and only finishes what is missing.

**Behind a company proxy:** the installer downloads through the proxy in `HTTPS_PROXY` (for example `export HTTPS_PROXY=http://proxy.company.com:8080` before the install line). On Windows it also uses the proxy set in Windows. If step 6 says **sem conexão com a internet, ou a rede (um proxy de empresa) bloqueou o download**, set `HTTPS_PROXY` and run the installer again.

**Disk full:** if step 6 says **Falta espaço: a voz precisa de X GB livres em <pasta>**, free that much space and run the installer again.

## First call

1. Close Claude Code completely and open it again. If the installer installed Node.js or Git, open it from a new terminal window.
2. That's it: the first time, luke-voice turns on by itself, the call window opens and Ceci says "Oi! Eu sou a Ceci. O que vamos fazer hoje?". Talk in Portuguese.

Later, `/luke-voice call` starts a call, and **✦ luke-voice: on/off** above the prompt turns it on and off. If something is missing, type `/luke-voice help`: it checks your setup and says what to fix.

## For AI agents

These steps install luke-voice with no questions. Run them in a terminal on the user's computer and report the result.

1. **Check:** `claude --version` works. If it does not, stop and tell the user to install Claude Code (link above). Do not install Claude Code yourself. Node.js and Git are the installer's job: do not install them yourself.
2. **Install, with no prompts.** Run the installer for the user's system:
   - Windows (PowerShell):
     ```powershell
     $env:LUKE_VOICE_NO_PROMPT='1'; powershell -NoProfile -ExecutionPolicy Bypass -c "irm https://raw.githubusercontent.com/lukeware-hub/luke-voice/main/install/install-luke-voice-windows.cmd | iex"
     ```
   - macOS or Linux:
     ```bash
     curl -fsSL https://raw.githubusercontent.com/lukeware-hub/luke-voice/main/install/install.sh | LUKE_VOICE_NO_PROMPT=1 bash
     ```
     Without curl: `wget -qO- https://raw.githubusercontent.com/lukeware-hub/luke-voice/main/install/install.sh | LUKE_VOICE_NO_PROMPT=1 bash`.
   - The voice: a new install gets the free voice; an existing one keeps the voice it has (someone with an ElevenLabs key stays on ElevenLabs). Set `LUKE_VOICE_PROVIDER=local` or `elevenlabs` only when the user asked for that voice.
   - It can take several minutes (step 6 downloads up to 3.3 GB). Allow a timeout of at least 30 minutes, or run it in the background and wait for it to end.
3. **Check the result:**
   - The output ends with `Instalação concluída: luke-voice <version>`.
   - `claude plugin list --json` has the entry `"id": "luke-voice@luke-voice"` with `"enabled": true`.
   - Step 6 printed `A voz da Ceci está pronta.` If it printed `A voz ainda não está pronta`, run `node "<installPath>/hub/setup.mjs"` again; `installPath` comes from the same `claude plugin list --json` entry. It prints one JSON line; `"ok": true` means the voice works. Exit code 2 means the disk is full (the line says how much space it needs).
4. **On `A instalação parou`:** read the `O que fazer` line, fix that one thing if it is safe, and run step 2 again. Never type or paste an ElevenLabs key: only the user does that.
5. **Tell the user:** close Claude Code completely and open it again (from a new terminal window if the installer installed Node.js or Git). The first time, luke-voice turns on and the call starts by itself.

Options (environment variables, all optional):
- `LUKE_VOICE_PROVIDER=local|elevenlabs`: the voice, when the user chose one.
- `LUKE_VOICE_PROFILE=gpu|light`: force the natural voice on the graphics card, or the light voice.
- `LUKE_VOICE_REF=<branch or tag>`: install that version instead of `main`, to test a change.

## Change the voice or add a key later

In Claude Code, `/luke-voice voz local` or `/luke-voice voz elevenlabs` switches the voice for the next call. To save an ElevenLabs key, run the installer again and type **e** at step 4.

## Uninstall

One line removes everything: luke-voice from Claude Code, the downloaded voice, and the Node.js and Git the installer brought. It asks before it starts, and asks you to close Claude Code first: while Claude Code is open, luke-voice would start again and make its folder again.

- Windows (Windows + R, or PowerShell):
  ```
  powershell -NoProfile -ExecutionPolicy Bypass -c "irm https://raw.githubusercontent.com/lukeware-hub/luke-voice/main/install/uninstall-luke-voice-windows.cmd | iex"
  ```
- macOS or Linux:
  ```bash
  curl -fsSL https://raw.githubusercontent.com/lukeware-hub/luke-voice/main/install/uninstall.sh | bash
  ```
  Without curl: `wget -qO- https://raw.githubusercontent.com/lukeware-hub/luke-voice/main/install/uninstall.sh | bash`.

For AI agents: add `LUKE_VOICE_NO_PROMPT=1` (as in step 2 above) only when the user asked to remove luke-voice.
