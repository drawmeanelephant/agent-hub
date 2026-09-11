#!/usr/bin/env bash
# Start the whole hub: Boris watch+serve (site) and the collector (upload API).
set -euo pipefail
cd "$(dirname "$0")"

RUN=.runtime
STATE=state
mkdir -p "$RUN" "$STATE"

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

ok_boris=""
ok_collector=""
for _ in $(seq 1 40); do
  [ -z "$ok_boris" ]     && curl -sf -o /dev/null http://127.0.0.1:8090/            && ok_boris=1
  [ -z "$ok_collector" ] && curl -sf -o /dev/null http://127.0.0.1:8801/api/health  && ok_collector=1
  [ -n "$ok_boris" ] && [ -n "$ok_collector" ] && break
  sleep 0.5
done

# Fail loudly instead of printing the happy banner over a dead service
# (e.g. a stale hub still squatting on the ports).
if [ -z "$ok_boris" ] || [ -z "$ok_collector" ]; then
  echo
  [ -z "$ok_boris" ] && {
    echo "  ✗ boris did not come up on :8090 — last log lines:"
    tail -n 10 boris.log 2>/dev/null | sed 's/^/    /'
    echo "    (port busy? lsof -nP -iTCP:8090 -sTCP:LISTEN)"
  }
  [ -z "$ok_collector" ] && {
    echo "  ✗ collector did not come up on :8801 — last log lines:"
    tail -n 10 collector.log 2>/dev/null | sed 's/^/    /'
    echo "    (port busy? lsof -nP -iTCP:8801 -sTCP:LISTEN)"
  }
  exit 1
fi

echo
echo "  site:      http://127.0.0.1:8090/   (dashboard + blog, served by boris)"
echo "  collector: http://127.0.0.1:8801/   (upload API for agents)"
echo "  token:     $(cat "$STATE/upload-token" 2>/dev/null || echo '(not created yet — check collector.log)')   (human/admin)"
echo "  agents:    node collector/tokens.js add <name>   (mint one per agent)"
echo "  logs:      boris.log · collector.log   stop: ./stop.sh"
