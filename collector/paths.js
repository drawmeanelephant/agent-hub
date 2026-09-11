'use strict';
// Shared path resolution for agent-hub.
//
// Durable coordination memory lives in state/ — tasks, pitches, questions,
// the roster, and identity/tokens — and MUST survive `rm -rf .runtime`.
// Disposable caches, logs, pids and trash stay in .runtime/.
//
// On first require this module runs a one-time, locked migration that moves a
// pre-split install's durable files out of .runtime/ and into state/. It is
// idempotent: once state/.layout exists it is a no-op. See the state-split
// spec in the hub's idea lab for the full contract.

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

let CFG = { stateDir: 'state', runtimeDir: '.runtime' };
try {
  CFG = { ...CFG, ...JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json'), 'utf8')) };
} catch { /* defaults are fine */ }

const RUN_DIR = path.join(ROOT, CFG.runtimeDir || '.runtime');
const STATE_DIR = path.join(ROOT, CFG.stateDir || 'state');

// Files that hold fleet memory. Everything else under RUN_DIR is disposable.
const DURABLE = ['tasks.json', 'pitches.json', 'questions.json', 'agents.json', 'tokens.json', 'upload-token', 'leases.json', 'directives.json'];

let lastMigration = [];

function ensureState() { fs.mkdirSync(STATE_DIR, { recursive: true }); }
function ensureRuntime() { fs.mkdirSync(RUN_DIR, { recursive: true }); }

// Canonical (durable) path for a state file. Always writes here post-migration.
function durableFile(name) { return path.join(STATE_DIR, name); }

function sleep(ms) {
  try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); }
  catch { const end = Date.now() + ms; while (Date.now() < end) { /* spin fallback */ } }
}

// One-time, idempotent, lock-guarded move of durable files .runtime/ -> state/.
// Never overwrites a file that already exists in state/ (state wins).
function migrate() {
  ensureState();
  ensureRuntime();

  const layout = path.join(STATE_DIR, '.layout');
  if (fs.existsSync(layout)) return lastMigration;

  const lock = path.join(STATE_DIR, '.migrate.lock');
  let fd = null;
  try {
    fd = fs.openSync(lock, 'wx', 0o600);
  } catch (e) {
    if (e.code !== 'EEXIST') throw e;
    // Another process is migrating — wait for its layout marker.
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline) {
      if (fs.existsSync(layout)) return lastMigration;
      sleep(50);
    }
    throw new Error('state migration lock held by another process (state/.migrate.lock)');
  }

  try {
    const moved = [];
    for (const f of DURABLE) {
      const to = path.join(STATE_DIR, f);
      const from = path.join(RUN_DIR, f);
      if (fs.existsSync(to)) continue;   // state wins, never overwrite
      if (fs.existsSync(from)) { fs.renameSync(from, to); moved.push(f); }
    }
    lastMigration = moved;
    // Record the move in the activity log directly (paths.js can't require
    // store.js without a cycle), so the process that migrated reports it.
    if (moved.length) {
      try {
        fs.appendFileSync(path.join(RUN_DIR, 'events.jsonl'),
          JSON.stringify({ ts: new Date().toISOString(), agent: 'hub', type: 'hub', message: 'state migration: .runtime/ -> state/ (' + moved.join(', ') + ')' }) + '\n');
      } catch { /* best-effort */ }
    }
    fs.writeFileSync(layout, JSON.stringify({ layout: 'state-split/1', migratedAt: new Date().toISOString(), moved }) + '\n', { mode: 0o600 });
  } finally {
    if (fd !== null) { try { fs.closeSync(fd); } catch { /* ignore */ } }
    try { fs.unlinkSync(lock); } catch { /* ignore */ }
  }
  return lastMigration;
}

migrate();

module.exports = {
  ROOT, RUN_DIR, STATE_DIR, DURABLE,
  ensureState, ensureRuntime, durableFile,
  migrate,
  migration: () => lastMigration,
};
