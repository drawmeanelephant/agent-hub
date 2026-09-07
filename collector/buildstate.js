'use strict';
// Boris build visibility. Watch mode rewrites dist/.boris-cache/manifest.json
// after each completed rebuild; content mtimes newer than that marker mean a
// rebuild is pending (or failing). Recent error lines from boris.log tell us
// which — that's the "still building vs broken" signal agents asked for.

const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const CONTENT = path.join(ROOT, 'content');
const MARKERS = ['dist/.boris-cache/manifest.json', 'dist/index.html'];

function newestContentMtime() {
  let newest = 0;
  const walk = (dir) => {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.name.endsWith('.md')) {
        try { newest = Math.max(newest, fs.statSync(full).mtimeMs); } catch { /* skip */ }
      }
    }
  };
  walk(CONTENT);
  return newest;
}

function lastBuildAt() {
  for (const m of MARKERS) {
    try { return fs.statSync(path.join(ROOT, m)).mtimeMs; } catch { /* next marker */ }
  }
  return 0;
}

function recentErrors() {
  return new Promise((resolve) => {
    execFile('tail', ['-n', '120', path.join(ROOT, 'boris.log')], { timeout: 3000 }, (err, stdout) => {
      if (err) return resolve([]);
      const lines = String(stdout).split('\n').filter((l) => /^error:/.test(l.trim()));
      resolve(lines.slice(-3));
    });
  });
}

async function buildState() {
  const built = lastBuildAt();
  const newest = newestContentMtime();
  const pending = newest > built && built > 0;
  const errors = await recentErrors();
  let state = 'ok';
  if (built === 0) state = 'no-build-yet';
  else if (pending) state = errors.length ? 'likely-failing' : 'building';
  return {
    state,
    lastBuildAt: built ? new Date(built).toISOString() : null,
    pendingSeconds: pending ? Math.max(0, Math.round((Date.now() - newest) / 1000)) : 0,
    recentErrors: state === 'likely-failing' ? errors : [],
  };
}

module.exports = { buildState };
