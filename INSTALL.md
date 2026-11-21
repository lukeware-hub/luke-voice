# Install luke-voice

luke-voice gives Claude Code a voice: Ceci, an assistant you talk to in Brazilian Portuguese. Installing takes a few minutes, and you do not need to know how to program.

**The easiest way:** open Claude Code and send it this message:

> Instale o luke-voice seguindo https://github.com/lukeware-hub/luke-voice/blob/main/INSTALL.md

Claude Code reads this page and does the rest (see [For AI agents](#for-ai-agents) below). Or install it yourself:

## Before you start

You need two things. The installer checks both and tells you if one is missing.

1. **Claude Code**, installed and signed in once: https://claude.com/claude-code
2. **Node.js 20 or newer**, the "LTS" version with the default options: https://nodejs.org

No account or key is needed: Ceci's voice is free and runs on your computer. ElevenLabs is optional.

## Windows

Open **PowerShell**: press the Windows key, type `PowerShell` and press Enter. Paste this line and press **Enter**:

```powershell
powershell -c "irm https://raw.githubusercontent.com/lukeware-hub/luke-voice/main/install/install-luke-voice-windows.cmd | iex"
```

Or download [install-luke-voice-windows.cmd](https://raw.githubusercontent.com/lukeware-hub/luke-voice/main/install/install-luke-voice-windows.cmd) and double-click it. If Windows shows "Windows protected your PC", click **More info**, then **Run anyway**.

## macOS and Linux

Open the **Terminal** (on macOS: `Cmd + Space`, type `Terminal`, Enter). Paste this line and press **Enter**:

```bash
curl -fsSL https://raw.githubusercontent.com/lukeware-hub/luke-voice/main/install/install.sh | bash
```

## What the installer does

It runs 6 steps and stops with a clear message if one fails:

1. Checks Claude Code.
2. Checks Node.js.
3. Installs the luke-voice mod into Claude Code.
4. Asks which voice Ceci uses. Press **Enter** for the free voice (recommended). Type **e** for ElevenLabs, which then asks for your key.
5. Checks that the mod is installed and turned on.
6. Downloads Ceci's free voice, only once: about 2.8 GB on a computer with a good graphics card (6 GB or more), about 320 MB on any other. Each file is checked, and a cut download resumes.

**It worked when** it ends with the green message **Installation complete: luke-voice 0.9.x**.

If you see **Installation stopped**, read the **What to do** line under it, fix that one thing and run the installer again. Running it again is always safe: it keeps what is installed and only finishes what is missing.

## First call

1. Close Claude Code completely and open it again.
2. Above the prompt you see **✦ luke-voice: off**. Click it. It turns on and a small window opens.
3. Type `/luke-voice call`. Ceci says "Oi! Eu sou a Ceci. O que vamos fazer hoje?". Talk in Portuguese.

If something is missing, type `/luke-voice help`: it checks your setup and says what to fix.

## For AI agents

These steps install luke-voice with no questions. Run them in a terminal on the user's computer and report the result.

1. **Check:** `claude --version` works, and `node -v` prints v20 or higher. If one is missing, stop and tell the user to install it (links above). Do not install Claude Code or Node.js yourself.
2. **Install, with no prompts.** Run the installer for the user's system:
   - Windows (PowerShell):
     ```powershell
     $env:LUKE_VOICE_NO_PROMPT='1'; powershell -c "irm https://raw.githubusercontent.com/lukeware-hub/luke-voice/main/install/install-luke-voice-windows.cmd | iex"
     ```
   - macOS or Linux:
     ```bash
     curl -fsSL https://raw.githubusercontent.com/lukeware-hub/luke-voice/main/install/install.sh | LUKE_VOICE_NO_PROMPT=1 bash
     ```
   - The voice: a new install gets the free voice; an existing one keeps the voice it has (someone with an ElevenLabs key stays on ElevenLabs). Set `LUKE_VOICE_PROVIDER=local` or `elevenlabs` only when the user asked for that voice.
   - It can take several minutes (step 6 downloads up to 3 GB). Allow a timeout of at least 30 minutes, or run it in the background and wait for it to end.
3. **Check the result:**
   - The output ends with `Installation complete: luke-voice <version>`.
   - `claude plugin list --json` has the entry `"id": "luke-voice@luke-voice"` with `"enabled": true`.
   - Step 6 printed `Ceci's voice is ready.` If it printed `The voice is not ready yet`, run `node "<installPath>/hub/setup.mjs"` again; `installPath` comes from the same `claude plugin list --json` entry. It prints one JSON line; `"ok": true` means the voice works.
4. **On `Installation stopped`:** read the `What to do` line, fix that one thing if it is safe, and run step 2 again. Never type or paste an ElevenLabs key: only the user does that.
5. **Tell the user:** close Claude Code completely and open it again, click **✦ luke-voice: off**, then type `/luke-voice call`.

Options (environment variables, all optional):
- `LUKE_VOICE_PROVIDER=local|elevenlabs`: the voice, when the user chose one.
- `LUKE_VOICE_PROFILE=gpu|light`: force the natural voice on the graphics card, or the light voice.
- `LUKE_VOICE_REF=<branch or tag>`: install that version instead of `main`, to test a change.

## Change the voice or add a key later

In Claude Code, `/luke-voice voz local` or `/luke-voice voz elevenlabs` switches the voice for the next call. To save an ElevenLabs key, run the installer again and type **e** at step 4.

## Uninstall

In Claude Code, type `/plugin`, choose **luke-voice** and select **Uninstall**. Or run `claude plugin uninstall luke-voice@luke-voice` in a terminal. The downloaded voice is in the `.luke-voice` folder in your home folder; delete it to free the space.
