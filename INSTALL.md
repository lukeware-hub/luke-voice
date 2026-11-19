# Install luke-voice

luke-voice is a voice assistant for Claude Code: you talk, and it sends the prompt to Claude. Installing it takes about two minutes, and you do not need to know how to program.

## Before you start

You need three things. The installer checks each one and tells you if something is missing.

1. **Claude Code**, installed and signed in at least once. Get it at https://claude.com/claude-code.
2. **Node.js 20 or newer.** Get the "LTS" version at https://nodejs.org and keep the default options.
3. **An ElevenLabs key** (optional during the install, needed for the voice). Create a free account at https://elevenlabs.io, then copy a key from https://elevenlabs.io/app/settings/api-keys.

## Windows

1. Download the installer: [install-luke-voice-windows.cmd](https://github.com/lukeware-hub/luke-voice/releases/latest/download/install-luke-voice-windows.cmd).
2. Double-click the file you downloaded.
   - If Windows shows "Windows protected your PC", click **More info**, then **Run anyway**. This appears for any file downloaded from the internet.
3. A black window opens and walks through 5 steps. When it asks for the **Key**, paste your ElevenLabs key and press **Enter**. The key stays hidden while you paste. You can also press **Enter** alone to skip this for now.
4. Wait for the green message **Installation complete**, then press any key to close the window.

## macOS and Linux

1. Open the **Terminal** app. On macOS, press `Cmd + Space`, type `Terminal` and press Enter.
2. Copy this line, paste it in the Terminal and press **Enter**:

   ```bash
   curl -fsSL https://raw.githubusercontent.com/lukeware-hub/luke-voice/main/install/install.sh | bash
   ```

3. When it asks for the **Key**, paste your ElevenLabs key and press **Enter**. The key stays hidden while you paste. You can also press **Enter** alone to skip this for now.
4. Wait for the green message **Installation complete**.

## How to know it worked

The installer ends with:

```
  ======================================
   Installation complete: luke-voice 0.2.0
  ======================================
```

Then:

1. Close Claude Code and open it again.
2. Above the prompt you now see the button **✦ luke-voice: off**. Click it, and it changes to **✦ luke-voice: on**.
3. Type `/luke-voice call` and press Enter. A small window opens. Allow the microphone, and start talking.

If you see **Installation stopped**, read the **What to do** line under it, fix that one thing, and run the installer again. Running it again is always safe: it keeps what is already installed and only finishes what is missing.

## Add or change the key later

Run the installer again. At the key step, paste the new key, or press **Enter** to keep the one you saved.

## Uninstall

In Claude Code, type `/plugin`, choose **luke-voice** and select **Uninstall**. Or run `claude plugin uninstall luke-voice@luke-voice` in a terminal.
