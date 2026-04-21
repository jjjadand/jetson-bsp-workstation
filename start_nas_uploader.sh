#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$ROOT_DIR/nas-uploader"
CLIENT_DIR="$PROJECT_DIR/client"
SERVER_DIR="$PROJECT_DIR/server"
RUN_DIR="$PROJECT_DIR/.run"

BACKEND_PID_FILE="$RUN_DIR/backend.pid"
FRONTEND_PID_FILE="$RUN_DIR/frontend.pid"
BACKEND_LOG="$RUN_DIR/backend.log"
FRONTEND_LOG="$RUN_DIR/frontend.log"

BACKEND_PORT=3002
FRONTEND_PORT=5173

require_command() {
  local cmd="$1"
  if ! command -v "$cmd" >/dev/null 2>&1; then
    echo "Missing required command: $cmd" >&2
    exit 1
  fi
}

ensure_dependencies() {
  local dir="$1"
  if [ ! -d "$dir/node_modules" ]; then
    echo "Installing dependencies in $dir"
    (cd "$dir" && npm install)
  fi
}

is_pid_running() {
  local pid="$1"
  kill -0 "$pid" >/dev/null 2>&1
}

start_service() {
  local name="$1"
  local dir="$2"
  local pid_file="$3"
  local log_file="$4"
  shift 4
  local cmd=("$@")

  if [ -f "$pid_file" ]; then
    local existing_pid
    existing_pid="$(cat "$pid_file")"
    if is_pid_running "$existing_pid"; then
      echo "$name is already running (PID $existing_pid)"
      return
    fi
    rm -f "$pid_file"
  fi

  mkdir -p "$RUN_DIR"
  echo "Starting $name"
  (
    cd "$dir"
    nohup "${cmd[@]}" >"$log_file" 2>&1 &
    echo $! >"$pid_file"
  )

  sleep 2

  local pid
  pid="$(cat "$pid_file")"
  if ! is_pid_running "$pid"; then
    echo "Failed to start $name. Recent log output:" >&2
    tail -n 30 "$log_file" >&2 || true
    exit 1
  fi
}

require_command npm
mkdir -p "$RUN_DIR"

ensure_dependencies "$SERVER_DIR"
ensure_dependencies "$CLIENT_DIR"

start_service "backend" "$SERVER_DIR" "$BACKEND_PID_FILE" "$BACKEND_LOG" npm run dev
start_service "frontend" "$CLIENT_DIR" "$FRONTEND_PID_FILE" "$FRONTEND_LOG" npm run dev -- --host 0.0.0.0

echo
echo "NAS Uploader started"
echo "Frontend: http://localhost:$FRONTEND_PORT"
echo "Backend:  http://localhost:$BACKEND_PORT"
echo "Logs:"
echo "  $BACKEND_LOG"
echo "  $FRONTEND_LOG"
echo "PIDs:"
echo "  $(cat "$BACKEND_PID_FILE") (backend)"
echo "  $(cat "$FRONTEND_PID_FILE") (frontend)"
