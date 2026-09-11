'use strict';
// Shared task board for agent-hub: agents create, claim, and finish tasks
// through the collector API so nobody duplicates work. Claims are pinned to
// the token's identity (hard attribution — the same model as posts), so
// "who took this" is provable. Durable JSON persistence at state/tasks.json,
// atomic writes, no dependencies.

const fs = require('fs');
const crypto = require('crypto');

const paths = require('./paths');
const FILE = paths.durableFile('tasks.json');

const MAX_TITLE = 200;
const MAX_DETAIL = 2000;
const MAX_RESULT = 500;
const MAX_TASKS = 500;

// ---- persistence (write-to-temp + rename = atomic, mirrors questions.js) ----

function ensureState() {
  paths.ensureState();
}

function save(db) {
  ensureState();
  const tmp = FILE + '.tmp-' + process.pid;
  fs.writeFileSync(tmp, JSON.stringify(db, null, 2) + '\n', { mode: 0o600 });
  fs.renameSync(tmp, FILE);
  cache = db;
  try { cacheMtime = fs.statSync(FILE).mtimeMs; } catch { cacheMtime = 0; }
}

let cache = null;
let cacheMtime = 0;

// Reload whenever the file changes on disk (CLI edits, other processes),
// same pattern as the token registry and the questions board.
function load() {
  let mtime = 0;
  try { mtime = fs.statSync(FILE).mtimeMs; } catch { /* first run */ }
  if (cache && mtime === cacheMtime) return cache;
  let db = { tasks: {} };
  try {
    db = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    if (!db.tasks || typeof db.tasks !== 'object') db = { tasks: {} };
  } catch { /* first run */ }
  cache = db;
  cacheMtime = mtime;
  return db;
}

function newId() {
  return 't-' + Date.now().toString(36) + '-' + crypto.randomBytes(3).toString('hex');
}

function clean(s, max) {
  return String(s == null ? '' : s).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').trim().slice(0, max);
}

// ---- operations ----

function getTask(id) {
  return load().tasks[id] || null;
}

// status: 'open' | 'claimed' | 'done' | 'all' (default all). Recently
// updated first.
function listTasks(status) {
  const which = status || 'all';
  const rows = Object.values(load().tasks)
    .filter((t) => (which === 'all' ? true : t.status === which))
    .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
  return prune(rows);
}

// Keep the board bounded: oldest done tasks fall off first; open/claimed
// tasks are never pruned.
function prune(rows) {
  const db = load();
  const all = Object.values(db.tasks);
  if (all.length <= MAX_TASKS) return rows;
  const oldest = [...all]
    .sort((a, b) => String(a.updatedAt).localeCompare(String(b.updatedAt)))
    .filter((t) => t.status === 'done')
    .slice(0, all.length - MAX_TASKS);
  for (const t of oldest) delete db.tasks[t.id];
  return rows.filter((t) => db.tasks[t.id]);
}

function countsByStatus() {
  const out = { open: 0, claimed: 0, done: 0 };
  for (const t of Object.values(load().tasks)) if (out[t.status] !== undefined) out[t.status]++;
  return out;
}

function addTask({ title, detail, createdBy }) {
  const titleClean = clean(title, MAX_TITLE);
  if (!titleClean) throw new Error('title is required');
  const db = load();
  const now = new Date().toISOString();
  const entry = {
    id: newId(),
    title: titleClean,
    detail: clean(detail, MAX_DETAIL) || null,
    status: 'open',
    createdBy: String(createdBy || 'unknown').slice(0, 60),
    claimedBy: null,
    claimedAt: null,
    doneAt: null,
    result: null,
    createdAt: now,
    updatedAt: now,
  };
  db.tasks[entry.id] = entry;
  save(db);
  return entry;
}

function claimTask(id, { by }) {
  const db = load();
  const t = db.tasks[id];
  if (!t) return null;
  if (t.status !== 'open') throw new Error('task is ' + t.status + (t.claimedBy ? ' (held by ' + t.claimedBy + ')' : '') + ' — release it first');
  const now = new Date().toISOString();
  t.status = 'claimed';
  t.claimedBy = String(by || 'unknown').slice(0, 60);
  t.claimedAt = now;
  t.updatedAt = now;
  save(db);
  return t;
}

function releaseTask(id, { by }) {
  const db = load();
  const t = db.tasks[id];
  if (!t) return null;
  if (t.status !== 'claimed') throw new Error('only claimed tasks can be released');
  if (by !== 'primary' && t.claimedBy !== by) {
    throw new Error('only ' + t.claimedBy + ' (or the admin token) can release this task');
  }
  t.status = 'open';
  t.claimedBy = null;
  t.claimedAt = null;
  t.updatedAt = new Date().toISOString();
  save(db);
  return t;
}

function completeTask(id, { by, result }) {
  const db = load();
  const t = db.tasks[id];
  if (!t) return null;
  if (t.status === 'done') throw new Error('task is already done');
  if (t.status !== 'claimed') throw new Error('claim the task before completing it');
  if (by !== 'primary' && t.claimedBy !== by) {
    throw new Error('only ' + t.claimedBy + ' (or the admin token) can complete this task');
  }
  t.status = 'done';
  t.doneAt = new Date().toISOString();
  t.updatedAt = t.doneAt;
  t.result = clean(result, MAX_RESULT) || null;
  save(db);
  return t;
}

function deleteTask(id, { by }) {
  const db = load();
  const t = db.tasks[id];
  if (!t) return null;
  if (by !== 'primary' && t.createdBy !== by) {
    throw new Error('only ' + t.createdBy + ' (or the admin token) can delete this task');
  }
  delete db.tasks[id];
  save(db);
  return t;
}

module.exports = {
  FILE, MAX_TITLE, MAX_DETAIL, MAX_RESULT,
  addTask, getTask, listTasks, countsByStatus,
  claimTask, releaseTask, completeTask, deleteTask,
};
