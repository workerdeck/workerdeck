#!/usr/bin/env bash
# A small full-screen TUI for exercising shell mode by hand: three pages, a ticking clock, a streaming log,
# a selectable list, and key bindings that an agent has to press rather than type.
#
#   1 2 3 / left right / tab   switch page
#   up down / k j              move the selection (page 3)
#   enter / space              toggle the selected item (page 3)
#   v                          toggle verbose logs (page 2)
#   r                          restart: resets uptime and the log, bumps the restart counter
#   x                          exit (0); ctrl-c exits too (130)
#
# Cursor keys are read in application mode (DECCKM on), so an arrow arrives as ESC O A, the way a real TUI expects it.
# Every restart and exit also prints a plain marker line to the scrollback after the alternate screen closes, which
# is what a `lines` read or a `waitFor` should find.

PAGES=("Overview" "Logs" "Config")
ITEMS=("hot module reload" "source maps" "open browser" "https" "verbose errors")
ENABLED=(1 1 0 0 1)

page=0
selected=0
verbose=0
restarts=0
started=$(date +%s)
ticks=0
status="ready"
log=()

cols=80
rows=24
measure() {
  local size
  size=$(stty size 2>/dev/null) || size="24 80"
  rows=${size% *}
  cols=${size#* }
}

restore() {
  printf '\033[?1l\033[?25h\033[?1049l'
  stty "$saved_stty" 2>/dev/null
}

finish() {
  restore
  printf 'tui-demo exited after %d restart(s)\n' "$restarts"
  exit "${1:-0}"
}

push_log() {
  log+=("$(date +%H:%M:%S) $1")
  if [ "${#log[@]}" -gt 200 ]; then
    log=("${log[@]:1}")
  fi
}

line() {
  printf '\033[K%s\n' "$1"
}

header() {
  local i out=""
  for i in 0 1 2; do
    if [ "$i" -eq "$page" ]; then
      out+=$(printf '\033[7m %d %s \033[0m ' $((i + 1)) "${PAGES[$i]}")
    else
      out+=$(printf ' %d %s  ' $((i + 1)) "${PAGES[$i]}")
    fi
  done
  printf '\033[K\033[1mtui-demo\033[0m  %s\n' "$out"
  line "$(printf '%*s' "$cols" '' | tr ' ' '-')"
}

page_overview() {
  local up=$(($(date +%s) - started))
  line ""
  line "  status      $status"
  line "  uptime      ${up}s"
  line "  restarts    $restarts"
  line "  clock       $(date +%H:%M:%S)"
  line "  terminal    ${cols}x${rows}"
  line "  verbose     $([ "$verbose" -eq 1 ] && echo on || echo off)"
  local on=0 i
  for i in "${!ENABLED[@]}"; do
    on=$((on + ENABLED[i]))
  done
  line "  features    $on of ${#ITEMS[@]} enabled"
}

page_logs() {
  local room=$((rows - 5)) count=${#log[@]} start i
  start=$((count - room))
  [ "$start" -lt 0 ] && start=0
  line ""
  for ((i = start; i < count; i++)); do
    line "  ${log[$i]}"
  done
}

page_config() {
  local i mark cursor
  line ""
  for i in "${!ITEMS[@]}"; do
    [ "${ENABLED[$i]}" -eq 1 ] && mark="[x]" || mark="[ ]"
    if [ "$i" -eq "$selected" ]; then
      cursor=$(printf '\033[7m> %s %s\033[0m' "$mark" "${ITEMS[$i]}")
    else
      cursor="  $mark ${ITEMS[$i]}"
    fi
    line "  $cursor"
  done
  line ""
  line "  up/down to move, enter or space to toggle"
}

footer() {
  printf '\033[%d;1H\033[K\033[2m1/2/3 page  r restart  v verbose  x exit\033[0m' "$rows"
}

draw() {
  printf '\033[H'
  header
  case $page in
    0) page_overview ;;
    1) page_logs ;;
    2) page_config ;;
  esac
  printf '\033[J'
  footer
}

restart() {
  restarts=$((restarts + 1))
  started=$(date +%s)
  log=()
  status="restarted"
  push_log "restart #$restarts"
  # The marker has to outlive the alternate screen, so it goes to the normal buffer and back.
  printf '\033[?1049l'
  printf 'tui-demo restarted #%d\n' "$restarts"
  printf '\033[?1049h\033[2J'
}

key() {
  case $1 in
    1 | 2 | 3) page=$(($1 - 1)) ;;
    $'\t' | right) page=$(((page + 1) % 3)) ;;
    left) page=$(((page + 2) % 3)) ;;
    up | k) [ "$selected" -gt 0 ] && selected=$((selected - 1)) ;;
    down | j) [ "$selected" -lt $((${#ITEMS[@]} - 1)) ] && selected=$((selected + 1)) ;;
    enter | ' ')
      if [ "$page" -eq 2 ]; then
        ENABLED[$selected]=$((1 - ENABLED[selected]))
        push_log "${ITEMS[$selected]} $([ "${ENABLED[$selected]}" -eq 1 ] && echo enabled || echo disabled)"
      fi
      ;;
    v)
      verbose=$((1 - verbose))
      push_log "verbose $([ "$verbose" -eq 1 ] && echo on || echo off)"
      ;;
    r) restart ;;
    x) finish 0 ;;
  esac
}

read_key() {
  local c rest
  IFS= read -rsn1 -t 1 c || return 1
  if [ "$c" = $'\033' ]; then
    IFS= read -rsn2 -t 1 rest
    case $rest in
      '[A' | OA) c=up ;;
      '[B' | OB) c=down ;;
      '[C' | OC) c=right ;;
      '[D' | OD) c=left ;;
      *) c=escape ;;
    esac
  elif [ "$c" = "" ]; then
    c=enter
  fi
  printf '%s' "$c"
}

tick() {
  ticks=$((ticks + 1))
  if [ $((ticks % 2)) -eq 0 ]; then
    push_log "GET /api/health 200 $((RANDOM % 40 + 2))ms"
  fi
  if [ "$verbose" -eq 1 ]; then
    push_log "debug: tick $ticks, $(date +%s) epoch"
  fi
  [ "$status" = "restarted" ] && [ $(($(date +%s) - started)) -ge 3 ] && status="ready"
}

saved_stty=$(stty -g)
trap 'finish 130' INT TERM
trap 'measure; printf "\033[2J"; draw' WINCH
stty -echo -icanon min 1
printf '\033[?1049h\033[?25l\033[?1h\033[2J'
measure
push_log "server started"
printf '\033[?1049l'
printf 'tui-demo ready\n'
printf '\033[?1049h\033[2J'

while :; do
  draw
  if k=$(read_key); then
    key "$k"
  else
    tick
  fi
done
