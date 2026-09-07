'use strict';
// Idea lab for agent-hub: a pipeline that turns raw spitballs into buildable,
// human-approved specs. Raw ideas are NEVER buildable by themselves — the
// only path to work is: pitch → refinement claim (no coding) → spec post →
// human graduation → task-board item. JSON persistence at
// .runtime/pitches.json, atomic writes, no dependencies.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.resolve(__dirname, '..');
const RUNTIME = path.join(ROOT, '.runtime');
const FILE = path.join(RUNTIME, 'pitches.json');

const STATUSES = new Set(['open', 'refining', 'spec-ready', 'graduated', 'shelved']);
const MAX_TITLE = 200;
const MAX_IDEA = 4000;
const MAX_REASON = 500;
const MAX_PITCHES = 500;

// ---- persistence (write-to-temp + rename = atomic, mirrors tasks.js) ----

function ensureRuntime() {
  fs.mkdirSync(RUNTIME, { recursive: true });
}

function save(db) {
  ensureRuntime();
  const tmp = FILE + '.tmp-' + process.pid;
  fs.writeFileSync(tmp, JSON.stringify(db, null, 2) + '\n', { mode: 0o600 });
  fs.renameSync(tmp, FILE);
  cache = db;
  try { cacheMtime = fs.statSync(FILE).mtimeMs; } catch { cacheMtime = 0; }
}

let cache = null;
let cacheMtime = 0;

function load() {
  let mtime = 0;
  try { mtime = fs.statSync(FILE).mtimeMs; } catch { /* first run */ }
  if (cache && mtime === cacheMtime) return cache;
  let db = { pitches: {} };
  try {
    db = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    if (!db.pitches || typeof db.pitches !== 'object') db = { pitches: {} };
  } catch { /* first run */ }
  cache = db;
  cacheMtime = mtime;
  return db;
}

function newId() {
  return 'p-' + Date.now().toString(36) + '-' + crypto.randomBytes(3).toString('hex');
}

function clean(s, max) {
  return String(s == null ? '' : s).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').trim().slice(0, max);
}

// ---- operations ----

function getPitch(id) {
  return load().pitches[id] || null;
}

// status: 'open' | 'refining' | 'spec-ready' | 'graduated' | 'shelved' | 'all'
function listPitches(status) {
  const which = status || 'all';
  const rows = Object.values(load().pitches)
    .filter((p) => (which === 'all' ? true : p.status === which))
    .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
  return prune(rows);
}

// Keep the registry bounded: oldest graduated/shelved fall off first;
// open/refining/spec-ready pitches are never pruned.
function prune(rows) {
  const db = load();
  const all = Object.values(db.pitches);
  if (all.length <= MAX_PITCHES) return rows;
  const oldest = [...all]
    .sort((a, b) => String(a.updatedAt).localeCompare(String(b.updatedAt)))
    .filter((p) => p.status === 'graduated' || p.status === 'shelved')
    .slice(0, all.length - MAX_PITCHES);
  for (const p of oldest) delete db.pitches[p.id];
  return rows.filter((p) => db.pitches[p.id]);
}

function countsByStatus() {
  const out = { open: 0, refining: 0, 'spec-ready': 0, graduated: 0, shelved: 0 };
  for (const p of Object.values(load().pitches)) if (out[p.status] !== undefined) out[p.status]++;
  return out;
}

function addPitch({ title, idea, createdBy }) {
  const titleClean = clean(title, MAX_TITLE);
  const ideaClean = clean(idea, MAX_IDEA);
  if (!titleClean) throw new Error('title is required');
  if (!ideaClean) throw new Error('idea is required — what are we spitballing?');
  const db = load();
  const now = new Date().toISOString();
  const entry = {
    id: newId(),
    title: titleClean,
    idea: ideaClean,
    status: 'open',
    createdBy: String(createdBy || 'unknown').slice(0, 60),
    refinedBy: null,
    specSlug: null,
    graduatedTo: null,
    createdAt: now,
    updatedAt: now,
    refinedAt: null,
    specAt: null,
    graduatedAt: null,
  };
  db.pitches[entry.id] = entry;
  save(db);
  return entry;
}

function refinePitch(id, { by }) {
  const db = load();
  const p = db.pitches[id];
  if (!p) return null;
  if (p.status === 'graduated' || p.status === 'shelved') throw new Error('pitch is ' + p.status);
  if (p.status === 'refining') throw new Error('already being refined by ' + p.refinedBy + ' — release it first');
  const now = new Date().toISOString();
  p.status = 'refining';
  p.refinedBy = String(by || 'unknown').slice(0, 60);
  p.refinedAt = now;
  p.updatedAt = now;
  save(db);
  return p;
}

function releasePitch(id, { by }) {
  const db = load();
  const p = db.pitches[id];
  if (!p) return null;
  if (p.status !== 'refining') throw new Error('only refining pitches can be released');
  if (by !== 'primary' && p.refinedBy !== by) {
    throw new Error('only ' + p.refinedBy + ' (or the admin token) can release this pitch');
  }
  p.status = p.specSlug ? 'spec-ready' : 'open';
  p.refinedBy = null;
  p.updatedAt = new Date().toISOString();
  save(db);
  return p;
}

// Attach a spec post (a regular post with kind: spec). Refiner or admin only.
function attachSpec(id, { by, slug }) {
  const db = load();
  const p = db.pitches[id];
  if (!p) return null;
  if (p.status === 'graduated' || p.status === 'shelved') throw new Error('pitch is ' + p.status);
  if (by !== 'primary' && p.refinedBy !== by) {
    throw new Error('only ' + p.refinedBy + ' (or the admin token) can attach a spec');
  }
  const s = String(slug || '').trim();
  if (!/^[a-z0-9][a-z0-9-]*$/.test(s)) throw new Error('spec slug looks invalid');
  const now = new Date().toISOString();
  p.specSlug = s;
  if (p.status !== 'spec-ready') {
    p.status = 'spec-ready';
    p.specAt = now;
  }
  p.updatedAt = now;
  save(db);
  return p;
}

// The human blessing. Admin token only — agents cannot graduate their own
// specs. Creates the build task automatically (spec is the detail).
function graduatePitch(id, { taskBoard }) {
  const db = load();
  const p = db.pitches[id];
  if (!p) return null;
  if (p.status !== 'spec-ready') throw new Error('only spec-ready pitches can graduate — attach a spec first');
  p.status = 'graduated';
  p.graduatedAt = new Date().toISOString();
  p.updatedAt = p.graduatedAt;
  if (taskBoard && typeof taskBoard.addTask === 'function') {
    const t = taskBoard.addTask({
      title: 'implement: ' + p.title,
      detail: 'spec: /posts/' + p.specSlug + '.html' + (p.idea ? '\n\noriginal pitch: ' + p.idea.slice(0, 1000) : ''),
      createdBy: 'human',
    });
    p.graduatedTo = t.id;
  }
  save(db);
  return p;
}

function shelvePitch(id, { by, reason }) {
  const db = load();
  const p = db.pitches[id];
  if (!p) return null;
  if (p.status === 'graduated' || p.status === 'shelved') throw new Error('pitch is already ' + p.status);
  if (by !== 'primary' && p.createdBy !== by && p.refinedBy !== by) {
    throw new Error('only ' + p.createdBy + ' (or the admin token) can shelve this pitch');
  }
  p.status = 'shelved';
  p.shelvedReason = clean(reason, MAX_REASON) || null;
  p.updatedAt = new Date().toISOString();
  save(db);
  return p;
}

module.exports = {
  FILE, STATUSES, MAX_TITLE, MAX_IDEA,
  addPitch, getPitch, listPitches, countsByStatus,
  refinePitch, releasePitch, attachSpec, graduatePitch, shelvePitch,
};
