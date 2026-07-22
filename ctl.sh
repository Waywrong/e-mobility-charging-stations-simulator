#!/usr/bin/env bash
# Start/stop the e-mobility charging stations simulator + its Web UI as a pair.
# Usage: ./ctl.sh {start|stop|restart|status}
set -euo pipefail

SIM_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WEBUI_DIR="$SIM_DIR/ui/web"
RUN_DIR="$SIM_DIR/run"
SIM_PID_FILE="$RUN_DIR/simulator.pid"
WEBUI_PID_FILE="$RUN_DIR/webui.pid"
SIM_LOG="$RUN_DIR/simulator.log"
WEBUI_LOG="$RUN_DIR/webui.log"

load_node() {
  export NVM_DIR="$HOME/.nvm"
  if [ -s "$NVM_DIR/nvm.sh" ]; then
    # shellcheck disable=SC1091
    . "$NVM_DIR/nvm.sh"
    nvm use 22 >/dev/null 2>&1 || true
  fi
  local ver=0
  if command -v node >/dev/null 2>&1; then
    ver="$(node -e 'console.log(process.versions.node.split(".")[0])' 2>/dev/null || echo 0)"
  fi
  if [ "${ver:-0}" -lt 22 ]; then
    echo "Error: Node.js >=22 is required but not available. Run: nvm install 22" >&2
    exit 1
  fi
}

is_running() {
  local pid_file="$1"
  [ -f "$pid_file" ] && kill -0 "$(cat "$pid_file")" 2>/dev/null
}

start_simulator() {
  if is_running "$SIM_PID_FILE"; then
    echo "Simulator already running (PID $(cat "$SIM_PID_FILE"))"
    return
  fi
  echo "[$(date)] Building simulator..." | tee -a "$SIM_LOG"
  (cd "$SIM_DIR" && pnpm build) >>"$SIM_LOG" 2>&1
  echo "[$(date)] Starting simulator..." | tee -a "$SIM_LOG"
  (
    cd "$SIM_DIR"
    NODE_ENV=production nohup node dist/start.js >>"$SIM_LOG" 2>&1 &
    echo $! > "$SIM_PID_FILE"
    disown
  )
  sleep 2
  if is_running "$SIM_PID_FILE"; then
    echo "Simulator started (PID $(cat "$SIM_PID_FILE")), log: $SIM_LOG"
  else
    echo "Simulator failed to start, check $SIM_LOG" >&2
    exit 1
  fi
}

start_webui() {
  if is_running "$WEBUI_PID_FILE"; then
    echo "Web UI already running (PID $(cat "$WEBUI_PID_FILE"))"
    return
  fi
  echo "[$(date)] Building Web UI..." | tee -a "$WEBUI_LOG"
  (cd "$WEBUI_DIR" && pnpm build) >>"$WEBUI_LOG" 2>&1
  echo "[$(date)] Starting Web UI..." | tee -a "$WEBUI_LOG"
  (
    cd "$WEBUI_DIR"
    nohup node start.js >>"$WEBUI_LOG" 2>&1 &
    echo $! > "$WEBUI_PID_FILE"
    disown
  )
  sleep 2
  if is_running "$WEBUI_PID_FILE"; then
    echo "Web UI started (PID $(cat "$WEBUI_PID_FILE")) at http://localhost:3030, log: $WEBUI_LOG"
  else
    echo "Web UI failed to start, check $WEBUI_LOG" >&2
    exit 1
  fi
}

stop_one() {
  local name="$1" pid_file="$2"
  if is_running "$pid_file"; then
    local pid
    pid="$(cat "$pid_file")"
    kill "$pid" 2>/dev/null || true
    for _ in $(seq 1 10); do
      kill -0 "$pid" 2>/dev/null || break
      sleep 0.5
    done
    if kill -0 "$pid" 2>/dev/null; then
      kill -9 "$pid" 2>/dev/null || true
    fi
    rm -f "$pid_file"
    echo "$name stopped"
  else
    echo "$name not running"
    rm -f "$pid_file"
  fi
}

status() {
  if is_running "$SIM_PID_FILE"; then
    echo "Simulator: running (PID $(cat "$SIM_PID_FILE"))"
  else
    echo "Simulator: stopped"
  fi
  if is_running "$WEBUI_PID_FILE"; then
    echo "Web UI:    running (PID $(cat "$WEBUI_PID_FILE")) - http://localhost:3030"
  else
    echo "Web UI:    stopped"
  fi
}

mkdir -p "$RUN_DIR"

case "${1:-}" in
  start)
    load_node
    start_simulator
    start_webui
    ;;
  stop)
    stop_one "Simulator" "$SIM_PID_FILE"
    stop_one "Web UI" "$WEBUI_PID_FILE"
    ;;
  restart)
    "${BASH_SOURCE[0]}" stop
    "${BASH_SOURCE[0]}" start
    ;;
  status)
    status
    ;;
  *)
    echo "Usage: $0 {start|stop|restart|status}"
    exit 1
    ;;
esac
