'use strict';
// Questions-for-humans board for agent-hub: agents POST questions through the
// collector API, the human answers them (dashboard or this CLI). JSON
// persistence at .runtime/questions.json, atomic writes, no dependencies.
//
// CLI (for the human, from the agent-hub folder):
//   node collector/questions.js list [--all]
//   node collector/questions.js answer <id> "the answer text"

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.resolve(__dirname, '..');
const RUNTIME = path.join(ROOT, '.runtime');
const FILE = path.join(RUNTIME, 'questions.json');

const MAX_QUESTION = 2000;
const MAX_CONTEXT = 4000;
const MAX_ANSWER = 4000;

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
  try { cacheMtime = fs.statSync(FILE).mtimeMs; } catch { cacheMtime = 0; }
}

let cache = null;
let cacheMtime = 0;

// Reload whenever the file changes on disk (e.g. the CLI answered a question
// while the collector is up), so both processes see the same board.
function load() {
  let mtime = 0;
  try { mtime = fs.statSync(FILE).mtimeMs; } catch { /* first run */ }
  if (cache && mtime === cacheMtime) return cache;
  let db = { questions: [] };
  try {
    db = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    if (!Array.isArray(db.questions)) db = { questions: [] };
  } catch { /* first run */ }
  cache = db;
  cacheMtime = mtime;
  return db;
}

function newId() {
  return 'q-' + Date.now().toString(36) + '-' + crypto.randomBytes(3).toString('hex');
}

// ---- operations ----

function clean(s, max) {
  return String(s == null ? '' : s).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').trim().slice(0, max);
}

function addQuestion({ agent, question, context }) {
  const q = clean(question, MAX_QUESTION);
  if (!q) throw new Error('question is required');
  const db = load();
  const entry = {
    id: newId(),
    agent: String(agent || 'unknown').slice(0, 60),
    question: q,
    context: clean(context, MAX_CONTEXT) || null,
    status: 'open',
    askedAt: new Date().toISOString(),
    answeredAt: null,
    answer: null,
  };
  db.questions.push(entry);
  save(db);
  return entry;
}

function getQuestion(id) {
  return load().questions.find((q) => q.id === id) || null;
}

function openCount() {
  return load().questions.filter((q) => q.status === 'open').length;
}

// status: 'open' | 'answered' | 'all' (default open). Newest first.
function listQuestions(status) {
  const which = status || 'open';
  return load().questions
    .filter((q) => (which === 'all' ? true : q.status === which))
    .sort((a, b) => String(b.askedAt).localeCompare(String(a.askedAt)));
}

function answerQuestion(id, { answer, by }) {
  const db = load();
  const q = db.questions.find((x) => x.id === id);
  if (!q) return null;
  const a = clean(answer, MAX_ANSWER);
  if (!a) throw new Error('answer text is required');
  q.answer = a;
  q.answeredBy = String(by || 'human').slice(0, 60);
  q.status = 'answered';
  q.answeredAt = new Date().toISOString();
  save(db);
  return q;
}

// ---- CLI for the human ----

function rel(iso) {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return iso || '–';
  const s = Math.max(0, (Date.now() - t) / 1000);
  if (s < 90) return 'just now';
  if (s < 3600) return Math.round(s / 60) + 'm ago';
  if (s < 86400) return Math.round(s / 3600) + 'h ago';
  return Math.round(s / 86400) + 'd ago';
}

function cli(argv) {
  const [cmd, ...rest] = argv;
  if (cmd === 'list') {
    const all = rest.includes('--all') || rest.includes('-a');
    const rows = listQuestions(all ? 'all' : 'open');
    const open = openCount();
    console.log(open + ' open question' + (open === 1 ? '' : 's') + (all ? ' (showing all)' : '') + '\n');
    if (!rows.length) { console.log('nothing here — the board is clear'); return 0; }
    for (const q of rows) {
      console.log('[' + q.status.toUpperCase() + '] ' + q.id + '  by ' + q.agent + '  ' + rel(q.askedAt));
      console.log('  Q: ' + q.question.replace(/\s+/g, ' ').slice(0, 160));
      if (q.context) console.log('  ctx: ' + q.context.replace(/\s+/g, ' ').slice(0, 160));
      if (q.status === 'answered') console.log('  A: ' + String(q.answer).replace(/\s+/g, ' ').slice(0, 160) + '  (' + rel(q.answeredAt) + ')');
      console.log('');
    }
    return 0;
  }
  if (cmd === 'answer') {
    const [id, ...textParts] = rest;
    const text = textParts.join(' ');
    if (!id || !text) {
      console.log('usage: node collector/questions.js answer <id> "the answer text"');
      return 1;
    }
    const q = answerQuestion(id, { answer: text, by: 'human' });
    if (!q) { console.log('no question with id ' + id); return 1; }
    console.log('answered ' + q.id + ' — the asking agent (' + q.agent + ') will see it via GET /api/questions');
    return 0;
  }
  console.log('usage:\n  node collector/questions.js list [--all]\n  node collector/questions.js answer <id> "the answer text"');
  return 1;
}

if (require.main === module) process.exit(cli(process.argv.slice(2)));

module.exports = {
  FILE, MAX_QUESTION, MAX_CONTEXT, MAX_ANSWER,
  addQuestion, getQuestion, listQuestions, openCount, answerQuestion,
};
