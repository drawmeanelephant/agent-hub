#!/usr/bin/env bash
# Stop the hub (boris + collector).
cd "$(dirname "$0")"
for name in collector boris; do
  pidfile=".runtime/$name.pid"
  if [ -f "$pidfile" ]; then
    pid=$(cat "$pidfile")
    if kill -0 "$pid" 2>/dev/null; then
      kill "$pid" && echo "stopped $name (pid $pid)"
    else
      echo "$name not running (stale pid)"
    fi
    rm -f "$pidfile"
  else
    echo "$name: no pidfile"
  fi
done
