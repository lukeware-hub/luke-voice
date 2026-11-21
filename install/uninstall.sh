#!/usr/bin/env bash
# luke-voice uninstaller for macOS and Linux. Paste this in the Terminal:
#   curl -fsSL https://raw.githubusercontent.com/lukeware-hub/luke-voice/main/install/uninstall.sh | bash
# It stops Ceci, removes the luke-voice mod from Claude Code, deletes luke-voice's folder (the voice,
# and the Node.js the installer brought) and the node link it made. Nothing else changes.
# Without questions: LUKE_VOICE_NO_PROMPT=1.
set -uo pipefail

PLUGIN='luke-voice@luke-voice'
LV_HOME="${LUKE_VOICE_HOME:-$HOME/.luke-voice}"
PORT="${LUKE_VOICE_PORT:-4848}"

step() { printf '\n\033[36m[%s/4] %s\033[0m\n' "$1" "$2"; }
ok() { printf '      \033[32mOK\033[0m  %s\n' "$1"; }
fail() {
  {
    printf '\n  \033[31mA desinstalação parou: %s\033[0m\n' "$1"
    [ -n "${2:-}" ] && printf '  \033[33mO que fazer: %s\033[0m\n' "$2"
  } >&2
  exit 1
}

# Only luke-voice's own folder is ever deleted.
case "${LV_HOME%/}" in
  '' | / | "$HOME" | "${HOME%/}") fail "a pasta '$LV_HOME' não parece ser a do luke-voice." 'Confira a variável LUKE_VOICE_HOME.' ;;
esac

printf '\n  Desinstalador do luke-voice\n'
printf '  Remove o luke-voice do Claude Code e apaga a pasta %s\n' "$LV_HOME"
printf '  (a voz baixada, e o Node.js que o instalador trouxe). O resto do computador não muda.\n'
if [ "${LUKE_VOICE_NO_PROMPT:-}" != "1" ] && [ -r /dev/tty ]; then
  printf '  Continuar? Enter para sim, n para não: '
  IFS= read -r answer </dev/tty || answer=''
  case "$(printf '%s' "$answer" | tr '[:upper:]' '[:lower:]' | tr -d '[:space:]')" in
    n | nao | não) echo '  Nada foi removido.'; exit 0 ;;
  esac
fi

step 1 'Parando a Ceci'
if [ -f "$LV_HOME/hub.json" ]; then
  token=$(sed -n 's/.*"serviceToken": *"\([^"]*\)".*/\1/p' "$LV_HOME/hub.json")
  [ -n "$token" ] && curl -fsS -m 5 -X POST -H "authorization: Bearer $token" "http://127.0.0.1:$PORT/shutdown" >/dev/null 2>&1 && sleep 2
fi
# What could still run from the folder: the voice engine and the call window.
pkill -f "$LV_HOME/engine" >/dev/null 2>&1 || true
pkill -f "user-data-dir=$LV_HOME/chrome" >/dev/null 2>&1 || true
ok 'A Ceci está parada.'

step 2 'Removendo o luke-voice do Claude Code'
if command -v claude >/dev/null 2>&1; then
  claude plugin uninstall "$PLUGIN" >/dev/null 2>&1 || true
  claude plugin marketplace remove luke-voice >/dev/null 2>&1 || true
  ok 'Removido do Claude Code.'
else
  ok 'O Claude Code não está neste computador: nada a remover nele.'
fi

step 3 'Apagando a pasta do luke-voice'
rm -rf "$LV_HOME" || fail "não consegui apagar $LV_HOME." 'Feche o Claude Code e a janela da chamada, e rode o desinstalador de novo.'
ok 'Pasta apagada.'

step 4 'Tirando o link do Node.js do luke-voice'
removed=false
for dir in "$(dirname "$(command -v claude 2>/dev/null || echo /nonexistent/claude)")" "$HOME/.local/bin"; do
  link="$dir/node"
  if [ -L "$link" ]; then
    case "$(readlink "$link")" in "$LV_HOME"/*) rm -f "$link" && removed=true ;; esac
  fi
done
if [ "$removed" = true ]; then ok 'Link removido.'; else ok 'Não havia link.'; fi

printf '\n  \033[32m======================================\033[0m\n'
printf '  \033[32m luke-voice removido.\033[0m\n'
printf '  \033[32m======================================\033[0m\n\n'
echo '  Feche o Claude Code, se estiver aberto, e abra de novo.'
echo '  Para instalar de novo um dia: https://github.com/lukeware-hub/luke-voice'
