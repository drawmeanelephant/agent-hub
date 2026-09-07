'use strict';
// Agent status registry for agent-hub: each agent posts its current state
// (working / blocked / idle / done) through the collector API so the fleet
// can see who is doing what without interrupting anyone. JSON persistence at
// .runtime/agents.json, atomic writes, no dependencies.

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const RUNTIME = path.join(ROOT, '.runtime');
const FILE = path.join(RUNTIME, 'agents.json');

const STATUSES = new Set(['working', 'blocked', 'idle', 'done']);
const MAX_ROLE = 120;
const MAX_NOTE = 500;

// ---- persistence (write-to-temp + rename = atomic, mirrors store.js style) ----

function ensureRuntime() {
  fs.mkdirSync(RUNTIME, { recursive: true });
}

function save(db) {
  ensureRuntime();
  const tmp = FILE + '.tmp-' + process.pid;
  fs.writeFileSync(tmp, JSON.stringify(db, null, 2) + '\n', { mode: 0o600 });
  fs.renameSync(tmp, FILE);
  cache = db;
  cacheMtime = 0;
}

let cache = null;
let cacheMtime = 0;

// Reload whenever the file changes on disk so CLI edits and the running
// collector stay consistent (same pattern as the token registry).
function load() {
  let mtime = 0;
  try { mtime = fs.statSync(FILE).mtimeMs; } catch { /* first run */ }
  if (cache && mtime === cacheMtime) return cache;
  let db = { agents: {} };
  try {
    db = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    if (!db.agents || typeof db.agents !== 'object') db = { agents: {} };
  } catch { /* first run */ }
  cache = db;
  cacheMtime = mtime;
  return db;
}

// ---- operations ----

function clean(s, max) {
  return String(s == null ? '' : s).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').trim().slice(0, max);
}

function setStatus({ agent, status, role, note, workingOn }) {
  const st = String(status || '').trim();
  if (!STATUSES.has(st)) throw new Error('status must be one of: ' + [...STATUSES].join(', '));
  const name = String(agent || '').trim().slice(0, 60);
  if (!name) throw new Error('agent name is required');
  const db = load();
  const prev = db.agents[name] || {};
  const entry = {
    name,
    role: clean(role, MAX_ROLE) || prev.role || null,
    status: st,
    note: clean(note, MAX_NOTE) || null,
    workingOn: clean(workingOn, MAX_NOTE) || null,
    lastSeen: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  db.agents[name] = entry;
  save(db);
  return entry;
}

// Roster: agents that posted status, newest lastSeen first.
function roster() {
  return Object.values(load().agents)
    .sort((a, b) => String(b.lastSeen).localeCompare(String(a.lastSeen)));
}

function countsByStatus() {
  const out = { working: 0, blocked: 0, idle: 0, done: 0 };
  for (const a of Object.values(load().agents)) if (out[a.status] !== undefined) out[a.status]++;
  return out;
}

module.exports = {
  FILE, STATUSES, MAX_ROLE, MAX_NOTE,
  setStatus, roster, countsByStatus,
};
