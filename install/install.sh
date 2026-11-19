#!/usr/bin/env bash
# luke-voice installer for macOS and Linux. Paste this in the Terminal:
#   curl -fsSL https://raw.githubusercontent.com/lukeware-hub/luke-voice/main/install/install.sh | bash
# It installs the luke-voice mod into Claude Code, asks for the ElevenLabs key (optional),
# and checks that everything is in place.
set -u

PLUGIN='luke-voice@luke-voice'
REPO='lukeware-hub/luke-voice'

step() { printf '\n\033[36m[%s/5] %s\033[0m\n' "$1" "$2"; }
ok() { printf '      \033[32mOK\033[0m  %s\n' "$1"; }
fail() {
  printf '\n  \033[31mInstallation stopped: %s\033[0m\n' "$1"
  [ -n "${2:-}" ] && printf '  \033[33mWhat to do: %s\033[0m\n' "$2"
  printf '  \033[33mThen run the installer again.\033[0m\n'
  exit 1
}
run_claude() {
  local out
  if ! out=$(claude "$@" 2>&1); then fail "the command 'claude $*' failed." "$out"; fi
  printf '%s' "$out"
}
# Reads one JSON field from stdin with Node, which the mod needs anyway.
json() { node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const v=(new Function("j","return "+process.argv[1]))(JSON.parse(s));console.log(v??"")})' "$1"; }

printf '\n  luke-voice installer\n  A voice coworker for Claude Code. This takes about one minute.\n'

step 1 'Checking that Claude Code is installed'
command -v claude >/dev/null 2>&1 || fail 'Claude Code was not found on this computer.' 'Install it from https://claude.com/claude-code and sign in once.'
ok 'Claude Code found.'

step 2 'Checking that Node.js 20 or newer is installed'
command -v node >/dev/null 2>&1 || fail 'Node.js was not found on this computer.' 'Install the LTS version from https://nodejs.org.'
major=$(node -p "process.versions.node.split('.')[0]")
[ "$major" -ge 20 ] || fail "Node.js $major is too old." 'Install the LTS version from https://nodejs.org.'
ok "Node.js $major found."

step 3 'Installing the luke-voice mod'
run_claude plugin marketplace add "$REPO" >/dev/null
run_claude plugin marketplace update luke-voice >/dev/null
run_claude plugin install "$PLUGIN" >/dev/null
run_claude plugin update "$PLUGIN" >/dev/null
ok 'luke-voice installed.'

step 4 'ElevenLabs key (the voice needs it)'
has_key=$(run_claude plugin configure "$PLUGIN" --json | json '!j.unconfigured.includes("api_key")')
key=''
if [ "${LUKE_VOICE_NO_PROMPT:-}" != "1" ] && [ -r /dev/tty ]; then
  if [ "$has_key" = "true" ]; then
    echo '      A key is already saved. Press Enter to keep it, or paste a new key to replace it.'
  else
    echo '      Get a key at https://elevenlabs.io/app/settings/api-keys (a free account works).'
    echo '      Paste it here and press Enter. It stays hidden. Press Enter alone to skip for now.'
  fi
  printf '      Key: '
  IFS= read -rs key </dev/tty || key=''
  echo
fi
key=$(printf '%s' "$key" | tr -d '[:space:]')
if [ -n "$key" ]; then
  # The key goes through an environment variable and stdin, never the command line.
  if ! out=$(LUKE_KEY="$key" node -e 'process.stdout.write(JSON.stringify({api_key:process.env.LUKE_KEY}))' | claude plugin configure "$PLUGIN" --values-stdin 2>&1); then
    fail 'the key could not be saved.' "$out"
  fi
  unset key
  has_key=true
  ok 'Key saved in Claude Code secure storage.'
elif [ "$has_key" = "true" ]; then
  ok 'Kept the saved key.'
else
  echo '      Skipped. You can run the installer again later to add the key.'
fi

step 5 'Checking the installation'
list=$(run_claude plugin list --json)
version=$(printf '%s' "$list" | json "(Array.isArray(j)?j:[]).find(p=>p.id==='$PLUGIN')?.version")
[ -n "$version" ] || fail 'luke-voice is not in the list of installed plugins.' 'Check your internet connection.'
enabled=$(printf '%s' "$list" | json "(Array.isArray(j)?j:[]).find(p=>p.id==='$PLUGIN')?.enabled")
[ "$enabled" = "true" ] || run_claude plugin enable "$PLUGIN" >/dev/null
ok "luke-voice $version is installed and enabled."

printf '\n  \033[32m======================================\033[0m\n'
printf '  \033[32m Installation complete: luke-voice %s\033[0m\n' "$version"
printf '  \033[32m======================================\033[0m\n\n'
echo '  Next:'
echo '   1. Close Claude Code and open it again.'
echo "   2. Above the prompt, click the button 'luke-voice: off' to turn it on."
echo '   3. Type /luke-voice call to start talking.'
if [ "$has_key" != "true" ]; then
  printf '\n  \033[33mThe voice needs an ElevenLabs key. Run the installer again to add it.\033[0m\n'
fi
