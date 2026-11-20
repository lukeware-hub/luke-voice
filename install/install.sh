#!/usr/bin/env bash
# luke-voice installer for macOS and Linux. Paste this in the Terminal:
#   curl -fsSL https://raw.githubusercontent.com/lukeware-hub/luke-voice/main/install/install.sh | bash
# It installs the luke-voice mod into Claude Code, lets you pick Ceci's voice (the free local
# voice, or ElevenLabs with your key), and checks that everything is in place.
# Without questions: LUKE_VOICE_PROVIDER=local|elevenlabs (and LUKE_VOICE_NO_PROMPT=1).
set -uo pipefail

PLUGIN='luke-voice@luke-voice'
REPO='lukeware-hub/luke-voice'

step() { printf '\n\033[36m[%s/5] %s\033[0m\n' "$1" "$2"; }
ok() { printf '      \033[32mOK\033[0m  %s\n' "$1"; }
# Errors go to stderr, so they show even when the step's output is hidden.
fail() {
  {
    printf '\n  \033[31mInstallation stopped: %s\033[0m\n' "$1"
    [ -n "${2:-}" ] && printf '  \033[33mWhat to do: %s\033[0m\n' "$2"
    printf '  \033[33mThen run the installer again.\033[0m\n'
  } >&2
  exit 1
}
# Runs claude and prints its output. On failure it prints why and exits; inside $(...) that
# exit only ends the subshell, so every $(run_claude ...) is followed by "|| exit 1".
run_claude() {
  local out
  if ! out=$(claude "$@" 2>&1); then fail "the command 'claude $*' failed." "$out"; fi
  printf '%s' "$out"
}
# Reads one JSON field from stdin with Node, which the mod needs anyway.
json() { node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const v=(new Function("j","return "+process.argv[1]))(JSON.parse(s));console.log(v??"")})' "$1"; }
can_ask() { [ "${LUKE_VOICE_NO_PROMPT:-}" != "1" ] && [ -r /dev/tty ]; }

printf '\n  luke-voice installer\n  Ceci, a voice assistant for Claude Code. This takes about one minute.\n'

step 1 'Checking that Claude Code is installed'
command -v claude >/dev/null 2>&1 || fail 'Claude Code was not found on this computer.' 'Install it from https://claude.com/claude-code and sign in once.'
ok 'Claude Code found.'

step 2 'Checking that Node.js 20 or newer is installed'
command -v node >/dev/null 2>&1 || fail 'Node.js was not found on this computer.' 'Install the LTS version from https://nodejs.org.'
major=$(node -p "process.versions.node.split('.')[0]") || fail 'Node.js did not run.' 'Install the LTS version from https://nodejs.org.'
[ "$major" -ge 20 ] || fail "Node.js $major is too old." 'Install the LTS version from https://nodejs.org.'
ok "Node.js $major found."

step 3 'Installing the luke-voice mod'
run_claude plugin marketplace add "$REPO" >/dev/null
run_claude plugin marketplace update luke-voice >/dev/null
run_claude plugin install "$PLUGIN" >/dev/null
run_claude plugin update "$PLUGIN" >/dev/null
ok 'luke-voice installed.'

step 4 "Choosing Ceci's voice"
config=$(run_claude plugin configure "$PLUGIN" --json) || exit 1
has_key=$(printf '%s' "$config" | json '!j.unconfigured.includes("api_key")') || fail 'the plugin settings could not be read.'
current=$(printf '%s' "$config" | json 'j.inputs?.voice_provider || ""') || fail 'the plugin settings could not be read.'
provider="${LUKE_VOICE_PROVIDER:-}"
if [ -z "$provider" ] && can_ask; then
  echo '      Which voice should Ceci use?'
  echo '        Enter  Free voice, on your computer (recommended). No account, no key.'
  echo '        e      ElevenLabs. Paid per use; needs an ElevenLabs key.'
  printf '      Choice: '
  IFS= read -r choice </dev/tty || choice=''
  case "$(printf '%s' "$choice" | tr '[:upper:]' '[:lower:]' | tr -d '[:space:]')" in
    e | eleven | elevenlabs) provider='elevenlabs' ;;
    *) provider='local' ;;
  esac
fi
# No answer and no choice: keep the saved one; someone who already has a key stays on ElevenLabs.
if [ -z "$provider" ]; then
  if [ -n "$current" ]; then provider="$current"; elif [ "$has_key" = "true" ]; then provider='elevenlabs'; else provider='local'; fi
fi
case "$provider" in
  local | elevenlabs) ;;
  *) fail "LUKE_VOICE_PROVIDER must be local or elevenlabs, not '$provider'." ;;
esac

key=''
if [ "$provider" = 'elevenlabs' ] && can_ask; then
  if [ "$has_key" = "true" ]; then
    echo '      An ElevenLabs key is already saved. Press Enter to keep it, or paste a new key to replace it.'
  else
    echo '      Get a key at https://elevenlabs.io/app/settings/api-keys (a free account works).'
    echo '      Paste it here and press Enter. It stays hidden. Press Enter alone to skip for now.'
  fi
  printf '      Key: '
  IFS= read -rs key </dev/tty || key=''
  echo
fi
key=$(printf '%s' "$key" | tr -d '[:space:]')
# The values go through environment variables and stdin, never the command line.
if ! out=$(LUKE_PROVIDER="$provider" LUKE_KEY="$key" node -e 'const v={voice_provider:process.env.LUKE_PROVIDER};if(process.env.LUKE_KEY)v.api_key=process.env.LUKE_KEY;process.stdout.write(JSON.stringify(v))' | claude plugin configure "$PLUGIN" --values-stdin 2>&1); then
  fail 'the settings could not be saved.' "$out"
fi
[ -n "$key" ] && has_key=true
unset key
if [ "$provider" = 'local' ]; then
  ok 'Voice: free, on your computer.'
else
  ok 'Voice: ElevenLabs.'
  if [ "$has_key" = "true" ]; then ok 'ElevenLabs key saved in Claude Code secure storage.'; else echo '      No key yet. Run the installer again to add it.'; fi
fi

step 5 'Checking the installation'
list=$(run_claude plugin list --json) || exit 1
version=$(printf '%s' "$list" | json "(Array.isArray(j)?j:[]).find(p=>p.id==='$PLUGIN')?.version") || fail 'the plugin list could not be read.'
[ -n "$version" ] || fail 'luke-voice is not in the list of installed plugins.' 'Check your internet connection.'
enabled=$(printf '%s' "$list" | json "(Array.isArray(j)?j:[]).find(p=>p.id==='$PLUGIN')?.enabled") || fail 'the plugin list could not be read.'
[ "$enabled" = "true" ] || run_claude plugin enable "$PLUGIN" >/dev/null
ok "luke-voice $version is installed and enabled."

printf '\n  \033[32m======================================\033[0m\n'
printf '  \033[32m Installation complete: luke-voice %s\033[0m\n' "$version"
printf '  \033[32m======================================\033[0m\n\n'
echo '  Next:'
echo '   1. Close Claude Code and open it again.'
echo "   2. Above the prompt, click the button 'luke-voice: off' to turn it on."
echo '   3. Type /luke-voice call to start talking with Ceci.'
echo '   To switch the voice later: /luke-voice voz local or /luke-voice voz elevenlabs.'
if [ "$provider" = 'local' ]; then
  printf '\n  The first call downloads the free voice (270 to 430 MB), only once.\n'
elif [ "$has_key" != "true" ]; then
  printf '\n  \033[33mThe ElevenLabs voice needs a key. Run the installer again to add it, or use the free voice.\033[0m\n'
fi
