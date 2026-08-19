#!/usr/bin/env bash
#
# dev-session.sh — start or reattach a persistent tmux session for pgrest-lambda.
#
# Work on this repo over SSH without losing state: Claude Code keeps running
# inside tmux after you close the terminal or your connection drops. Reconnect
# and run this script again to land back in the same session.
#
# Usage:
#   scripts/dev-session.sh              start the session (or attach if it exists)
#   scripts/dev-session.sh attach       attach only; fail if the session is gone
#   scripts/dev-session.sh status       show whether the session is running
#   scripts/dev-session.sh list         list all tmux sessions on this machine
#   scripts/dev-session.sh kill         kill the session (stops Claude too)
#   scripts/dev-session.sh restart      kill and start fresh
#
# Options:
#   -n, --name NAME     session name (default: pgrest, or $PGREST_TMUX_SESSION)
#   -d, --takeover      detach any other client attached to the session
#       --no-claude     create the session but leave window 0 at a shell prompt
#   -h, --help          show this help
#
# Windows created: 0:claude  1:shell  2:git
# Detach with the tmux prefix (Ctrl-b by default) then d.

set -euo pipefail

REPO_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
SESSION="${PGREST_TMUX_SESSION:-pgrest}"
CLAUDE_CMD="${PGREST_CLAUDE_CMD:-claude}"
SCROLLBACK="${PGREST_TMUX_SCROLLBACK:-50000}"
TAKEOVER=0
START_CLAUDE=1
COMMAND=""

die() { printf 'dev-session: %s\n' "$*" >&2; exit 1; }
usage() {
  # Print the header comment block (everything after the shebang up to the
  # first non-comment line), stripped of its leading '#'.
  awk 'NR<3 {next} /^#/ {sub(/^# ?/, ""); print; next} {exit}' "${BASH_SOURCE[0]}"
}

while [ $# -gt 0 ]; do
  case "$1" in
    -n|--name)   [ $# -ge 2 ] || die "--name needs a value"; SESSION="$2"; shift 2 ;;
    -d|--takeover) TAKEOVER=1; shift ;;
    --no-claude) START_CLAUDE=0; shift ;;
    -h|--help)   usage; exit 0 ;;
    start|attach|status|list|kill|restart)
      [ -z "$COMMAND" ] || die "only one command at a time (got '$COMMAND' and '$1')"
      COMMAND="$1"; shift ;;
    *) die "unknown argument: $1 (try --help)" ;;
  esac
done
COMMAND="${COMMAND:-start}"

command -v tmux >/dev/null 2>&1 || die "tmux is not installed (sudo dnf install -y tmux)"

session_exists() { tmux has-session -t "=$SESSION" 2>/dev/null; }

# Attach from outside tmux, switch from inside it — attaching to a session while
# already in one is an error tmux refuses.
attach_session() {
  local attach_args=(-t "=$SESSION")
  [ "$TAKEOVER" -eq 1 ] && attach_args+=(-d)
  if [ -n "${TMUX:-}" ]; then
    tmux switch-client -t "=$SESSION"
  else
    tmux attach-session "${attach_args[@]}"
  fi
}

create_session() {
  # -d: build the session detached so every window is set up before we attach.
  # The first window is a throwaway: tmux needs a session before options can be
  # read or set, and history-limit only applies to panes created afterwards.
  tmux new-session -d -s "$SESSION" -c "$REPO_ROOT" -n bootstrap

  local prev_history
  prev_history="$(tmux show-options -gv history-limit)"
  tmux set-option -g history-limit "$SCROLLBACK"

  tmux new-window -t "$SESSION" -c "$REPO_ROOT" -n claude
  tmux new-window -t "$SESSION" -c "$REPO_ROOT" -n shell
  tmux new-window -t "$SESSION" -c "$REPO_ROOT" -n git

  # Put the server default back so other sessions keep their own scrollback.
  tmux set-option -g history-limit "$prev_history"

  tmux kill-window -t "$SESSION:bootstrap"
  tmux move-window -r -t "$SESSION"   # renumber to 0:claude 1:shell 2:git

  # Everything else is per-session, so it never leaks into other sessions.
  # Note: set-option rejects the '=' exact-match target prefix (tmux 3.2).
  tmux set-option -t "$SESSION" mouse on
  tmux set-option -t "$SESSION" destroy-unattached off      # survive disconnects
  tmux set-option -t "$SESSION" status-left "[#S] "
  local win
  for win in claude shell git; do
    # Don't shrink windows to fit a stale client left behind by a dropped link.
    tmux set-option -w -t "$SESSION:$win" aggressive-resize on
  done

  if [ "$START_CLAUDE" -eq 1 ]; then
    # First word only: PGREST_CLAUDE_CMD may carry arguments ("claude --resume").
    if command -v "${CLAUDE_CMD%% *}" >/dev/null 2>&1; then
      tmux send-keys -t "$SESSION:claude" "$CLAUDE_CMD" C-m
    else
      printf 'dev-session: %s not found on PATH; leaving window 0 at a shell\n' "$CLAUDE_CMD" >&2
    fi
  fi

  tmux select-window -t "$SESSION:claude"
}

case "$COMMAND" in
  start)
    if session_exists; then
      printf 'dev-session: session "%s" already running — attaching\n' "$SESSION"
    else
      printf 'dev-session: creating session "%s" in %s\n' "$SESSION" "$REPO_ROOT"
      create_session
    fi
    attach_session
    ;;
  attach)
    session_exists || die "no session named \"$SESSION\" (run without arguments to create it)"
    attach_session
    ;;
  status)
    if session_exists; then
      printf 'session "%s" is running:\n' "$SESSION"
      tmux list-windows -t "=$SESSION" -F '  #I:#W  panes=#{window_panes}  active=#{?window_active,yes,no}'
      tmux list-clients -t "=$SESSION" -F '  client #{client_tty} (#{client_width}x#{client_height})' 2>/dev/null \
        | grep . || printf '  no clients attached (still running in the background)\n'
    else
      printf 'session "%s" is not running\n' "$SESSION"
      exit 1
    fi
    ;;
  list)
    tmux list-sessions 2>/dev/null || printf 'no tmux sessions on this machine\n'
    ;;
  kill)
    session_exists || die "no session named \"$SESSION\""
    tmux kill-session -t "=$SESSION"
    printf 'dev-session: killed session "%s"\n' "$SESSION"
    ;;
  restart)
    if session_exists; then
      tmux kill-session -t "=$SESSION"
      printf 'dev-session: killed session "%s"\n' "$SESSION"
    fi
    printf 'dev-session: creating session "%s" in %s\n' "$SESSION" "$REPO_ROOT"
    create_session
    attach_session
    ;;
esac
