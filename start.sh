#!/usr/bin/env bash
# Start the whole hub: Boris watch+serve (site) and the collector (upload API).
set -euo pipefail
cd "$(dirname "$0")"

RUN=.runtime
mkdir -p "$RUN"

# Pick the Node binary: BORIS_NODE env wins, then the newest nvm Node 26+,
# then plain `node`. The collector is stdlib-only so any modern Node works.
NODE_BIN="${BORIS_NODE:-}"
if [ -z "$NODE_BIN" ]; then
  NODE_BIN="$(ls -1d "$HOME"/.nvm/versions/node/v26*/bin/node 2>/dev/null | sort -V | tail -1)"
fi
NODE_BIN="${NODE_BIN:-node}"

is_running() { [ -f "$1" ] && kill -0 "$(cat "$1")" 2>/dev/null; }

if is_running "$RUN/boris.pid"; then
  echo "boris:     already running (pid $(cat "$RUN/boris.pid"))"
else
  nohup ./bin/boris watch --input content --html-dir dist --theme themes/hub --port 8090 >> boris.log 2>&1 &
  echo $! > "$RUN/boris.pid"
  echo "boris:     starting (pid $!) → http://127.0.0.1:8090/"
fi

if is_running "$RUN/collector.pid"; then
  echo "collector: already running (pid $(cat "$RUN/collector.pid"))"
else
  nohup "$NODE_BIN" collector/server.js >> collector.log 2>&1 &
  echo $! > "$RUN/collector.pid"
  echo "collector: starting (pid $!, $("$NODE_BIN" --version)) → http://127.0.0.1:8801/"
fi

for _ in $(seq 1 40); do
  b=$(curl -sf -o /dev/null http://127.0.0.1:8090/ && echo ok || true)
  c=$(curl -sf -o /dev/null http://127.0.0.1:8801/api/health && echo ok || true)
  [ -n "$b" ] && [ -n "$c" ] && break
  sleep 0.5
done

echo
echo "  site:      http://127.0.0.1:8090/   (dashboard + blog, served by boris)"
echo "  collector: http://127.0.0.1:8801/   (upload API for agents)"
echo "  token:     $(cat "$RUN/upload-token" 2>/dev/null || echo '(not created yet — check collector.log)')"
echo "  logs:      boris.log · collector.log   stop: ./stop.sh"
