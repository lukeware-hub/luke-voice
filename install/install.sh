#!/usr/bin/env bash
# luke-voice installer for macOS and Linux. Paste this in the Terminal:
#   curl -fsSL https://raw.githubusercontent.com/lukeware-hub/luke-voice/main/install/install.sh | bash
# Without curl:
#   wget -qO- https://raw.githubusercontent.com/lukeware-hub/luke-voice/main/install/install.sh | bash
# It installs Node.js when it is missing or too old, installs the luke-voice mod into Claude Code, lets you
# pick Ceci's voice (the free local voice, or ElevenLabs with your key), downloads the free voice,
# and leaves the first call to start by itself when Claude Code opens.
# It speaks Brazilian Portuguese: that is who it is for.
# Without questions: LUKE_VOICE_PROVIDER=local|elevenlabs (and LUKE_VOICE_NO_PROMPT=1).
# The free voice is downloaded here: LUKE_VOICE_PROFILE=gpu|light forces the natural voice on the
# GPU or the light browser voice instead of detecting it.
# LUKE_VOICE_REF=<branch or tag> installs that version instead of main (to test a change).
set -uo pipefail

PLUGIN='luke-voice@luke-voice'
REPO='lukeware-hub/luke-voice'
REF="${LUKE_VOICE_REF:-}"
SOURCE="$REPO${REF:+#$REF}"
LV_HOME="${LUKE_VOICE_HOME:-$HOME/.luke-voice}"
# Node.js, when it is missing or older than 20: the official build, pinned by sha256, unpacked for
# this user only (no sudo, no password) into luke-voice's folder. The mod runs it from there.
NODE_VERSION='v24.22.3'
node_sha256() {
  case "$1" in
    darwin-x64) echo '977614af0504c81045e7fd85596dbca0e5f951b96681516dadafedcca8c447f7' ;;
    darwin-arm64) echo 'ff6e17d4874b76d272212b908cc020d6e815fba5a6c7eaaa06add725840307fd' ;;
    linux-x64) echo '061ec3e3062115705b56b51fa9cc330ab50d34b6969387d4e4b1a50c6809acc2' ;;
    linux-arm64) echo '261af2af250dfd7e9f25cf151d1b2713a0adf8f10a9ad116c4947f68627affe8' ;;
  esac
}

step() { printf '\n\033[36m[%s/6] %s\033[0m\n' "$1" "$2"; }
ok() { printf '      \033[32mOK\033[0m  %s\n' "$1"; }
# Errors go to stderr, so they show even when the step's output is hidden.
fail() {
  {
    printf '\n  \033[31mA instalação parou: %s\033[0m\n' "$1"
    [ -n "${2:-}" ] && printf '  \033[33mO que fazer: %s\033[0m\n' "$2"
    printf '  \033[33mDepois, rode o instalador de novo.\033[0m\n'
  } >&2
  exit 1
}
# Runs claude and prints what it writes to stdout, which may be JSON to read: a warning on stderr
# must not break it. On failure it prints why (stderr) and exits; inside $(...) that exit only ends
# the subshell, so every $(run_claude ...) is followed by "|| exit 1".
run_claude() {
  local out err errfile
  errfile=$(mktemp)
  if ! out=$("$CLAUDE" "$@" 2>"$errfile"); then
    err=$(cat "$errfile"); rm -f "$errfile"
    fail "o comando 'claude $*' falhou." "${err:-$out}"
  fi
  rm -f "$errfile"
  printf '%s' "$out"
}
# Downloads $1 into the file $2: curl, else wget (a Linux without curl).
fetch() {
  if command -v curl >/dev/null 2>&1; then curl -fsSL "$1" -o "$2"
  elif command -v wget >/dev/null 2>&1; then wget -qO "$2" "$1"
  else return 127
  fi
}
# Claude Code's own installer puts claude in ~/.local/bin, which a terminal opened before it does
# not have on its PATH yet; npm puts it in its global folder; Homebrew in its own.
find_claude() {
  local npm_bin='' c
  if command -v claude >/dev/null 2>&1; then command -v claude; return 0; fi
  command -v npm >/dev/null 2>&1 && npm_bin="$(npm prefix -g 2>/dev/null)/bin"
  for c in "$HOME/.local/bin/claude" "$HOME/.claude/local/claude" ${npm_bin:+"$npm_bin/claude"} /opt/homebrew/bin/claude /usr/local/bin/claude; do
    if [ -x "$c" ]; then printf '%s\n' "$c"; return 0; fi
  done
  return 1
}
# Reads one JSON field from stdin with Node, which the mod needs anyway.
json() { node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const v=(new Function("j","return "+process.argv[1]))(JSON.parse(s));console.log(v??"")})' "$1"; }
can_ask() { [ "${LUKE_VOICE_NO_PROMPT:-}" != "1" ] && [ -r /dev/tty ]; }
node_major() { command -v node >/dev/null 2>&1 && node -p "process.versions.node.split('.')[0]" 2>/dev/null || echo 0; }
# The proxy downloads go through (HTTPS_PROXY or HTTP_PROXY, any case), and whether this Node.js
# downloads through it: NODE_USE_ENV_PROXY needs Node.js 22.21+ or 24+ (hub/proxy.mjs).
proxy_at() { printf '%s' "${HTTPS_PROXY:-${https_proxy:-${HTTP_PROXY:-${http_proxy:-}}}}" | tr -d '[:space:]'; }
node_reads_proxy() { [ "$(node -p "const [a, b] = process.versions.node.split('.').map(Number); a >= 24 || (a === 22 && b >= 21)" 2>/dev/null)" = true ]; }
needs_own_node() { [ "$(node_major)" -lt 20 ] || { [ -n "$(proxy_at)" ] && ! node_reads_proxy; }; }
# On a Mac without Apple's developer tools, /usr/bin/git is a stub that opens an install window:
# xcode-select -p says first whether the real one is there.
has_git() {
  if [ "$(uname -s)" = Darwin ] && ! xcode-select -p >/dev/null 2>&1; then return 1; fi
  command -v git >/dev/null 2>&1 && git --version >/dev/null 2>&1
}
sha256_of() { if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | cut -d' ' -f1; else shasum -a 256 "$1" | cut -d' ' -f1; fi; }

# The processor Node.js is for. A Mac with Apple silicon in a terminal under Rosetta says x86_64,
# and an Intel Node.js would leave Ceci on the light voice (llama.cpp has no Intel Mac build).
node_arch() {
  local machine
  machine=$(uname -m)
  if [ "$(uname -s)" = Darwin ] && [ "$(sysctl -n sysctl.proc_translated 2>/dev/null)" = 1 ]; then machine=arm64; fi
  case "$machine" in x86_64 | amd64) echo x64 ;; arm64 | aarch64) echo arm64 ;; *) return 1 ;; esac
}

# Downloads Node.js into $LV_HOME/node and puts it first on this run's PATH. $1=link also links
# node into ~/.local/bin (only when this computer had no Node.js: an older one stays as it was).
install_node() {
  local os arch platform name dir archive
  case "$(uname -s)" in Darwin) os=darwin ;; Linux) os=linux ;; *) fail 'este sistema não é macOS nem Linux.' ;; esac
  arch=$(node_arch) || fail "o processador $(uname -m) não tem Node.js pronto." 'Instale a versão LTS em https://nodejs.org.'
  platform="$os-$arch"
  name="node-$NODE_VERSION-$platform"
  dir="$LV_HOME/node"
  archive="$(mktemp -d)/$name.tar.gz"
  fetch "https://nodejs.org/dist/$NODE_VERSION/$name.tar.gz" "$archive" || fail 'não consegui baixar o Node.js.' 'Confira a internet. Ou instale a versão LTS em https://nodejs.org.'
  [ "$(sha256_of "$archive")" = "$(node_sha256 "$platform")" ] || fail 'o Node.js baixado não passou na conferência de segurança.' 'Rode o instalador de novo. Se repetir, instale a versão LTS em https://nodejs.org.'
  rm -rf "$dir" && mkdir -p "$dir"
  tar -xzf "$archive" -C "$dir" --strip-components 1 || fail 'não consegui abrir o Node.js baixado.'
  rm -f "$archive"
  # Always ~/.local/bin, never next to claude: that can be Homebrew's folder, or a Windows folder
  # under /mnt/c in WSL.
  if [ "${1:-}" = link ]; then
    mkdir -p "$HOME/.local/bin"
    ln -sf "$dir/bin/node" "$HOME/.local/bin/node"
    case ":$PATH:" in *":$HOME/.local/bin:"*) ;; *) path_note=true ;; esac
  fi
  export PATH="$dir/bin:$PATH"
}

printf '\n  Instalador do luke-voice\n  Ceci, a assistente de voz do Claude Code. Leva alguns minutos.\n'

step 1 'Procurando o Claude Code'
CLAUDE=$(find_claude) || fail 'o Claude Code não foi encontrado neste computador.' 'Instale em https://claude.com/claude-code e entre na sua conta uma vez. Se acabou de instalar, feche e abra o terminal.'
ok "Claude Code encontrado ($CLAUDE)."

step 2 'Procurando o Node.js'
installed_node=false
path_note=false
# A Node.js this installer put here before is used even if this shell does not see it yet.
if needs_own_node && [ -x "$LV_HOME/node/bin/node" ]; then export PATH="$LV_HOME/node/bin:$PATH"; fi
major=$(node_major)
# An old Node.js (Ubuntu and Debian ship 12 or 18) counts as a missing one: a private, current one
# goes into luke-voice's folder, without sudo, and the old one stays as it was.
if [ "$major" -eq 0 ]; then
  echo "      O Node.js não está instalado. Instalando o Node.js $NODE_VERSION só para você (cerca de 30 MB)..."
  install_node link
  installed_node=true
elif [ "$major" -lt 20 ]; then
  echo "      O Node.js $major deste computador é antigo (o luke-voice precisa do 20 ou mais novo)."
  echo "      Instalando o Node.js $NODE_VERSION só para o luke-voice, sem mexer no seu (cerca de 30 MB)..."
  install_node
elif [ -n "$(proxy_at)" ] && ! node_reads_proxy; then
  echo "      Este computador usa o proxy $(proxy_at), e o Node.js $major não baixa por ele."
  echo "      Instalando o Node.js $NODE_VERSION só para o luke-voice, sem mexer no seu (cerca de 30 MB)..."
  install_node
fi
major=$(node_major)
[ "$major" -ge 20 ] || fail 'o Node.js não funcionou depois de instalado.' 'Instale a versão LTS em https://nodejs.org.'
ok "Node.js $major pronto."

step 3 'Instalando o luke-voice no Claude Code'
# Claude Code clones a GitHub marketplace with git. Without git (a new Mac asks to install Apple's
# developer tools; some Linux desktops lack it), luke-voice comes as a GitHub archive instead, and
# Claude Code reads it from a folder; running the installer again updates it.
if ! has_git; then
  echo '      O git não está instalado: baixando o luke-voice direto do GitHub.'
  src="$LV_HOME/plugin"
  archive="$(mktemp -d)/luke-voice.tar.gz"
  fetch "https://codeload.github.com/$REPO/tar.gz/${REF:-main}" "$archive" || fail 'não consegui baixar o luke-voice.' 'Confira a internet.'
  rm -rf "$src" && mkdir -p "$src" && tar -xzf "$archive" -C "$src" --strip-components 1 || fail 'não consegui abrir o luke-voice baixado.'
  rm -f "$archive"
  SOURCE="$src"
fi
# Claude Code keeps one source per marketplace: switching between main and a branch replaces it.
out=$("$CLAUDE" plugin marketplace add "$SOURCE" 2>&1)
if [ $? -ne 0 ] || printf '%s' "$out" | grep -q 'Failed to add'; then
  if printf '%s' "$out" | grep -q "source doesn't match"; then
    echo "      Trocando a origem do luke-voice para $SOURCE."
    run_claude plugin marketplace remove luke-voice >/dev/null
    run_claude plugin marketplace add "$SOURCE" >/dev/null
  else
    fail "o comando 'claude plugin marketplace add $SOURCE' falhou." "$out"
  fi
fi
run_claude plugin marketplace update luke-voice >/dev/null
run_claude plugin install "$PLUGIN" >/dev/null
run_claude plugin update "$PLUGIN" >/dev/null
ok 'luke-voice instalado.'

step 4 'Escolhendo a voz da Ceci'
config=$(run_claude plugin configure "$PLUGIN" --json) || exit 1
has_key=$(printf '%s' "$config" | json '!j.unconfigured.includes("api_key")') || fail 'não consegui ler as configurações do plugin.'
current=$(printf '%s' "$config" | json 'j.inputs?.voice_provider || ""') || fail 'não consegui ler as configurações do plugin.'
provider="${LUKE_VOICE_PROVIDER:-}"
if [ -z "$provider" ] && can_ask; then
  echo '      Qual voz a Ceci deve usar?'
  echo '        Enter  Voz gratuita, no seu computador (recomendado). Sem conta e sem chave.'
  echo '        e      ElevenLabs. Paga por uso; precisa de uma chave da ElevenLabs.'
  printf '      Escolha: '
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
  *) fail "LUKE_VOICE_PROVIDER precisa ser local ou elevenlabs, não '$provider'." ;;
esac

key=''
if [ "$provider" = 'elevenlabs' ] && can_ask; then
  if [ "$has_key" = "true" ]; then
    echo '      Já existe uma chave da ElevenLabs salva. Aperte Enter para manter, ou cole uma chave nova.'
  else
    echo '      Pegue uma chave em https://elevenlabs.io/app/settings/api-keys (a conta grátis serve).'
    echo '      Cole aqui e aperte Enter. Ela fica escondida. Só Enter pula por enquanto.'
  fi
  printf '      Chave: '
  IFS= read -rs key </dev/tty || key=''
  echo
fi
key=$(printf '%s' "$key" | tr -d '[:space:]')
# The values go through environment variables and stdin, never the command line.
if ! out=$(LUKE_PROVIDER="$provider" LUKE_KEY="$key" node -e 'const v={voice_provider:process.env.LUKE_PROVIDER};if(process.env.LUKE_KEY)v.api_key=process.env.LUKE_KEY;process.stdout.write(JSON.stringify(v))' | "$CLAUDE" plugin configure "$PLUGIN" --values-stdin 2>&1); then
  fail 'não consegui salvar as configurações.' "$out"
fi
[ -n "$key" ] && has_key=true
unset key
if [ "$provider" = 'local' ]; then
  ok 'Voz: gratuita, no seu computador.'
else
  ok 'Voz: ElevenLabs.'
  if [ "$has_key" = "true" ]; then ok 'Chave da ElevenLabs salva no cofre do Claude Code.'; else echo '      Ainda sem chave. Rode o instalador de novo para colocar.'; fi
fi

step 5 'Conferindo a instalação'
list=$(run_claude plugin list --json) || exit 1
version=$(printf '%s' "$list" | json "(Array.isArray(j)?j:[]).find(p=>p.id==='$PLUGIN')?.version") || fail 'não consegui ler a lista de plugins.'
[ -n "$version" ] || fail 'o luke-voice não aparece na lista de plugins instalados.' 'Confira a internet.'
enabled=$(printf '%s' "$list" | json "(Array.isArray(j)?j:[]).find(p=>p.id==='$PLUGIN')?.enabled") || fail 'não consegui ler a lista de plugins.'
[ "$enabled" = "true" ] || run_claude plugin enable "$PLUGIN" >/dev/null
ok "luke-voice $version instalado e ativado."

voice_ready=false
if [ "$provider" = 'local' ]; then
  step 6 'Baixando a voz da Ceci (até 3,3 GB, só uma vez)'
  install_path=$(printf '%s' "$list" | json "(Array.isArray(j)?j:[]).find(p=>p.id==='$PLUGIN')?.installPath") || install_path=''
  if [ -n "$install_path" ] && [ -f "$install_path/hub/setup.mjs" ]; then
    node "$install_path/hub/setup.mjs"
    setup_code=$?
    if [ "$setup_code" -eq 0 ]; then
      voice_ready=true
      ok 'A voz da Ceci está pronta.'
    elif [ "$setup_code" -eq 2 ]; then
      printf '      \033[33mA voz não foi baixada: falta espaço no disco (veja a linha acima).\033[0m\n'
      printf '      \033[33mO que fazer: libere espaço e rode o instalador de novo, ou digite /luke-voice setup no Claude Code.\033[0m\n'
    else
      printf '      \033[33mA voz ainda não está pronta. A primeira chamada termina o download, ou digite /luke-voice setup no Claude Code.\033[0m\n'
    fi
  else
    echo '      Esta versão baixa a voz na primeira chamada.'
  fi
else
  step 6 'A voz da Ceci'
  ok 'A ElevenLabs não precisa baixar nada.'
fi

# A Mac too slow for the natural voice speaks with its own system voice (hub/mac-voice.mjs): the
# installer asks for Siri Voz 1 and never changes a system setting itself (macOS lets no program
# download a Siri voice). Siri Voz 1 makes the assistant Luke, Siri Voz 2 Nara (hub/persona.mjs).
if [ "$provider" = 'local' ] && [ "$(uname -s)" = Darwin ]; then
  mac_profile=$(json 'j.profile' <"$LV_HOME/engine/profile.json" 2>/dev/null) || mac_profile=''
  if [ "$mac_profile" = 'light' ] && ! defaults read com.apple.Accessibility SpokenContentDefaultVoiceSelectionsByLanguage 2>/dev/null | grep -q 'com\.apple\.siri\.'; then
    echo '      Para a voz soar mais natural neste Mac, escolha a Siri Voz 1 em Ajustes do Sistema ›'
    echo '      Acessibilidade › Conteúdo Falado › Voz do Sistema. Ela baixa uma vez (cerca de 230 MB),'
    echo '      numa rede que não seja a internet do celular. Com a Siri Voz 1 a assistente é o Luke;'
    echo '      com a Siri Voz 2, a Nara.'
    if [ "${LUKE_VOICE_NO_PROMPT:-}" != 1 ]; then
      open 'x-apple.systempreferences:com.apple.Accessibility-Settings.extension?SpokenContent' >/dev/null 2>&1 || true
    fi
  fi
fi

# The first Claude Code opened from now on turns luke-voice on and starts the call by itself.
can_call=false
if [ "$provider" = 'local' ] || [ "$has_key" = "true" ]; then
  can_call=true
  mkdir -p "$LV_HOME" && printf 'pending\n' >"$LV_HOME/first-call"
fi

printf '\n  \033[32m======================================\033[0m\n'
printf '  \033[32m Instalação concluída: luke-voice %s%s\033[0m\n' "$version" "${REF:+ (de $REF)}"
printf '  \033[32m======================================\033[0m\n\n'
echo '  Agora:'
if [ "$installed_node" = true ]; then
  echo '   1. Feche o Claude Code, se estiver aberto, e abra um terminal novo.'
  echo '      Depois abra o Claude Code nele (o Node.js acabou de ser instalado).'
  if [ "$path_note" = true ]; then
    echo '      O node ficou em ~/.local/bin, que este terminal ainda não tem no PATH. Se o comando node'
    echo '      não funcionar no terminal novo, não tem problema: o luke-voice usa o Node.js dele sozinho.'
  fi
else
  echo '   1. Feche o Claude Code, se estiver aberto, e abra de novo.'
fi
if [ "$can_call" = true ]; then
  echo '   2. A Ceci liga sozinha e abre a janela da chamada. É só falar com ela.'
  echo
  echo '  Depois, para chamar a Ceci de novo, digite /luke-voice call no Claude Code.'
else
  echo "   2. Clique no botão 'luke-voice: off', acima de onde você digita, para ligar."
  echo '   3. Digite /luke-voice call para falar com a Ceci.'
fi
echo '  Para trocar a voz: /luke-voice voz local ou /luke-voice voz elevenlabs.'
# The browsers the hub opens the call in as an app window (hub/server.mjs). In WSL the call opens
# in Windows' own browser.
has_chrome=false
if [ "$(uname -s)" = Darwin ]; then
  echo '  Na primeira chamada, o Mac pergunta se o Chrome pode usar o microfone: clique em Permitir.'
  for c in 'Google Chrome' Chromium 'Microsoft Edge'; do
    if [ -d "/Applications/$c.app" ] || [ -d "$HOME/Applications/$c.app" ]; then has_chrome=true; fi
  done
elif grep -qi microsoft /proc/version 2>/dev/null; then
  has_chrome=true
else
  for c in google-chrome google-chrome-stable chromium chromium-browser microsoft-edge; do command -v "$c" >/dev/null 2>&1 && has_chrome=true; done
  for c in /snap/bin/chromium /var/lib/flatpak/exports/bin/com.google.Chrome /var/lib/flatpak/exports/bin/org.chromium.Chromium "$HOME/.local/share/flatpak/exports/bin/com.google.Chrome" "$HOME/.local/share/flatpak/exports/bin/org.chromium.Chromium"; do
    [ -x "$c" ] && has_chrome=true
  done
fi
if [ "$has_chrome" != true ]; then
  printf '\n  \033[33mDica: instale o Google Chrome (https://www.google.com/chrome). A janela da chamada funciona melhor nele.\033[0m\n'
fi
if [ "$provider" = 'local' ] && [ "$voice_ready" != 'true' ]; then
  printf '\n  A primeira chamada termina de baixar a voz gratuita, só uma vez.\n'
elif [ "$provider" = 'elevenlabs' ] && [ "$has_key" != "true" ]; then
  printf '\n  \033[33mA voz da ElevenLabs precisa de uma chave. Rode o instalador de novo para colocar, ou use a voz gratuita.\033[0m\n'
fi
