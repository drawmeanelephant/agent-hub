#!/usr/bin/env bash
# Work Protocol v1.1 acceptance run (spec 2026-09-11) — AC1..AC7.
#
# Boots this checkout's collector on $HUB_PORT with a scratch state/ and a
# shrunk reclaim grace so the two-phase takeover is testable in seconds.
# CI runs it on 8801; locally run HUB_PORT=8802 while the main hub holds 8801.
#
#   HUB_PORT=8802 bash collector/ci-work-protocol.sh
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
PORT="${HUB_PORT:-8801}"
GRACE="${HUB_GRACE_SEC:-1}"
BASE="http://127.0.0.1:$PORT"
CFG="collector/config.json"
SCRATCH=".ci-work"
PID=""

fail() { echo "FAIL: $*" >&2; exit 1; }
mtime() { node -e 'console.log(require("fs").statSync(process.argv[1]).mtimeMs)' "$1"; }
status() { curl -s -o "$SCRATCH/body.json" -w "%{http_code}" "$@"; }
get() { curl -sf "$@" > "$SCRATCH/get.json" || fail "GET $* failed"; }

cleanup() {
  if [ -n "$PID" ]; then kill "$PID" 2>/dev/null || true; fi
  if [ -f "$SCRATCH/config.bak" ]; then cp "$SCRATCH/config.bak" "$CFG" || true; fi
}
trap cleanup EXIT

rm -rf "$SCRATCH" state .runtime
mkdir -p "$SCRATCH"
cp "$CFG" "$SCRATCH/config.bak"
node -e '
const fs = require("fs");
const f = process.argv[1];
const cfg = JSON.parse(fs.readFileSync(f, "utf8"));
cfg.port = Number(process.argv[2]);
cfg.work = Object.assign({}, cfg.work || {}, { graceSec: Number(process.argv[3]) });
fs.writeFileSync(f, JSON.stringify(cfg, null, 2) + "\n");
' "$CFG" "$PORT" "$GRACE"

boot() {
  node collector/server.js > "$SCRATCH/$1" 2>&1 &
  PID=$!
  for _ in $(seq 1 40); do
    curl -sf "$BASE/api/health" >/dev/null && return 0
    sleep 0.5
  done
  cat "$SCRATCH/$1"
  return 1
}

echo "== Work Protocol v1.1 acceptance on :$PORT (grace ${GRACE}s) =="
boot collector-1.log

TOKEN=$(cat state/upload-token)
AUTH="Authorization: Bearer $TOKEN"
A_TOKEN=$(node collector/tokens.js add wp-a | grep -o '[a-f0-9]\{40\}')
B_TOKEN=$(node collector/tokens.js add wp-b | grep -o '[a-f0-9]\{40\}')
C_TOKEN=$(node collector/tokens.js add wp-c | grep -o '[a-f0-9]\{40\}')
aA="Authorization: Bearer $A_TOKEN"
aB="Authorization: Bearer $B_TOKEN"
aC="Authorization: Bearer $C_TOKEN"

TID=$(curl -sf -H "$AUTH" -H "Content-Type: application/json" \
  -d '{"title":"wp acceptance task","detail":"lease lifecycle"}' \
  "$BASE/api/tasks" | grep -o 't-[a-z0-9-]*' | head -1)
[ -n "$TID" ] || fail "task creation"

# --- AC1: two agents, different path scopes of one task, zero 409s
code=$(status -H "$aA" -H "Content-Type: application/json" \
  -d "{\"taskId\":\"$TID\",\"paths\":[\"src/api/**\"],\"intent\":\"add v1 render route\"}" \
  "$BASE/api/leases")
[ "$code" = "201" ] || fail "AC1 first claim -> $code $(cat "$SCRATCH/body.json")"
LA=$(grep -o 'l-[a-z0-9-]*' "$SCRATCH/body.json" | head -1)
code=$(status -H "$aB" -H "Content-Type: application/json" \
  -d "{\"taskId\":\"$TID\",\"paths\":[\"src/web/**\"],\"intent\":\"render shell for the web\"}" \
  "$BASE/api/leases")
[ "$code" = "201" ] || fail "AC1 second claim -> $code $(cat "$SCRATCH/body.json")"
LB=$(grep -o 'l-[a-z0-9-]*' "$SCRATCH/body.json" | head -1)
[ "$LA" != "$LB" ] || fail "AC1 claims must be distinct leases"
echo "AC1 ok — two path scopes on $TID: $LA, $LB"

# --- AC2: overlapping claim 409 naming the holder (case/separators normalized)
code=$(status -H "$aC" -H "Content-Type: application/json" \
  -d "{\"taskId\":\"$TID\",\"paths\":[\"SRC\\\\API\\\\routes.js\"],\"intent\":\"wire route\"}" \
  "$BASE/api/leases")
[ "$code" = "409" ] || fail "AC2 overlapping claim -> $code (want 409)"
grep -q '"holder": "wp-a"' "$SCRATCH/body.json" || fail "AC2 409 must name wp-a: $(cat "$SCRATCH/body.json")"
get "$BASE/api/claims?task=$TID&paths=src/api/routes.js&intent=wire%20route"
grep -q 'wp-a' "$SCRATCH/get.json" || fail "AC2 guard must name wp-a"
grep -q '"block"' "$SCRATCH/get.json" || fail "AC2 guard block list"
echo "AC2 ok — overlapping claim 409 names wp-a; guard blocks"

# --- AC2b: scope:"task" is exclusive; pathless area leases are advisory
TID2=$(curl -sf -H "$AUTH" -H "Content-Type: application/json" \
  -d '{"title":"wp exclusive task","detail":"scope + area"}' \
  "$BASE/api/tasks" | grep -o 't-[a-z0-9-]*' | head -1)
code=$(status -H "$aC" -H "Content-Type: application/json" \
  -d "{\"taskId\":\"$TID2\",\"scope\":\"task\",\"intent\":\"own the whole task\"}" \
  "$BASE/api/leases")
[ "$code" = "201" ] || fail "AC2b task-scope claim -> $code $(cat "$SCRATCH/body.json")"
LC=$(grep -o 'l-[a-z0-9-]*' "$SCRATCH/body.json" | head -1)
code=$(status -H "$aA" -H "Content-Type: application/json" \
  -d "{\"taskId\":\"$TID2\",\"paths\":[\"docs/**\"],\"intent\":\"docs pass\"}" \
  "$BASE/api/leases")
[ "$code" = "409" ] || fail "AC2b path claim vs task scope -> $code (want 409)"
grep -q '"holder": "wp-c"' "$SCRATCH/body.json" || fail "AC2b 409 must name wp-c"
curl -sf -H "$aC" -X POST "$BASE/api/leases/$LC/release" >/dev/null
for who in "$aA" "$aB"; do
  code=$(status -H "$who" -H "Content-Type: application/json" \
    -d "{\"taskId\":\"$TID2\",\"area\":\"design-review\",\"intent\":\"reviewing the design\"}" \
    "$BASE/api/leases")
  [ "$code" = "201" ] || fail "AC2b advisory area claim -> $code (want 201)"
done
echo "AC2b ok — task scope blocks; two advisory area leases coexist"

# --- AC3: stale flip, coalesced heartbeat writes, two-phase reclaim
m1=$(mtime state/leases.json)
code=$(status -H "$aA" -H "Content-Type: application/json" -d '{"note":"still typing"}' \
  "$BASE/api/leases/$LA/heartbeat")
[ "$code" = "200" ] || fail "AC3 heartbeat -> $code"
sleep 0.3
m2=$(mtime state/leases.json)
[ "$m1" = "$m2" ] || fail "AC3 heartbeat rewrote leases.json (coalescing broken)"

rewind() { # simulate a silent holder by rewinding the persisted lease in time
  node -e '
const fs = require("fs");
const db = JSON.parse(fs.readFileSync("state/leases.json", "utf8"));
const l = db.leases[process.argv[1]];
const past = new Date(Date.now() - 3600e3).toISOString();
l.state = "active"; l.pendingReclaim = null;
l.heartbeatAt = past; l.expiresAt = past;
fs.writeFileSync("state/leases.json", JSON.stringify(db, null, 2) + "\n");
' "$1"
}
rewind "$LA"
get "$BASE/api/leases?task=$TID&status=stale"
grep -q "$LA" "$SCRATCH/get.json" || fail "AC3 silent lease did not flip stale"

# phase 1: reclaim pending; a heartbeat inside grace aborts it
code=$(status -H "$aC" -H "Content-Type: application/json" -d '{"reason":"holder silent"}' \
  "$BASE/api/leases/$LA/reclaim")
[ "$code" = "202" ] || fail "AC3 reclaim begin -> $code $(cat "$SCRATCH/body.json")"
grep -q '"state": "reclaim-pending"' "$SCRATCH/body.json" || fail "AC3 reclaim not pending"
code=$(status -H "$aA" -H "Content-Type: application/json" -d '{"note":"alive — long tool call"}' \
  "$BASE/api/leases/$LA/heartbeat")
[ "$code" = "200" ] || fail "AC3 in-grace heartbeat -> $code $(cat "$SCRATCH/body.json")"
grep -q '"state": "active"' "$SCRATCH/body.json" || fail "AC3 heartbeat must keep the lease"
grep -q '"outcome": "aborted"' state/leases.json || fail "AC3 aborted reclaim not audited"

# phase 2: go silent again; after the grace window the takeover completes
rewind "$LA"
code=$(status -H "$aC" -H "Content-Type: application/json" -d '{"reason":"still silent"}' \
  "$BASE/api/leases/$LA/reclaim")
[ "$code" = "202" ] || fail "AC3 second reclaim -> $code"
sleep "$(node -e "console.log($GRACE + 0.5)")"
get "$BASE/api/leases?task=$TID"
grep -q "\"id\": \"$LA\"" "$SCRATCH/get.json" || fail "AC3 reclaimed lease missing"
grep -q '"holder": "wp-c"' "$SCRATCH/get.json" || fail "AC3 takeover not attributed to wp-c"
grep -q '"outcome": "completed"' state/leases.json || fail "AC3 completed reclaim not audited"
echo "AC3 ok — stale flip, in-grace heartbeat kept the lease, post-grace takeover audited"

# --- AC5: a question asked/answered with no `blocked` status anywhere
BEFORE=$(node -e 'console.log(new Date().toISOString())')
QID=$(curl -sf -H "$aC" -H "Content-Type: application/json" \
  -d '{"question":"AC5: proceed with the takeover?","context":"acceptance run"}' \
  "$BASE/api/questions" | grep -o 'q-[a-z0-9-]*' | head -1)
[ -n "$QID" ] || fail "AC5 question create"
curl -sf -H "$AUTH" -H "Content-Type: application/json" -d '{"answer":"yes"}' \
  "$BASE/api/questions/$QID/answer" | grep -q '"status": "answered"' || fail "AC5 answer"
sleep 0.2

# --- AC4: one /api/work poll carries leases + advice + directives + answers
get "$BASE/api/work?agent=wp-c&since=$BEFORE"
grep -q '"leases"' "$SCRATCH/get.json" || fail "AC4 missing leases"
grep -q "\"id\": \"$LA\"" "$SCRATCH/get.json" || fail "AC4 leases must include the held lease"
grep -q '"advice"' "$SCRATCH/get.json" || fail "AC4 missing advice"
grep -q '"kind": "intent"' "$SCRATCH/get.json" || fail "AC4 coupling advice missing"
grep -q '"directives"' "$SCRATCH/get.json" || fail "AC4 missing directives"
grep -q "$QID" "$SCRATCH/get.json" || fail "AC4 missing the answer in /api/work"
WORK_NOW=$(node -e 'console.log(JSON.parse(require("fs").readFileSync(".ci-work/get.json", "utf8")).now)')
get "$BASE/api/work?agent=wp-c&since=$WORK_NOW"
grep -q '"answers": \[\]' "$SCRATCH/get.json" || fail "AC4 ?since must page out old answers"

DID=$(curl -sf -H "$AUTH" -H "Content-Type: application/json" \
  -d '{"text":"CI steer: keep diffs small","target":"global"}' \
  "$BASE/api/directives" | grep -o 'd-[a-z0-9-]*' | head -1)
[ -n "$DID" ] || fail "directive create"
curl -sf -H "$aC" -X POST "$BASE/api/directives/$DID/ack" | grep -q '"status": "acked"' || fail "directive ack"
get "$BASE/api/work?agent=wp-c"
grep -q 'keep diffs small' "$SCRATCH/get.json" || fail "directive missing from /api/work"
curl -sf -H "$aC" -X POST "$BASE/api/directives/$DID/done" | grep -q '"doneBy": "wp-c"' || fail "directive done"
echo "AC4+AC5 ok — one work poll, since paging, ask/answer without blocked, directives"

# --- AC6: release carries prRef; the board shows task -> leases -> PRs
code=$(status -H "$aC" -H "Content-Type: application/json" \
  -d '{"prRef":"acme/hub#123","note":"handing off"}' "$BASE/api/leases/$LA/release")
[ "$code" = "200" ] || fail "AC6 release -> $code $(cat "$SCRATCH/body.json")"
grep -q '"prRef": "acme/hub#123"' "$SCRATCH/body.json" || fail "AC6 prRef not on release"
get "$BASE/api/leases?task=$TID&status=released"
grep -q '"prRef": "acme/hub#123"' "$SCRATCH/get.json" || fail "AC6 board must show prRef"
echo "AC6 ok — $LA released with prRef acme/hub#123"

# --- AC7: protocol state survives `rm -rf .runtime` + restart
kill "$PID" 2>/dev/null || true
wait "$PID" 2>/dev/null || true
PID=""
rm -rf .runtime
boot collector-2.log
get "$BASE/api/leases?task=$TID&status=released"
grep -q 'acme/hub#123' "$SCRATCH/get.json" || fail "AC7 released lease lost after runtime wipe"
get "$BASE/api/questions?status=answered"
grep -q "$QID" "$SCRATCH/get.json" || fail "AC7 answer lost after runtime wipe"
get "$BASE/api/directives?status=all"
grep -q "$DID" "$SCRATCH/get.json" || fail "AC7 directive lost after runtime wipe"
echo "AC7 ok — leases, answers, directives survive rm -rf .runtime"

echo "work-protocol acceptance: AC1-AC7 passed"
