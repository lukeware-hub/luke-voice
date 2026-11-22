#!/usr/bin/env bash
# luke-voice uninstaller for macOS and Linux. Paste this in the Terminal:
#   curl -fsSL https://raw.githubusercontent.com/lukeware-hub/luke-voice/main/install/uninstall.sh | bash
# Without curl:
#   wget -qO- https://raw.githubusercontent.com/lukeware-hub/luke-voice/main/install/uninstall.sh | bash
# It stops Ceci, removes the luke-voice mod from Claude Code, deletes luke-voice's folder (the voice,
# and the Node.js the installer brought) and the node link it made. Nothing else changes.
# Claude Code is closed first: while it is open, the mod would start the hub again, and the hub
# would make the folder again (and could download the voice again).
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
can_ask() { [ "${LUKE_VOICE_NO_PROMPT:-}" != "1" ] && [ -r /dev/tty ]; }
# Claude Code running: its own build's claude process, or npm's (node .../@anthropic-ai/claude-code).
claude_running() { pgrep -x claude >/dev/null 2>&1 || pgrep -f '@anthropic-ai/claude-code' >/dev/null 2>&1; }
# claude on the PATH, else where its installers put it (a terminal opened before it may not see it).
find_claude() {
  local npm_bin='' c
  if command -v claude >/dev/null 2>&1; then command -v claude; return 0; fi
  command -v npm >/dev/null 2>&1 && npm_bin="$(npm prefix -g 2>/dev/null)/bin"
  for c in "$HOME/.local/bin/claude" "$HOME/.claude/local/claude" ${npm_bin:+"$npm_bin/claude"} /opt/homebrew/bin/claude /usr/local/bin/claude; do
    if [ -x "$c" ]; then printf '%s\n' "$c"; return 0; fi
  done
  return 1
}

# Only luke-voice's own folder is ever deleted.
case "${LV_HOME%/}" in
  '' | / | "$HOME" | "${HOME%/}") fail "a pasta '$LV_HOME' não parece ser a do luke-voice." 'Confira a variável LUKE_VOICE_HOME.' ;;
esac

printf '\n  Desinstalador do luke-voice\n'
printf '  Remove o luke-voice do Claude Code e apaga a pasta %s\n' "$LV_HOME"
printf '  (a voz baixada, e o Node.js que o instalador trouxe). O resto do computador não muda.\n'
if can_ask; then
  printf '  Continuar? Enter para sim, n para não: '
  IFS= read -r answer </dev/tty || answer=''
  case "$(printf '%s' "$answer" | tr '[:upper:]' '[:lower:]' | tr -d '[:space:]')" in
    n | nao | não) echo '  Nada foi removido.'; exit 0 ;;
  esac
fi

# With Claude Code open, the mod starts the hub again right after it stops.
claude_open=false
if claude_running; then
  claude_open=true
  if can_ask; then
    while claude_running; do
      printf '\n  \033[33mO Claude Code está aberto: ele ligaria a Ceci de novo durante a remoção.\033[0m\n'
      printf '  Feche todas as janelas do Claude Code e aperte Enter (c continua assim mesmo, n cancela): '
      IFS= read -r answer </dev/tty || answer='n'
      case "$(printf '%s' "$answer" | tr '[:upper:]' '[:lower:]' | tr -d '[:space:]')" in
        n | nao | não) echo '  Nada foi removido.'; exit 0 ;;
        c) break ;;
      esac
    done
    claude_running || claude_open=false
  else
    printf '  \033[33mAviso: o Claude Code está aberto. Feche e abra de novo no fim, ou ele pode ligar a Ceci e baixar a voz outra vez.\033[0m\n' >&2
  fi
fi

step 1 'Parando a Ceci'
if [ -f "$LV_HOME/hub.json" ]; then
  token=$(sed -n 's/.*"serviceToken": *"\([^"]*\)".*/\1/p' "$LV_HOME/hub.json")
  if [ -n "$token" ]; then
    if command -v curl >/dev/null 2>&1; then
      curl -fsS -m 5 -X POST -H "authorization: Bearer $token" "http://127.0.0.1:$PORT/shutdown" >/dev/null 2>&1 && sleep 2
    elif command -v wget >/dev/null 2>&1; then
      wget -q -T 5 -O /dev/null --header="authorization: Bearer $token" --post-data='' "http://127.0.0.1:$PORT/shutdown" >/dev/null 2>&1 && sleep 2
    fi
  fi
fi
# A hub that did not answer, by its command line (node .../luke-voice/.../hub/server.mjs), with its
# guard; then what could still run from the folder: the voice engine (llama-server) and the window.
pkill -f 'node .*luke-voice.*/hub/(server|guard)\.mjs' >/dev/null 2>&1
pkill -f "$LV_HOME/engine" >/dev/null 2>&1
pkill -f "user-data-dir=$LV_HOME/chrome" >/dev/null 2>&1
sleep 1
if pgrep -f 'node .*luke-voice.*/hub/server\.mjs' >/dev/null 2>&1 || pgrep -f "$LV_HOME/engine" >/dev/null 2>&1; then
  # An open Claude Code started it again: said, not hidden; the rest still runs.
  [ "$claude_open" = true ] || fail 'a Ceci ainda está rodando.' 'Feche o Claude Code e a janela da chamada, e rode o desinstalador de novo.'
  printf '      \033[33mA Ceci voltou a rodar porque o Claude Code está aberto.\033[0m\n'
else
  ok 'A Ceci está parada.'
fi

step 2 'Removendo o luke-voice do Claude Code'
# Each removal is checked: only what is there is removed, and a removal that fails stops here.
if CLAUDE=$(find_claude); then
  errfile=$(mktemp)
  # stdout only is read (a warning on stderr is kept for the error text).
  plugins=$("$CLAUDE" plugin list --json 2>"$errfile") || fail 'não consegui ler os plugins do Claude Code.' "$(cat "$errfile")"
  if printf '%s' "$plugins" | grep -q "\"$PLUGIN\""; then
    "$CLAUDE" plugin uninstall "$PLUGIN" >/dev/null 2>"$errfile" || fail 'não consegui remover o luke-voice do Claude Code.' "$(cat "$errfile") Feche o Claude Code e rode o desinstalador de novo."
  fi
  sources=$("$CLAUDE" plugin marketplace list --json 2>"$errfile") || fail 'não consegui ler as origens de plugins do Claude Code.' "$(cat "$errfile")"
  if printf '%s' "$sources" | grep -q '"name": *"luke-voice"'; then
    "$CLAUDE" plugin marketplace remove luke-voice >/dev/null 2>"$errfile" || fail 'não consegui remover a origem do luke-voice do Claude Code.' "$(cat "$errfile") Rode o desinstalador de novo."
  fi
  rm -f "$errfile"
  ok 'Removido do Claude Code.'
else
  ok 'O Claude Code não está neste computador: nada a remover nele.'
fi

step 3 'Apagando a pasta do luke-voice'
rm -rf "$LV_HOME" || fail "não consegui apagar $LV_HOME." 'Feche o Claude Code e a janela da chamada, e rode o desinstalador de novo.'
ok 'Pasta apagada.'

step 4 'Tirando o link do Node.js do luke-voice'
removed=false
# ~/.local/bin, and next to claude, where installers before 0.10.2 put it.
for dir in "$(dirname "${CLAUDE:-/nonexistent/claude}")" "$HOME/.local/bin"; do
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
if [ "$claude_open" = true ]; then
  printf '  \033[33mO Claude Code estava aberto: se a pasta %s voltar, feche o Claude Code e rode o desinstalador de novo.\033[0m\n' "$LV_HOME"
fi
echo '  Para instalar de novo um dia: https://github.com/lukeware-hub/luke-voice'
