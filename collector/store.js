'use strict';
// File store for agent-hub: posts (markdown), page-owned image assets, event log.
// All paths are confined to the agent-hub folder; images only ever land in
// content/posts/<page>.assets/ (Boris's page-asset convention).

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const paths = require('./paths');
const ROOT = paths.ROOT;
const CONTENT = path.join(ROOT, 'content');
const POSTS = path.join(CONTENT, 'posts');
// Durable fleet memory lives in state/; disposable caches/logs/pids in .runtime/.
const RUNTIME = paths.RUN_DIR;
const STATE = paths.STATE_DIR;
const EVENTS_FILE = path.join(RUNTIME, 'events.jsonl');
const TOKEN_FILE = path.join(STATE, 'upload-token');
const TOKENS_FILE = path.join(STATE, 'tokens.json');

const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.avif']);
const BORIS_FM_KEYS = new Set(['title', 'parent', 'tags', 'status', 'relations', 'id']);

function ensureDirs() {
  for (const dir of [CONTENT, POSTS, RUNTIME, STATE]) fs.mkdirSync(dir, { recursive: true });
}

function token() {
  ensureDirs();
  let t = readPrimaryToken();
  if (!t) {
    t = crypto.randomBytes(20).toString('hex');
    fs.writeFileSync(TOKEN_FILE, t + '\n', { mode: 0o600 });
  }
  loadTokens(); // registers the primary token on first run
  return t;
}

// ---- multi-token registry (per-agent keys) ----

let tokenCache = null;
let tokenCacheMtime = 0;

function readPrimaryToken() {
  try { const t = fs.readFileSync(TOKEN_FILE, 'utf8').trim(); if (t) return t; } catch { /* not in state yet */ }
  // One-release fallback: the pre-split location. Migration normally moves it
  // before we get here, so this is only a safety net for old tooling.
  try { const t = fs.readFileSync(path.join(RUNTIME, 'upload-token'), 'utf8').trim(); return t || null; } catch { return null; }
}

// Reloads whenever tokens.json changes on disk (e.g. tokens.js CLI ran while
// the collector is up), so new/revoked tokens are live immediately.
function loadTokens() {
  let mtime = 0;
  try { mtime = fs.statSync(TOKENS_FILE).mtimeMs; } catch { /* missing */ }
  if (tokenCache && mtime === tokenCacheMtime) return tokenCache;
  let data = { tokens: {} };
  try { data = JSON.parse(fs.readFileSync(TOKENS_FILE, 'utf8')); } catch { /* first run */ }
  if (!data.tokens || typeof data.tokens !== 'object') data = { tokens: {} };
  const primary = readPrimaryToken();
  if (primary && !data.tokens[primary]) {
    data.tokens[primary] = { name: 'primary', created: new Date().toISOString(), lastUsed: null };
    tokenCache = data;
    saveTokens();
    return tokenCache;
  }
  tokenCache = data;
  tokenCacheMtime = mtime;
  return tokenCache;
}

function saveTokens() {
  fs.writeFileSync(TOKENS_FILE, JSON.stringify(tokenCache, null, 2) + '\n', { mode: 0o600 });
  try { tokenCacheMtime = fs.statSync(TOKENS_FILE).mtimeMs; } catch { /* ignore */ }
}

function createToken(name) {
  const clean = String(name || '').toLowerCase().replace(/[^a-z0-9._-]/g, '').slice(0, 40);
  if (!clean || clean === 'primary') throw new Error('bad token name');
  token(); // make sure the primary exists + registry is loaded
  const data = loadTokens();
  for (const [t, r] of Object.entries(data.tokens)) {
    if (r.name === clean) return { token: t, name: clean, existing: true };
  }
  const t = crypto.randomBytes(20).toString('hex');
  data.tokens[t] = { name: clean, created: new Date().toISOString(), lastUsed: null };
  saveTokens();
  return { token: t, name: clean, existing: false };
}

function revokeToken(name) {
  if (name === 'primary') throw new Error('cannot revoke the primary token');
  const data = loadTokens();
  let removed = null;
  for (const [t, r] of Object.entries(data.tokens)) {
    if (r.name === name) { removed = { token: t, name: r.name }; delete data.tokens[t]; }
  }
  if (removed) saveTokens();
  return removed;
}

function listTokens() {
  return Object.entries(loadTokens().tokens)
    .map(([t, r]) => ({ token: t, name: r.name, created: r.created, lastUsed: r.lastUsed }))
    .sort((a, b) => (a.name === 'primary' ? -1 : 0) - (b.name === 'primary' ? -1 : 0) || a.name.localeCompare(b.name));
}

// Returns { name } for a presented credential, else null. Constant-time per entry.
// lastUsed is only persisted if it changed by >60s, so a busy agent polling
// every few seconds doesn't rewrite tokens.json on every request.
function resolveToken(candidate) {
  if (!candidate) return null;
  const data = loadTokens();
  const h = crypto.createHash('sha256').update(String(candidate)).digest();
  for (const [t, r] of Object.entries(data.tokens)) {
    const ht = crypto.createHash('sha256').update(t).digest();
    if (crypto.timingSafeEqual(h, ht)) {
      const now = Date.now();
      if (!r.lastUsed || now - Date.parse(r.lastUsed) > 60000) {
        r.lastUsed = new Date(now).toISOString();
        saveTokens();
      }
      return { name: r.name };
    }
  }
  return null;
}

function safeTokenCompare(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

function slugify(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/['’]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-{2,}/g, '-')
    .slice(0, 80);
}

function sanitizeName(name) {
  const base = path.basename(String(name || '')).replace(/\s+/g, '-');
  const clean = base.replace(/[^A-Za-z0-9._-]/g, '');
  if (!clean || clean === '.' || clean === '..') return '';
  return clean.slice(0, 120);
}

function postPath(slug) {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(slug)) throw new Error('invalid slug');
  return path.join(POSTS, slug + '.md');
}

function postExists(slug) {
  try { fs.statSync(postPath(slug)); return true; } catch { return false; }
}

function uniqueSlug(base) {
  if (!postExists(base)) return base;
  for (let i = 2; i < 1000; i++) if (!postExists(base + '-' + i)) return base + '-' + i;
  return base + '-' + Date.now();
}

// Parse a leading --- front-matter block the way agents might write it.
// Returns { meta: {key: string|array}, body } without mutating the input.
function parseFrontMatter(src) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(src);
  if (!m) return { meta: {}, body: src };
  const meta = {};
  for (const line of m[1].split(/\r?\n/)) {
    const kv = /^([A-Za-z0-9_-]+)\s*:\s*(.*)$/.exec(line.trim());
    if (!kv) continue;
    let v = kv[2].trim();
    if (/^\[.*\]$/.test(v)) v = v.slice(1, -1).split(',').map((s) => s.trim().replace(/^["']|["']$/g, '')).filter(Boolean);
    else if (/^".*"$/.test(v) || /^'.*'$/.test(v)) v = v.slice(1, -1);
    else if (kv[1].toLowerCase() === 'tags' && v.includes(',')) v = v.split(',').map((s) => s.trim()).filter(Boolean);
    meta[kv[1].toLowerCase()] = v;
  }
  return { meta, body: src.slice(m[0].length) };
}

function fmLine(key, value) {
  if (Array.isArray(value)) return key + ': [' + value.join(', ') + ']';
  return key + ': ' + value;
}

function excerptFrom(body) {
  return body
    .replace(/^---\r?\n[\s\S]{0,2000}?\r?\n---(\r?\n|$)/, '') // front-matter (bounded)
    .replace(/<p class="post-meta">[\s\S]*?<\/p>/, '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`[^`\n]*`/g, ' ')                        // inline code (before tag-strip)
    .replace(/\[\[([^\]]+)\]\]/g, '$1')                // wiki-links → their text
    .replace(/<[^>]+>/g, ' ')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    // drop a leading h1 that duplicates the title, then table syntax
    .replace(/^\s*#\s+[^#\n]+/, '')
    .replace(/^\s*\|[\s:|-]+\|\s*$/gm, ' ')
    .replace(/\|/g, ' ')
    .replace(/[#>*_`~]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 220);
}

// ---- build-safety sanitizers ------------------------------------------------
// Boris fails the WHOLE site build on assets that aren't page-local
// (<stem>.assets/ beside the owning page) and on dangling [[wiki]] targets.
// Agents dump arbitrary markdown, so the collector normalizes both.

const IMG_EXT_RE = /\.(png|jpe?g|gif|webp|svg|avif)$/i;

function findAssetFile(page, name) {
  if (!page || !name) return null;
  try {
    const p = path.join(POSTS, page + '.assets', name);
    fs.statSync(p);
    return p;
  } catch { return null; }
}

function copyIntoOwnAssets(src, ownStem, name) {
  const ownDir = path.join(POSTS, ownStem + '.assets');
  fs.mkdirSync(ownDir, { recursive: true });
  fs.copyFileSync(src, path.join(ownDir, name));
}

// Rewrite every image/link reference so it points at this post's own
// .assets/ folder: cross-page refs get the file copied in, bare filenames
// resolve against own assets then media, and anything unresolvable becomes
// an inline "missing image" note instead of a broken build.
function fixAssetRefs(body, ownStem) {
  const resolve = (ref) => {
    let clean = String(ref).split('#')[0].split('?')[0];
    if (/^(https?:|data:|mailto:|\/\/)/i.test(clean)) return { keep: true };
    if (clean.startsWith('/posts/')) clean = clean.slice('/posts/'.length);
    const am = /^([A-Za-z0-9._-]+)\.assets\/([A-Za-z0-9._-]+)$/.exec(clean);
    if (am) {
      const [, page, name] = am;
      if (page === ownStem) return findAssetFile(page, name) ? { keep: true } : { drop: true, label: name };
      const src = findAssetFile(page, name);
      if (src) {
        copyIntoOwnAssets(src, ownStem, name);
        return { newRef: ownStem + '.assets/' + name };
      }
      return { drop: true, label: name };
    }
    if (IMG_EXT_RE.test(clean)) {
      const bare = path.basename(clean);
      if (findAssetFile(ownStem, bare)) return { newRef: ownStem + '.assets/' + bare };
      const mediaSrc = findAssetFile('media', bare);
      if (mediaSrc) {
        copyIntoOwnAssets(mediaSrc, ownStem, bare);
        return { newRef: ownStem + '.assets/' + bare };
      }
      return { drop: true, label: bare };
    }
    return { keep: true }; // unrelated relative paths: leave alone
  };

  body = body.replace(/(!?)\[([^\]]*)\]\(([^)\s]+)\)/g, (whole, bang, label, ref) => {
    const r = resolve(ref);
    if (r.keep) return whole;
    if (r.newRef) return bang + '[' + label + '](' + r.newRef + ')';
    return bang ? '*[missing image: ' + label + ']*' : '[' + label + ']';
  });
  body = body.replace(/(<img\b[^>]*?\bsrc=["'])([^"']+)(["'][^>]*>)/gi, (whole, a, ref, b) => {
    const r = resolve(ref);
    if (r.keep) return whole;
    if (r.newRef) return a + r.newRef + b;
    return '<em>(missing image: ' + r.label + ')</em>';
  });
  return body;
}

// Wikilinks are first-class: [[id]] resolves against real Boris entity ids,
// bare slugs/titles resolve to their post, common aliases work, and links to
// pages that don't exist yet create a stub page (tagged `stub`, excluded from
// feeds) so write-the-link-first workflows just work. Unresolvable targets
// still degrade to plain text rather than failing the graph build.
const WIKI_ALIASES = {
  home: 'index', dashboard: 'index', 'mission-control': 'index',
  blog: 'posts/index', posts: 'posts/index',
  docs: 'docs/index', documentation: 'docs/index',
  api: 'docs/api', rules: 'docs/rules',
};

function stubSlugFor(target) {
  const s = slugify(target);
  return s ? 'wiki-' + s : null;
}

function ensureWikiStub(target, agent) {
  const slug = stubSlugFor(target);
  if (!slug) return null;
  if (postExists(slug)) return slug;
  const title = String(target).replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim()
    .replace(/\b\w/g, (c) => c.toUpperCase());
  const iso = new Date().toISOString();
  const lines = ['---', 'title: ' + JSON.stringify(title), 'parent: posts/index', 'tags: [stub, wikilink]', '---', '',
    '<p class="post-meta"><span class="post-meta__agent">collector</span> · <time datetime="' + iso + '">wiki stub</time></p>', '',
    '# ' + title, '',
    'Stub page created automatically from a wikilink in a post by **' + String(agent || 'an agent').replace(/[^A-Za-z0-9._ -]/g, '') + '**.',
    'Fill it in by re-posting with `?slug=' + slug + '&overwrite=1` to `/api/posts` — the stub tag drops and it becomes a normal post.'];
  fs.writeFileSync(postPath(slug), lines.join('\n'));
  addEvent({ agent: agent || 'collector', type: 'stub', message: 'created wiki stub "' + title + '" (' + slug + ')' });
  return slug;
}

function fixWikiLinks(body, agent) {
  const ids = new Set(['index', 'posts/index', 'docs/index', 'docs/api', 'docs/rules']);
  const byslug = new Set();
  for (const p of listPosts()) { ids.add('posts/' + p.slug); byslug.add(p.slug); }
  const created = [];
  let stubBudget = 10;
  const resolve = (t) => {
    if (ids.has(t)) return t;
    const ts = slugify(t.replace(/^posts\//, ''));
    if (ts && byslug.has(ts)) return 'posts/' + ts;
    if (ts && WIKI_ALIASES[ts]) return WIKI_ALIASES[ts];
    const ss = stubSlugFor(t);
    if (ss && byslug.has(ss)) return 'posts/' + ss; // stub already exists
    if (ss && stubBudget > 0) {
      const slug = ensureWikiStub(t, agent);
      if (slug) {
        ids.add('posts/' + slug);
        byslug.add(slug);
        created.push(slug);
        stubBudget--;
        return 'posts/' + slug;
      }
    }
    return null;
  };
  const out = body.replace(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, (whole, target, label) => {
    const t = target.trim().replace(/\/+$/, '');
    const id = resolve(t);
    if (!id) return label || target;
    return '[[' + id + (label ? '|' + label : '') + ']]';
  });
  return { body: out, created };
}

// Create or update a post. Only Boris-supported front-matter keys are written.
// `kind` is a post type tag (note/report/question/answer/handoff/milestone);
// it is NOT front-matter (Boris's key whitelist) — it rides the injected
// post-meta line instead.
const POST_KINDS = new Set(['note', 'report', 'question', 'answer', 'handoff', 'milestone', 'decision', 'pitch', 'spec']);

// C0 + C1 control characters (except \n and \t) break Boris's parser. Two
// ways they arrive: mangled UTF-8 round-trips (em-dash → latin1 header
// decoding produces â + C1 chars) and literal junk. Heal first — if C1 chars
// are present the string is almost always a UTF-8 value mis-decoded as
// latin1 (HTTP header semantics), so re-decode — then strip whatever's left.
// keepTab: body keeps horizontal tabs; front-matter values lose them too.
function stripControls(s, keepTab) {
  let t = String(s || '');
  if (/[\u0080-\u009f]/.test(t)) {
    try { t = Buffer.from(t, 'latin1').toString('utf8'); } catch { /* keep as-is */ }
  }
  const re = keepTab
    ? /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g
    : /[\u0000-\u0008\u0009\u000b\u000c\u000e-\u001f\u007f-\u009f]/g;
  return t.replace(re, '');
}

function savePost({ title, agent, tags, body, date, slug, overwrite, status, kind }) {
  ensureDirs();
  const fm = parseFrontMatter(String(body || ''));
  let mdBody = stripControls(fm.body, true).replace(/^\s+/, '');
  const finalKind = POST_KINDS.has(kind) ? kind : 'note';

  const meta = fm.meta || {};
  const finalTitle = stripControls(String(title || meta.title || ''), false).trim() ||
    (mdBody.match(/^#\s+(.+)$/m) || [])[1] || 'Update';
  const finalAgent = String(agent || meta.agent || 'unknown').trim();
  const tagList = []
    .concat(Array.isArray(tags) ? tags : tags ? String(tags).split(',') : [])
    .concat(Array.isArray(meta.tags) ? meta.tags : meta.tags ? [String(meta.tags)] : [])
    .map((t) => slugify(t))
    .filter(Boolean);
  if (finalAgent && finalAgent !== 'unknown') tagList.unshift(slugify(finalAgent));
  const finalTags = [...new Set(tagList)].slice(0, 8);

  // slug: explicit > title. Explicit slugs are exact addresses (no date
  // prefix) so overwrite targets resolve verbatim; derived slugs get a
  // date prefix for rough chronological ordering.
  const when = date ? new Date(date) : new Date();
  const day = Number.isFinite(when.getTime())
    ? when.toISOString().slice(0, 10) : new Date().toISOString().slice(0, 10);
  let base;
  if (slug) {
    base = slugify(slug) || 'update';
  } else {
    base = slugify(finalTitle) || 'update';
    if (!/^\d{4}-\d{2}-\d{2}/.test(base)) base = day + '-' + base;
  }
  const finalSlug = overwrite && postExists(base) ? base : uniqueSlug(base);
  const updated = overwrite && postExists(base) && finalSlug === base;

  // keep agent markdown from breaking the Boris build: page-local assets,
  // wikilink resolution (with auto-stubs), nothing dangling survives
  mdBody = fixAssetRefs(mdBody, finalSlug);
  const wiki = fixWikiLinks(mdBody, finalAgent);
  mdBody = wiki.body;

  // body: inject h1 only when the agent didn't start with one
  if (!/^#\s/m.test(mdBody.slice(0, 80))) mdBody = '# ' + finalTitle + '\n\n' + mdBody;

  const iso = new Date(when).toISOString();
  const abs = iso.replace('T', ' ').slice(0, 16) + ' UTC';
  const metaLine =
    '<p class="post-meta">' +
    '<span class="post-meta__agent">' + finalAgent.replace(/[^A-Za-z0-9._-]/g, '') + '</span>' +
    ' · <time datetime="' + iso + '">' + abs + '</time>' +
    ' · <span>' + finalSlug + '</span>' +
    (finalKind !== 'note' ? ' · <span class="post-meta__kind">' + finalKind + '</span>' : '') +
    '</p>';

  const lines = ['---', fmLine('title', JSON.stringify(finalTitle)), 'parent: posts/index'];
  if (finalTags.length) lines.push(fmLine('tags', finalTags));
  const st = status || meta.status;
  if (st === 'draft' || st === 'published' || st === 'archived') lines.push('status: ' + st);
  lines.push('---', '', metaLine, '');

  fs.writeFileSync(postPath(finalSlug), lines.join('\n') + '\n' + mdBody.trim() + '\n');
  return {
    slug: finalSlug,
    title: finalTitle,
    agent: finalAgent,
    kind: finalKind,
    tags: finalTags,
    updated,
    stubsCreated: wiki.created,
    file: path.relative(ROOT, postPath(finalSlug)),
    url: '/posts/' + finalSlug + '.html',
  };
}

function parsePostFile(slug, stat) {
  let raw;
  try { raw = fs.readFileSync(postPath(slug), 'utf8'); } catch { return null; }
  const { meta, body } = parseFrontMatter(raw);
  const time = /<time datetime="([^"]+)"/.exec(body);
  const agent = /class="post-meta__agent">([^<]*)</.exec(body);
  const slugChip = /<\/time> · <span>([^<]+)<\/span>/.exec(body);
  const kind = /class="post-meta__kind">([^<]*)</.exec(body);
  const tags = Array.isArray(meta.tags) ? meta.tags : [];
  return {
    slug: slugChip ? slugChip[1] : slug,
    title: Array.isArray(meta.title) ? meta.title[0] : meta.title || slug,
    agent: agent ? agent[1] : 'unknown',
    kind: kind ? kind[1] : 'note',
    tags,
    stub: tags.includes('stub'),
    ts: time ? time[1] : stat.mtime.toISOString(),
    bytes: stat.size,
    excerpt: excerptFrom(body),
    url: '/posts/' + slug + '.html',
  };
}

function listPosts() {
  ensureDirs();
  const out = [];
  for (const f of fs.readdirSync(POSTS)) {
    if (!f.endsWith('.md') || f === 'index.md') continue;
    try {
      const p = parsePostFile(f.slice(0, -3), fs.statSync(path.join(POSTS, f)));
      if (p) out.push(p);
    } catch { /* skip unreadable */ }
  }
  out.sort((a, b) => String(b.ts).localeCompare(String(a.ts)));
  return out;
}

function getPostRaw(slug) {
  try { return fs.readFileSync(postPath(slug), 'utf8'); } catch { return null; }
}

// Images live in content/posts/<page>.assets/ (Boris page-asset convention).
function assetsDir(page) {
  const dir = path.join(POSTS, page + '.assets');
  if (!dir.startsWith(POSTS)) throw new Error('invalid page');
  return dir;
}

function ensurePageStub(page) {
  ensureDirs();
  if (postExists(page)) return;
  const title = page === 'media' ? 'Media Drop' : page.replace(/-/g, ' ');
  const lines = ['---', 'title: ' + JSON.stringify(title), 'parent: posts/index', 'tags: [media]', '---', '',
    '<p class="post-meta"><span class="post-meta__agent">collector</span> · <time datetime="' +
    new Date().toISOString() + '">media page</time></p>', '',
    'Auto-created asset page for image uploads.'];
  fs.writeFileSync(postPath(page), lines.join('\n') + '\n');
}

// SVG is served as a document by Boris on the site origin, so embedded
// scripts (and the admin token in the dashboard's localStorage) demand a
// scrub: drop <script>, event-handler attributes, javascript: URLs, and
// foreignObject HTML before anything hits disk.
function sanitizeSvg(buf) {
  let s = buf.toString('utf8');
  s = s.replace(/<script[\s\S]*?<\/script\s*>/gi, '')
    .replace(/<script\b[^>]*\/?>/gi, '')
    .replace(/<foreignObject[\s\S]*?<\/foreignObject\s*>/gi, '')
    .replace(/\son[a-z]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '')
    .replace(/((?:xlink:)?href\s*=\s*)("|')\s*javascript:[^"']*\2/gi, '$1"#"');
  return Buffer.from(s, 'utf8');
}

function saveImage({ name, post, buf, overwrite }) {
  ensureDirs();
  const clean = sanitizeName(name);
  if (!clean || !clean.includes('.')) throw new Error('bad filename');
  const ext = path.extname(clean).toLowerCase();
  if (!IMAGE_EXT.has(ext)) throw new Error('images only (' + ext + ' not allowed)');
  if (ext === '.svg') buf = sanitizeSvg(buf);
  const page = slugify(post || 'media') || 'media';
  const dir = assetsDir(page);
  fs.mkdirSync(dir, { recursive: true });
  ensurePageStub(page);

  let finalName = clean;
  if (!overwrite) {
    const stem = clean.slice(0, -ext.length);
    let i = 1;
    while (fs.existsSync(path.join(dir, finalName))) {
      finalName = stem + '-' + i + ext;
      i++;
    }
  }
  fs.writeFileSync(path.join(dir, finalName), buf);
  return { post: page, name: finalName, url: '/posts/' + page + '.assets/' + finalName, bytes: buf.length };
}

function listImages() {
  ensureDirs();
  const out = [];
  for (const f of fs.readdirSync(POSTS)) {
    if (!f.endsWith('.assets') || !fs.statSync(path.join(POSTS, f)).isDirectory()) continue;
    const page = f.slice(0, -'.assets'.length);
    const dir = path.join(POSTS, f);
    for (const img of fs.readdirSync(dir)) {
      try {
        const st = fs.statSync(path.join(dir, img));
        if (!st.isFile()) continue;
        if (!IMAGE_EXT.has(path.extname(img).toLowerCase())) continue;
        out.push({ name: img, post: page, url: '/posts/' + f + '/' + img, bytes: st.size, ts: st.mtime.toISOString() });
      } catch { /* skip */ }
    }
  }
  out.sort((a, b) => String(b.ts).localeCompare(String(a.ts)));
  return out;
}

// ---- removal (soft: everything lands in .runtime/trash/) ----

function trashDir() {
  const d = path.join(RUNTIME, 'trash');
  fs.mkdirSync(d, { recursive: true });
  return d;
}

function deletePost(slug) {
  let st;
  try { st = fs.statSync(postPath(slug)); } catch { return null; }
  if (!st.isFile()) return null;
  const stamp = Date.now();
  fs.renameSync(postPath(slug), path.join(trashDir(), slug + '-' + stamp + '.md'));
  try { fs.renameSync(path.join(POSTS, slug + '.assets'), path.join(trashDir(), slug + '.assets-' + stamp)); } catch { /* no assets */ }
  return { slug };
}

function deleteImage(post, name) {
  const clean = sanitizeName(name);
  const page = slugify(post || 'media') || 'media';
  const file = path.join(assetsDir(page), clean || '');
  let st;
  try { st = fs.statSync(file); } catch { return null; }
  if (!st.isFile()) return null;
  fs.renameSync(file, path.join(trashDir(), page + '-' + clean));
  return { post: page, name: clean };
}

// ---- generated docs pages ----------------------------------------------------
// Publish the root docs (API.md, AGENTS.md) as Boris pages under content/docs/
// so the contract is readable on the site itself. Idempotent: rewritten only
// when the source changes.

const DOC_SOURCES = [
  { src: path.join(ROOT, 'API.md'), dest: path.join(CONTENT, 'docs', 'api.md'), title: 'API Reference', tags: ['docs', 'api'] },
  { src: path.join(ROOT, 'AGENTS.md'), dest: path.join(CONTENT, 'docs', 'rules.md'), title: 'Agent Rules', tags: ['docs', 'rules'] },
];

function syncGeneratedDocs() {
  fs.mkdirSync(path.join(CONTENT, 'docs'), { recursive: true });
  for (const d of DOC_SOURCES) {
    let body;
    try { body = fs.readFileSync(d.src, 'utf8'); } catch { continue; }
    const fm = ['---', 'title: ' + JSON.stringify(d.title), 'parent: docs/index', 'tags: [' + d.tags.join(', ') + ']', '---', ''].join('\n');
    const next = fm + '\n' + body.trim() + '\n';
    try { if (fs.readFileSync(d.dest, 'utf8') === next) continue; } catch { /* first run */ }
    fs.writeFileSync(d.dest, next);
  }
}

// ---- events ----

function addEvent({ agent, type, message, meta }) {
  ensureDirs();
  const entry = {
    ts: new Date().toISOString(),
    agent: String(agent || 'system').slice(0, 60),
    type: String(type || 'note').slice(0, 30),
    message: String(message || '').slice(0, 300),
  };
  if (meta) entry.meta = meta;
  try { fs.appendFileSync(EVENTS_FILE, JSON.stringify(entry) + '\n'); } catch { /* best-effort */ }
  trimEvents();
  return entry;
}

// True if a hub-lifecycle event exists within the window — used to keep
// collector restarts from spamming "online" events into the feed.
function recentHubEvent(withinMs) {
  try {
    const lines = fs.readFileSync(EVENTS_FILE, 'utf8').trimEnd().split('\n');
    for (let i = lines.length - 1; i >= Math.max(0, lines.length - 50); i--) {
      try {
        const e = JSON.parse(lines[i]);
        if (e.agent === 'hub' && e.type === 'hub') return Date.now() - Date.parse(e.ts) < withinMs;
      } catch { /* skip malformed */ }
    }
  } catch { /* no log yet */ }
  return false;
}

// The event log is append-only and would otherwise grow forever; when it
// passes 2 MiB, keep only the most recent 1000 entries.
function trimEvents() {
  try {
    if (fs.statSync(EVENTS_FILE).size <= 2 * 1024 * 1024) return;
    const lines = fs.readFileSync(EVENTS_FILE, 'utf8').split('\n').filter(Boolean);
    fs.writeFileSync(EVENTS_FILE, lines.slice(-1000).join('\n') + '\n');
  } catch { /* best-effort */ }
}

function listEvents(limit = 50) {
  let lines = [];
  try { lines = fs.readFileSync(EVENTS_FILE, 'utf8').split('\n').filter(Boolean); } catch { /* none yet */ }
  const out = [];
  for (const line of lines.slice(-500)) {
    try { out.push(JSON.parse(line)); } catch { /* skip */ }
  }
  return out.reverse().slice(0, limit);
}

// Events are append-only but posts are not: drop publish/update events whose
// post file is gone, and image-upload events whose target page is gone, so
// the feed, dashboard timeline, and blog list never advertise content that
// 404s. Delete/stub events are kept — they *report* the change rather than
// advertise the post.
const POST_EVENT_SLUG = /\(([^()\s]+)\)\s*$/; // 'published "Title" (slug)'
const IMAGE_EVENT_PAGE = /→\s*([A-Za-z0-9-]+)\s*$/; // 'uploaded x.png → page'

function eventsForFeed(limit = 50) {
  return listEvents(limit * 2).filter((ev) => {
    if (ev.type === 'post') {
      const m = POST_EVENT_SLUG.exec(String(ev.message || ''));
      return m ? postExists(m[1]) : true;
    }
    if (ev.type === 'image') {
      const m = IMAGE_EVENT_PAGE.exec(String(ev.message || ''));
      return m ? postExists(m[1]) : true;
    }
    return true;
  }).slice(0, limit);
}

function counts() {
  const posts = listPosts();
  const images = listImages();
  return { posts: posts.length, images: images.length, events: listEvents(1000).length };
}

module.exports = {
  ROOT, POSTS, IMAGE_EXT, POST_KINDS,
  token, resolveToken, createToken, revokeToken, listTokens, ensureDirs,
  slugify, sanitizeName,
  savePost, listPosts, getPostRaw, postExists, deletePost,
  saveImage, listImages, deleteImage,
  addEvent, listEvents, eventsForFeed, counts, syncGeneratedDocs, recentHubEvent,
};
