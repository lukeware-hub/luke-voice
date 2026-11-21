#!/usr/bin/env bash
# luke-voice installer for macOS and Linux. Paste this in the Terminal:
#   curl -fsSL https://raw.githubusercontent.com/lukeware-hub/luke-voice/main/install/install.sh | bash
# It installs Node.js when it is missing, installs the luke-voice mod into Claude Code, lets you
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
# Node.js, when it is missing: the official build, pinned by sha256, unpacked for this user only
# (no sudo, no password) into luke-voice's folder, and linked next to claude.
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
# Runs claude and prints its output. On failure it prints why and exits; inside $(...) that
# exit only ends the subshell, so every $(run_claude ...) is followed by "|| exit 1".
run_claude() {
  local out
  if ! out=$(claude "$@" 2>&1); then fail "o comando 'claude $*' falhou." "$out"; fi
  printf '%s' "$out"
}
# Reads one JSON field from stdin with Node, which the mod needs anyway.
json() { node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const v=(new Function("j","return "+process.argv[1]))(JSON.parse(s));console.log(v??"")})' "$1"; }
can_ask() { [ "${LUKE_VOICE_NO_PROMPT:-}" != "1" ] && [ -r /dev/tty ]; }
node_major() { command -v node >/dev/null 2>&1 && node -p "process.versions.node.split('.')[0]" 2>/dev/null || echo 0; }
# On a Mac without Apple's developer tools, /usr/bin/git is a stub that opens an install window:
# xcode-select -p says first whether the real one is there.
has_git() {
  if [ "$(uname -s)" = Darwin ] && ! xcode-select -p >/dev/null 2>&1; then return 1; fi
  command -v git >/dev/null 2>&1 && git --version >/dev/null 2>&1
}
sha256_of() { if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | cut -d' ' -f1; else shasum -a 256 "$1" | cut -d' ' -f1; fi; }

# Downloads Node.js into $LV_HOME/node and links node next to claude, which is on the PATH.
install_node() {
  local os arch platform name dir archive bin_dir
  case "$(uname -s)" in Darwin) os=darwin ;; Linux) os=linux ;; *) fail 'este sistema não é macOS nem Linux.' ;; esac
  case "$(uname -m)" in x86_64 | amd64) arch=x64 ;; arm64 | aarch64) arch=arm64 ;; *) fail "o processador $(uname -m) não tem Node.js pronto." 'Instale a versão LTS em https://nodejs.org.' ;; esac
  platform="$os-$arch"
  name="node-$NODE_VERSION-$platform"
  dir="$LV_HOME/node"
  archive="$(mktemp -d)/$name.tar.gz"
  curl -fsSL "https://nodejs.org/dist/$NODE_VERSION/$name.tar.gz" -o "$archive" || fail 'não consegui baixar o Node.js.' 'Confira a internet. Ou instale a versão LTS em https://nodejs.org.'
  [ "$(sha256_of "$archive")" = "$(node_sha256 "$platform")" ] || fail 'o Node.js baixado não passou na conferência de segurança.' 'Rode o instalador de novo. Se repetir, instale a versão LTS em https://nodejs.org.'
  rm -rf "$dir" && mkdir -p "$dir"
  tar -xzf "$archive" -C "$dir" --strip-components 1 || fail 'não consegui abrir o Node.js baixado.'
  rm -f "$archive"
  # Next to claude: the folder Claude Code's own installer put on the PATH (~/.local/bin).
  bin_dir="$(dirname "$(command -v claude)")"
  [ -w "$bin_dir" ] || { bin_dir="$HOME/.local/bin"; mkdir -p "$bin_dir"; }
  ln -sf "$dir/bin/node" "$bin_dir/node"
  export PATH="$dir/bin:$PATH"
}

printf '\n  Instalador do luke-voice\n  Ceci, a assistente de voz do Claude Code. Leva alguns minutos.\n'

step 1 'Procurando o Claude Code'
command -v claude >/dev/null 2>&1 || fail 'o Claude Code não foi encontrado neste computador.' 'Instale em https://claude.com/claude-code e entre na sua conta uma vez.'
ok 'Claude Code encontrado.'

step 2 'Procurando o Node.js'
installed_node=false
# A Node.js this installer put here before is used even if this shell does not see it yet.
if [ "$(node_major)" -lt 20 ] && [ -x "$LV_HOME/node/bin/node" ]; then export PATH="$LV_HOME/node/bin:$PATH"; fi
major=$(node_major)
if [ "$major" -eq 0 ]; then
  echo "      O Node.js não está instalado. Instalando o Node.js $NODE_VERSION só para você (cerca de 30 MB)..."
  install_node
  installed_node=true
elif [ "$major" -lt 20 ]; then
  fail "o Node.js $major é antigo demais (o luke-voice precisa do 20 ou mais novo)." 'Atualize para a versão LTS em https://nodejs.org.'
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
  curl -fsSL "https://codeload.github.com/$REPO/tar.gz/${REF:-main}" -o "$archive" || fail 'não consegui baixar o luke-voice.' 'Confira a internet.'
  rm -rf "$src" && mkdir -p "$src" && tar -xzf "$archive" -C "$src" --strip-components 1 || fail 'não consegui abrir o luke-voice baixado.'
  rm -f "$archive"
  SOURCE="$src"
fi
# Claude Code keeps one source per marketplace: switching between main and a branch replaces it.
out=$(claude plugin marketplace add "$SOURCE" 2>&1)
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
if ! out=$(LUKE_PROVIDER="$provider" LUKE_KEY="$key" node -e 'const v={voice_provider:process.env.LUKE_PROVIDER};if(process.env.LUKE_KEY)v.api_key=process.env.LUKE_KEY;process.stdout.write(JSON.stringify(v))' | claude plugin configure "$PLUGIN" --values-stdin 2>&1); then
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
  step 6 'Baixando a voz da Ceci (até 3 GB, só uma vez)'
  install_path=$(printf '%s' "$list" | json "(Array.isArray(j)?j:[]).find(p=>p.id==='$PLUGIN')?.installPath") || install_path=''
  if [ -n "$install_path" ] && [ -f "$install_path/hub/setup.mjs" ]; then
    if node "$install_path/hub/setup.mjs"; then
      voice_ready=true
      ok 'A voz da Ceci está pronta.'
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
if [ "$(uname -s)" = Darwin ]; then
  echo '  Na primeira chamada, o Mac pergunta se o Chrome pode usar o microfone: clique em Permitir.'
  has_chrome=false; [ -d '/Applications/Google Chrome.app' ] && has_chrome=true
else
  has_chrome=false; for c in google-chrome google-chrome-stable chromium; do command -v "$c" >/dev/null 2>&1 && has_chrome=true; done
fi
if [ "$has_chrome" != true ]; then
  printf '\n  \033[33mDica: instale o Google Chrome (https://www.google.com/chrome). A janela da chamada funciona melhor nele.\033[0m\n'
fi
if [ "$provider" = 'local' ] && [ "$voice_ready" != 'true' ]; then
  printf '\n  A primeira chamada termina de baixar a voz gratuita, só uma vez.\n'
elif [ "$provider" = 'elevenlabs' ] && [ "$has_key" != "true" ]; then
  printf '\n  \033[33mA voz da ElevenLabs precisa de uma chave. Rode o instalador de novo para colocar, ou use a voz gratuita.\033[0m\n'
fi
