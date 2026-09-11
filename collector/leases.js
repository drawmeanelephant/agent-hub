'use strict';
// Work Protocol v1.1 — path-scoped work leases for agent-hub.
//
// A lease is a temporary, token-pinned claim on the paths (or area) an agent
// intends to touch while pushing one task forward. Multiple leases on one task
// are the "focus lanes" mechanism: overlapping declared paths block, softer
// coupling (same-task intent, not-yet-existing paths) only advises. Durable
// JSON persistence at state/leases.json, atomic writes, no dependencies.
//
// House rules honored here:
//   - hard attribution: the holder is the token identity, never a body field
//   - timestamps are server-stamped
//   - heartbeats coalesce their writes (persistSeconds) so polling agents do
//     not rewrite leases.json on every tick; state transitions always persist
//   - any read lazily flips expired leases to stale and finalizes due reclaims
//     (no daemon, no cron)

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const paths = require('./paths');
const store = require('./store');

const FILE = paths.durableFile('leases.json');

const STATES = ['active', 'stale', 'reclaim-pending', 'released', 'reclaimed', 'cancelled'];
const TERMINAL = new Set(['released', 'reclaimed', 'cancelled']);

// Work-protocol knobs live in collector/config.json under "work". Defaults
// match the spec; CI shrinks graceSec so the reclaim path is testable without
// a two-minute wait.
const DEFAULT_WORK = {
  ttlSec: 300,
  ttlFloorSec: 120,
  ttlCeilSec: 3600,
  graceSec: 120,
  persistSeconds: 15,
  maxLeases: 500,
  maxPaths: 32,
  maxIntent: 300,
  maxReason: 300,
  maxPrRef: 300,
  sharedArtifacts: [
    'package-lock.json', 'yarn.lock', 'pnpm-lock.yaml', 'Cargo.lock',
    'poetry.lock', 'go.sum', 'dist/**', 'content/posts/*.assets/**',
  ],
};

let WORK = { ...DEFAULT_WORK };
try {
  const cfg = JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json'), 'utf8'));
  if (cfg.work && typeof cfg.work === 'object') {
    WORK = { ...WORK, ...cfg.work };
    if (!Array.isArray(WORK.sharedArtifacts)) WORK.sharedArtifacts = DEFAULT_WORK.sharedArtifacts;
  }
} catch { /* defaults are fine */ }

// ---- persistence (write-to-temp + rename = atomic, mirrors tasks.js) ----

let cache = null;
let cacheMtime = 0;
let lastSavedAt = 0;

function load() {
  let mtime = 0;
  try { mtime = fs.statSync(FILE).mtimeMs; } catch { /* first run */ }
  if (cache && mtime === cacheMtime) return cache;
  let db = { leases: {} };
  try {
    db = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    if (!db.leases || typeof db.leases !== 'object' || Array.isArray(db.leases)) db = { leases: {} };
  } catch { /* first run */ }
  cache = db;
  cacheMtime = mtime;
  return db;
}

// Heartbeats update memory and persist at most once per persistSeconds; every
// state transition passes force:true. When the write is skipped, cacheMtime
// stays put so load() keeps serving the newer in-memory copy.
function save(db, opts) {
  cache = db;
  const now = Date.now();
  if (!(opts && opts.force) && now - lastSavedAt < WORK.persistSeconds * 1000) return false;
  paths.ensureState();
  const tmp = FILE + '.tmp-' + process.pid;
  fs.writeFileSync(tmp, JSON.stringify(db, null, 2) + '\n', { mode: 0o600 });
  fs.renameSync(tmp, FILE);
  lastSavedAt = now;
  try { cacheMtime = fs.statSync(FILE).mtimeMs; } catch { cacheMtime = 0; }
  return true;
}

function newId() {
  return 'l-' + Date.now().toString(36) + '-' + crypto.randomBytes(3).toString('hex');
}

function clean(s, max) {
  return String(s == null ? '' : s).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').trim().slice(0, max);
}

function clampTtl(v, fallback) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(Math.max(Math.round(n), WORK.ttlFloorSec), WORK.ttlCeilSec);
}

// ---- path normalization + matching (case and separators unified) ----
// Patterns are repo-relative globs. v1 matches by literal roots ("prefix /
// subtree semantics"): two patterns collide when either root is the other's
// ancestor. Conservative by design — git stays the backstop for renames.

function normalizePath(p) {
  let s = String(p == null ? '' : p).trim().replace(/\\/g, '/').replace(/\/{2,}/g, '/');
  s = s.replace(/^\.\//, '').replace(/^\/+/, '').replace(/\/+$/, '');
  return s.toLowerCase();
}

function isSafePath(p) {
  return !!p && p.length <= 300 && !p.split('/').includes('..');
}

function cleanPaths(input) {
  const raw = Array.isArray(input) ? input : String(input == null ? '' : input).split(',');
  const out = [];
  for (const item of raw) {
    const n = normalizePath(item);
    if (!n || !isSafePath(n)) continue;
    if (!out.includes(n)) out.push(n);
    if (out.length >= WORK.maxPaths) break;
  }
  return out;
}

function rootOf(p) {
  const i = p.indexOf('*');
  if (i === -1) return p;
  const root = p.slice(0, i);
  if (root.endsWith('/')) return root.slice(0, -1);
  const cut = root.lastIndexOf('/');
  return cut === -1 ? '' : root.slice(0, cut);
}

function isAncestor(a, b) {
  return a === b || b.startsWith(a + '/');
}

function patternOverlap(a, b) {
  if (a === b) return true;
  const ra = rootOf(a);
  const rb = rootOf(b);
  if (ra === '' || rb === '') return true; // wildcard at the root matches anything
  return isAncestor(ra, rb) || isAncestor(rb, ra);
}

function pathsOverlap(listA, listB) {
  for (const a of listA) for (const b of listB) if (patternOverlap(a, b)) return [a, b];
  return null;
}

// Shared artifacts are always-overlapping unless BOTH sides opt out
// (sharedArtifacts:false). To let two focus lanes coexist on one task, the
// implicit coverage only blocks when at least one side actually declares a
// path that reaches the artifact.
function sharedTouches(pathList) {
  const hit = [];
  for (const s of WORK.sharedArtifacts) {
    const sn = normalizePath(s);
    if (pathList.some((p) => patternOverlap(p, sn))) hit.push(sn);
  }
  return hit;
}

const STOP_WORDS = new Set(['the', 'and', 'for', 'with', 'this', 'that', 'from', 'into', 'work', 'task', 'adds', 'add', 'fixes', 'fix']);
const INTERFACE_RE = /\b(interface|migration|migrate|rename|schema|contract)\b/i;

function keywords(s) {
  const words = String(s || '').toLowerCase().match(/[a-z][a-z0-9_-]{3,}/g) || [];
  return [...new Set(words.filter((w) => !STOP_WORDS.has(w)))];
}

function keywordOverlap(a, b) {
  const bb = new Set(keywords(b));
  return keywords(a).filter((w) => bb.has(w));
}

// A literal path whose top-level folder exists in this repo but whose file does
// not is likely a new file (the classic collision). Globs and paths from other
// repos (no matching top folder) are left alone.
function pathLooksNew(p) {
  if (!p || p.includes('*')) return false;
  const abs = path.join(paths.ROOT, p);
  if (!abs.startsWith(paths.ROOT + path.sep)) return false;
  try { fs.statSync(abs); return false; } catch { /* maybe new */ }
  try { return fs.statSync(path.join(paths.ROOT, p.split('/')[0])).isDirectory(); } catch { return false; }
}

// ---- collision model (spec §4) ----
// block  → overlapping declared paths, shared artifacts, scope:"task" leases
// advise → same-task intent/interface coupling, not-yet-existing paths, stale
//          leases worth reclaiming. Same-holder leases never block themselves:
//          multiple leases by one agent are just focus lanes.

function assess(candidate, opts) {
  refresh();
  const db = load();
  const exclude = (opts && opts.excludeHolder) || null;
  const cpaths = cleanPaths(candidate.paths || []);
  const cintent = clean(candidate.intent, WORK.maxIntent);
  const cshared = sharedTouches(cpaths);
  const block = [];
  const advise = [];

  for (const l of Object.values(db.leases)) {
    if (TERMINAL.has(l.state)) continue;
    if (exclude && l.holder === exclude) continue;
    if (candidate.taskId && l.taskId !== candidate.taskId) continue;

    const stale = l.state === 'stale';
    const lshared = sharedTouches(l.paths || []);
    const ov = pathsOverlap(cpaths, l.paths || []);
    const taskScope = candidate.scope === 'task' || l.scope === 'task';
    let reason = '';
    if (taskScope) reason = 'scope:"task" lease';
    else if ((cshared.length && l.sharedArtifacts !== false) || (lshared.length && candidate.sharedArtifacts !== false)) {
      reason = 'shared artifact ' + (cshared[0] || lshared[0]);
    } else if (ov) reason = 'overlapping paths: ' + ov[0] + ' ~ ' + ov[1];

    if (reason) {
      if (stale) {
        advise.push({ leaseId: l.id, holder: l.holder, taskId: l.taskId, state: l.state, kind: 'stale', reason: reason + ' (stale, reclaimable)' });
        continue;
      }
      block.push({ leaseId: l.id, holder: l.holder, taskId: l.taskId, state: l.state, reason });
      continue;
    }

    if (stale) {
      advise.push({ leaseId: l.id, holder: l.holder, taskId: l.taskId, state: l.state, kind: 'stale', reason: 'stale lease held by ' + l.holder + ' — reclaimable' });
    } else if (candidate.taskId && l.taskId === candidate.taskId) {
      const kw = cintent ? keywordOverlap(cintent, l.intent) : [];
      if (kw.length) {
        advise.push({ leaseId: l.id, holder: l.holder, taskId: l.taskId, kind: 'intent', reason: 'intent keywords overlap with ' + l.holder + ': ' + kw.join(', ') });
      } else if (INTERFACE_RE.test(cintent) || INTERFACE_RE.test(String(l.intent || ''))) {
        advise.push({ leaseId: l.id, holder: l.holder, taskId: l.taskId, kind: 'interface', reason: 'interface/migration work on this task (' + l.holder + ')' });
      }
    }
  }

  for (const p of cpaths) {
    if (pathLooksNew(p)) advise.push({ path: p, kind: 'new-file', reason: 'declared path does not exist yet — expect new-file collisions' });
  }
  return { block, advise };
}

// ---- lifecycle ----

function prune(db) {
  const all = Object.values(db.leases);
  if (all.length <= WORK.maxLeases) return;
  const removable = all
    .filter((l) => (TERMINAL.has(l.state) || (l.state === 'stale' && !l.pendingReclaim)))
    .sort((a, b) => String(a.updatedAt).localeCompare(String(b.updatedAt)));
  for (const l of removable.slice(0, all.length - WORK.maxLeases)) delete db.leases[l.id];
}

function completeReclaim(l, now) {
  const iso = new Date(now).toISOString();
  const from = l.holder;
  const r = l.pendingReclaim;
  l.reclaims.push({ by: r.by, at: r.at, from, reason: r.reason, outcome: 'completed', resolvedAt: iso });
  l.holder = r.by;
  l.pendingReclaim = null;
  l.state = 'active';
  l.heartbeatAt = iso;
  l.ttlSec = clampTtl(l.ttlSec, WORK.ttlSec);
  l.expiresAt = new Date(now + l.ttlSec * 1000).toISOString();
  l.reclaimedAt = iso;
  l.updatedAt = iso;
  store.addEvent({ agent: r.by, type: 'lease', message: 'reclaimed lease ' + l.id + ' from ' + from + ' (task ' + l.taskId + '): ' + r.reason });
}

// Lazy expiry + second reclaim phase. Every read path calls this; it persists
// and logs only when something actually changed.
function refresh() {
  const db = load();
  const now = Date.now();
  const iso = new Date(now).toISOString();
  const transitions = [];
  let changed = false;
  for (const l of Object.values(db.leases)) {
    if (l.state === 'active' && Date.parse(l.expiresAt) <= now) {
      l.state = 'stale';
      l.updatedAt = iso;
      changed = true;
      transitions.push({ type: 'stale', lease: l });
      store.addEvent({ agent: l.holder, type: 'lease', message: 'lease ' + l.id + ' went stale (task ' + l.taskId + ')' });
    } else if (l.state === 'reclaim-pending' && Date.parse(l.pendingReclaim.graceUntil) <= now) {
      completeReclaim(l, now);
      changed = true;
      transitions.push({ type: 'reclaimed', lease: l });
    }
  }
  if (changed) {
    prune(db);
    save(db, { force: true });
  }
  return transitions;
}

function claimLease({ taskId, holder, paths, area, scope, intent, ttlSec, sharedArtifacts }) {
  const id = clean(taskId, 100);
  if (!id) throw new Error('taskId is required');
  if (!holder) throw new Error('holder is required');
  const sc = scope === 'task' ? 'task' : 'paths';
  const p = cleanPaths(paths);
  const a = clean(area, 100);
  const it = clean(intent, WORK.maxIntent);
  if (!it) throw new Error('intent is required');
  if (sc === 'paths' && !p.length && !a) throw new Error('a lease needs paths or an area');
  const shared = sharedArtifacts === false ? false : true;

  const ass = assess({ taskId: id, holder, paths: p, area: a, scope: sc, intent: it, sharedArtifacts: shared });
  if (ass.block.length) {
    const b = ass.block[0];
    const e = new Error('blocked by ' + b.holder + "'s lease " + b.leaseId + ' (' + b.reason + ')');
    e.status = 409;
    e.holder = b.holder;
    e.leaseId = b.leaseId;
    e.reason = b.reason;
    throw e;
  }

  const db = load();
  const now = Date.now();
  const iso = new Date(now).toISOString();
  const ttl = clampTtl(ttlSec == null ? WORK.ttlSec : ttlSec, WORK.ttlSec);
  const entry = {
    id: newId(),
    taskId: id,
    holder: String(holder).slice(0, 60),
    paths: p,
    area: a || null,
    intent: it,
    scope: sc,
    sharedArtifacts: shared,
    ttlSec: ttl,
    heartbeatAt: iso,
    expiresAt: new Date(now + ttl * 1000).toISOString(),
    state: 'active',
    prRef: null,
    reclaims: [],
    note: null,
    pendingReclaim: null,
    createdAt: iso,
    updatedAt: iso,
  };
  db.leases[entry.id] = entry;
  prune(db);
  save(db, { force: true });
  store.addEvent({
    agent: entry.holder,
    type: 'lease',
    message: 'claimed lease ' + entry.id + ' on task ' + id +
      (p.length ? ' [' + p.join(', ') + ']' : a ? ' [area: ' + a + ']' : ' [whole task]') + ' — ' + it,
  });
  return { lease: entry, advise: ass.advise };
}

function heartbeatLease(id, { by, note, ttlSec }) {
  refresh();
  const db = load();
  const l = db.leases[id];
  if (!l) return null;
  if (TERMINAL.has(l.state)) throw Object.assign(new Error('lease is ' + l.state), { status: 409 });
  if (l.holder !== by) throw Object.assign(new Error('only ' + l.holder + ' can heartbeat this lease'), { status: 409 });

  const now = Date.now();
  const iso = new Date(now).toISOString();
  let transition = false;

  if (l.state === 'reclaim-pending') {
    if (now <= Date.parse(l.pendingReclaim.graceUntil)) {
      l.reclaims.push({ by: l.pendingReclaim.by, at: l.pendingReclaim.at, from: l.holder, reason: l.pendingReclaim.reason, outcome: 'aborted', resolvedAt: iso });
      store.addEvent({ agent: l.holder, type: 'lease', message: 'heartbeat aborted a pending reclaim of lease ' + l.id + ' (task ' + l.taskId + ')' });
      l.pendingReclaim = null;
      l.state = 'active';
      transition = true;
    } else {
      completeReclaim(l, now);
      save(db, { force: true });
      throw Object.assign(new Error('lease was reclaimed by ' + l.holder), { status: 409 });
    }
  }

  if (l.state === 'stale') {
    l.state = 'active';
    transition = true;
    store.addEvent({ agent: l.holder, type: 'lease', message: 'revived stale lease ' + l.id + ' (task ' + l.taskId + ')' });
  }

  if (note != null) l.note = clean(note, 500) || null;
  l.ttlSec = clampTtl(ttlSec == null ? l.ttlSec : ttlSec, l.ttlSec || WORK.ttlSec);
  l.heartbeatAt = iso;
  l.expiresAt = new Date(now + l.ttlSec * 1000).toISOString();
  l.updatedAt = iso;
  save(db, { force: transition });
  return l;
}

function releaseLease(id, { by, note, prRef }) {
  refresh();
  const db = load();
  const l = db.leases[id];
  if (!l) return null;
  const admin = by === 'primary';
  if (!admin && l.holder !== by) {
    throw Object.assign(new Error('only ' + l.holder + ' (or the admin token) can release this lease'), { status: 409 });
  }
  if (l.state === 'released' || l.state === 'cancelled') return l;
  if (l.state === 'reclaimed') throw Object.assign(new Error('lease was reclaimed by ' + l.holder), { status: 409 });

  const now = new Date().toISOString();
  l.state = admin && l.holder !== by ? 'cancelled' : 'released';
  l.releasedAt = now;
  l.updatedAt = now;
  l.expiresAt = now;
  l.pendingReclaim = null;
  if (prRef != null) {
    const r = clean(prRef, WORK.maxPrRef);
    if (r) l.prRef = r;
  }
  if (note != null) l.note = clean(note, 500) || null;
  save(db, { force: true });
  store.addEvent({
    agent: by,
    type: 'lease',
    message: (l.state === 'cancelled' ? 'cancelled' : 'released') + ' lease ' + l.id +
      ' (task ' + l.taskId + ')' + (l.prRef ? ' — PR ' + l.prRef : ''),
  });
  return l;
}

function reclaimLease(id, { by, reason }) {
  refresh();
  const db = load();
  const l = db.leases[id];
  if (!l) return null;
  if (TERMINAL.has(l.state)) throw Object.assign(new Error('lease is ' + l.state), { status: 409 });
  if (l.holder === by) {
    if (l.state === 'reclaim-pending' && l.pendingReclaim.by !== by) {
      throw Object.assign(new Error('a reclaim by ' + l.pendingReclaim.by + ' is pending — heartbeat to keep your lease'), { status: 409 });
    }
    return { lease: l, phase: 'complete' };
  }

  const now = Date.now();
  const iso = new Date(now).toISOString();
  const r = clean(reason, WORK.maxReason);
  if (!r) throw Object.assign(new Error('a reclaim reason is required'), { status: 400 });

  if (l.state === 'active') {
    throw Object.assign(new Error('lease is active (held by ' + l.holder + ') — only stale leases can be reclaimed'), { status: 409 });
  }
  if (l.state === 'reclaim-pending') {
    if (l.pendingReclaim.by === by) return { lease: l, phase: 'pending' };
    throw Object.assign(new Error('reclaim already pending by ' + l.pendingReclaim.by), { status: 409 });
  }

  l.state = 'reclaim-pending';
  l.pendingReclaim = { by, at: iso, reason: r, graceUntil: new Date(now + WORK.graceSec * 1000).toISOString() };
  l.updatedAt = iso;
  save(db, { force: true });
  store.addEvent({
    agent: by,
    type: 'lease',
    message: 'started reclaim of stale lease ' + l.id + ' held by ' + l.holder +
      ' (grace ' + WORK.graceSec + 's): ' + r,
  });
  return { lease: l, phase: 'pending' };
}

// Active-ish advice for one agent's /api/work poll: coupling on their tasks,
// not-yet-existing paths, and stale/reclaimable neighbours.
function adviceFor(agent) {
  refresh();
  const db = load();
  const mine = Object.values(db.leases).filter((l) => l.holder === agent && !TERMINAL.has(l.state));
  const out = [];
  const seen = new Set();
  const push = (a) => {
    const k = [a.kind, a.leaseId, a.path, a.holder].join('|');
    if (!seen.has(k)) { seen.add(k); out.push(a); }
  };
  for (const l of mine) {
    for (const p of l.paths || []) {
      if (pathLooksNew(p)) push({ kind: 'new-file', leaseId: l.id, taskId: l.taskId, path: p, reason: 'declared path does not exist yet — expect new-file collisions' });
    }
    if (l.pendingReclaim) {
      push({ kind: 'reclaim-pending', leaseId: l.id, taskId: l.taskId, holder: l.pendingReclaim.by, reason: 'reclaim pending by ' + l.pendingReclaim.by + ' until ' + l.pendingReclaim.graceUntil + ' — heartbeat to keep the lease' });
    }
    for (const o of Object.values(db.leases)) {
      if (o.id === l.id || TERMINAL.has(o.state)) continue;
      if (o.taskId !== l.taskId || o.holder === agent) continue;
      if (o.state === 'stale') {
        push({ kind: 'stale', leaseId: o.id, taskId: o.taskId, holder: o.holder, reason: 'stale lease held by ' + o.holder + ' — reclaimable' });
      }
      const kw = keywordOverlap(l.intent, o.intent);
      if (kw.length) push({ kind: 'intent', leaseId: o.id, taskId: o.taskId, holder: o.holder, reason: 'intent keywords overlap with ' + o.holder + ': ' + kw.join(', ') });
      if (INTERFACE_RE.test(String(l.intent || '')) || INTERFACE_RE.test(String(o.intent || ''))) {
        push({ kind: 'interface', leaseId: o.id, taskId: o.taskId, holder: o.holder, reason: 'interface/migration work on this task (' + o.holder + ')' });
      }
      if (l.area && l.area === o.area) {
        push({ kind: 'area', leaseId: o.id, taskId: o.taskId, holder: o.holder, reason: 'shared advisory area "' + l.area + '" with ' + o.holder });
      }
    }
  }
  return out;
}

// ---- reads ----

function listLeases(filter) {
  refresh();
  const f = filter || {};
  const sinceTs = f.since && Number.isFinite(Date.parse(f.since)) ? Date.parse(f.since) : null;
  let rows = Object.values(load().leases);
  if (f.status && f.status !== 'all') rows = rows.filter((l) => l.state === f.status);
  if (f.task) rows = rows.filter((l) => l.taskId === f.task);
  if (f.agent) rows = rows.filter((l) => l.holder === f.agent);
  if (f.paths) {
    const q = cleanPaths(f.paths);
    rows = rows.filter((l) => !!pathsOverlap(q, l.paths || []));
  }
  if (sinceTs != null) rows = rows.filter((l) => Date.parse(l.updatedAt) > sinceTs);
  rows.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
  return rows;
}

function countsByState() {
  const out = { active: 0, stale: 0, 'reclaim-pending': 0, released: 0, reclaimed: 0, cancelled: 0, total: 0 };
  for (const l of Object.values(load().leases)) {
    if (out[l.state] !== undefined) out[l.state]++;
    out.total++;
  }
  return out;
}

module.exports = {
  FILE, STATES, WORK,
  claimLease, heartbeatLease, releaseLease, reclaimLease,
  listLeases, adviceFor, assess, refresh, countsByState,
  cleanPaths, normalizePath, patternOverlap, pathsOverlap,
};
