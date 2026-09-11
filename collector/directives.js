'use strict';
// Directives — the human -> fleet command channel for agent-hub.
//
// The human (primary/admin token) posts a steer targeted at the whole fleet
// (`global`), a task, or one agent. Agents see it in GET /api/work and move it
// through ack -> done (or the human dismisses it). Durable JSON persistence at
// state/directives.json, atomic writes, no dependencies.

const fs = require('fs');
const crypto = require('crypto');

const paths = require('./paths');
const FILE = paths.durableFile('directives.json');

const TARGETS = new Set(['global', 'task', 'agent']);
const STATUSES = new Set(['open', 'acked', 'done', 'dismissed']);
const MAX_TEXT = 1000;
const MAX_NOTE = 500;

// ---- persistence (write-to-temp + rename = atomic, mirrors tasks.js) ----

function ensureState() {
  paths.ensureState();
}

let cache = null;
let cacheMtime = 0;

function load() {
  let mtime = 0;
  try { mtime = fs.statSync(FILE).mtimeMs; } catch { /* first run */ }
  if (cache && mtime === cacheMtime) return cache;
  let db = { directives: {} };
  try {
    db = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    if (!db.directives || typeof db.directives !== 'object' || Array.isArray(db.directives)) db = { directives: {} };
  } catch { /* first run */ }
  cache = db;
  cacheMtime = mtime;
  return db;
}

function save(db) {
  ensureState();
  const tmp = FILE + '.tmp-' + process.pid;
  fs.writeFileSync(tmp, JSON.stringify(db, null, 2) + '\n', { mode: 0o600 });
  fs.renameSync(tmp, FILE);
  cache = db;
  try { cacheMtime = fs.statSync(FILE).mtimeMs; } catch { cacheMtime = 0; }
}

function newId() {
  return 'd-' + Date.now().toString(36) + '-' + crypto.randomBytes(3).toString('hex');
}

function clean(s, max) {
  return String(s == null ? '' : s).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').trim().slice(0, max);
}

// ---- operations ----

function addDirective({ text, target, taskId, agent, createdBy }) {
  const t = clean(text, MAX_TEXT);
  if (!t) throw new Error('text is required');
  const tg = TARGETS.has(target) ? target : 'global';
  const task = tg === 'task' ? clean(taskId, 100) : null;
  const who = tg === 'agent' ? clean(agent, 60) : null;
  if (tg === 'task' && !task) throw new Error('target "task" needs a taskId');
  if (tg === 'agent' && !who) throw new Error('target "agent" needs an agent name');
  const now = new Date().toISOString();
  const entry = {
    id: newId(),
    text: t,
    target: tg,
    taskId: task,
    agent: who,
    status: 'open',
    createdBy: String(createdBy || 'human').slice(0, 60),
    createdAt: now,
    updatedAt: now,
    acks: [],
    doneBy: null,
    doneAt: null,
    dismissedBy: null,
    dismissedAt: null,
  };
  const db = load();
  db.directives[entry.id] = entry;
  save(db);
  return entry;
}

function getDirective(id) {
  return load().directives[id] || null;
}

function listDirectives(filter) {
  const f = filter || {};
  let rows = Object.values(load().directives);
  if (f.status && f.status !== 'all') rows = rows.filter((d) => d.status === f.status);
  if (f.target) rows = rows.filter((d) => d.target === f.target);
  if (f.task) rows = rows.filter((d) => d.taskId === f.task);
  if (f.agent) rows = rows.filter((d) => d.agent === f.agent);
  const sinceTs = f.since && Number.isFinite(Date.parse(f.since)) ? Date.parse(f.since) : null;
  if (sinceTs != null) rows = rows.filter((d) => Date.parse(d.updatedAt) > sinceTs);
  rows.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  return rows;
}

// What one agent should see: everything global, targeted at them, or aimed at
// a task they currently lease — plus anything else that changed since `sinceTs`.
function forAgent(agent, taskIds, sinceTs) {
  const tasks = new Set(taskIds || []);
  return Object.values(load().directives)
    .filter((d) => {
      const relevant = d.target === 'global' ||
        (d.target === 'agent' && d.agent === agent) ||
        (d.target === 'task' && tasks.has(d.taskId));
      if (!relevant) return false;
      if (d.status === 'open' || d.status === 'acked') return true;
      return sinceTs != null && Date.parse(d.updatedAt) > sinceTs;
    })
    .map((d) => ({ ...d, ackedByMe: d.acks.some((a) => a.agent === agent) }))
    .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
}

function lifecycle(id, { action, by, note }) {
  const db = load();
  const d = db.directives[id];
  if (!d) return null;
  const now = new Date().toISOString();
  const n = clean(note, MAX_NOTE) || null;
  if (action === 'ack') {
    if (d.status === 'done' || d.status === 'dismissed') {
      throw Object.assign(new Error('directive is already ' + d.status), { status: 409 });
    }
    if (!d.acks.some((a) => a.agent === by)) d.acks.push({ agent: by, at: now, note: n });
    d.status = 'acked';
  } else if (action === 'done') {
    if (d.status === 'dismissed') throw Object.assign(new Error('directive is dismissed'), { status: 409 });
    d.status = 'done';
    d.doneBy = by;
    d.doneAt = now;
  } else if (action === 'dismiss') {
    d.status = 'dismissed';
    d.dismissedBy = by;
    d.dismissedAt = now;
  } else {
    throw new Error('unknown directive action');
  }
  d.updatedAt = now;
  save(db);
  return d;
}

function counts() {
  const out = { open: 0, acked: 0, done: 0, dismissed: 0, total: 0 };
  for (const d of Object.values(load().directives)) {
    if (out[d.status] !== undefined) out[d.status]++;
    out.total++;
  }
  return out;
}

module.exports = {
  FILE, TARGETS, STATUSES, MAX_TEXT, MAX_NOTE,
  addDirective, getDirective, listDirectives, forAgent, lifecycle, counts,
};
