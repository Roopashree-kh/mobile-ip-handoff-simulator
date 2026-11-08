#!/usr/bin/env bash
# Starts the Mobile IPv4 handoff simulator on Linux or macOS. No root needed.
#   ./start.sh          dashboard on http://localhost:5173 (Vite dev server)
#   ./start.sh --prod   dashboard built once and served on http://localhost:8080
cd "$(dirname "$0")" || exit 1
command -v python3 >/dev/null || { echo "Python 3.10 or newer is required."; exit 1; }
command -v node >/dev/null || { echo "Node.js 18 or newer is required."; exit 1; }
exec python3 run_all.py "$@"
