'use strict';
// agent-hub collector — zero-dependency HTTP API for agent uploads + polling.
// Serves agents on loopback; Boris serves the site itself. Writes are
// token-authed; uploads accept markdown and images ONLY.

const http = require('http');
const fs = require('fs');
const path = require('path');
const store = require('./store');
const snapshot = require('./snapshot');
const buildstate = require('./buildstate');
const questions = require('./questions');
const agents = require('./agents');
const tasks = require('./tasks');

const CFG = { ...JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json'), 'utf8')), ROOT: store.ROOT };
const STARTED = Date.now();
let requests = 0;

store.ensureDirs();
store.token(); // create the upload token eagerly so scripts can print it
store.syncGeneratedDocs();

// ---------------- helpers ----------------

function log(req, code, ms) {
  // path only — tokens passed via ?token= must never land in the log
  console.log(new Date().toISOString(), req.method, String(req.url || '').split('?')[0], '->', code, '(' + ms + 'ms)');
}

// CORS: the dashboard (Boris, :8090) polls this API cross-origin, so only the
// configured site origins may READ responses. Anything else (random pages in
// the browser) gets no ACAO header and is blocked by the browser.
const SITE_ORIGINS = Array.isArray(CFG.siteOrigins) && CFG.siteOrigins.length
  ? CFG.siteOrigins : ['http://127.0.0.1:8090', 'http://localhost:8090'];

function corsHeaders(req) {
  const origin = req && req.headers.origin;
  return origin && SITE_ORIGINS.includes(origin)
    ? { 'Access-Control-Allow-Origin': origin, Vary: 'Origin' }
    : {};
}

function json(res, code, obj, req, started) {
  const body = JSON.stringify(obj, null, 2);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    ...corsHeaders(req),
  });
  res.end(body);
  if (req) log(req, code, started ? Date.now() - started : 0);
}

function err(res, code, msg, req, started) {
  json(res, code, { ok: false, error: msg }, req, started);
}

// Returns the authenticated token identity { name } or null.
function authorized(req, url) {
  const hdr = req.headers.authorization || '';
  const bearer = hdr.startsWith('Bearer ') ? hdr.slice(7) : '';
  const candidate = bearer || req.headers['x-boris-token'] || url.searchParams.get('token') || '';
  return store.resolveToken(candidate);
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(Object.assign(new Error('payload too large'), { code: 413 }));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

// Minimal multipart/form-data parser (buffer-level, fine for local uploads).
function parseMultipart(buf, contentType) {
  const m = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType || '');
  if (!m) return [];
  const boundary = Buffer.from('--' + (m[1] || m[2]).trim());
  const parts = [];
  let start = buf.indexOf(boundary);
  while (start !== -1) {
    const end = buf.indexOf(boundary, start + boundary.length);
    if (end === -1) break;
    let chunk = buf.slice(start + boundary.length, end);
    if (chunk[0] === 13 && chunk[1] === 10) chunk = chunk.slice(2);
    if (chunk.length >= 2 && chunk[chunk.length - 2] === 13 && chunk[chunk.length - 1] === 10) chunk = chunk.slice(0, -2);
    const sep = chunk.indexOf('\r\n\r\n');
    if (sep !== -1) {
      const head = chunk.slice(0, sep).toString('utf8');
      const name = /name="([^"]*)"/i.exec(head);
      const filename = /filename="([^"]*)"/i.exec(head);
      const ct = /content-type:\s*([^\r\n]+)/i.exec(head);
      parts.push({
        name: name ? name[1] : '',
        filename: filename ? filename[1] : '',
        contentType: ct ? ct[1].trim() : '',
        data: chunk.slice(sep + 4),
      });
    }
    start = end;
  }
  return parts;
}

function pickAgent(req, url, bodyObj, tokName) {
  // Hard attribution: a per-agent token pins the identity, so one agent can't
  // post under another's name. Explicit headers only widen what the primary
  // (admin) token claims. Disable with "hardAttribution": false in config.json.
  if (CFG.hardAttribution !== false && tokName && tokName !== 'primary') return tokName;
  const explicit = req.headers['x-agent'] || url.searchParams.get('agent') ||
    (bodyObj && bodyObj.agent);
  if (explicit) return explicit;
  return tokName && tokName !== 'primary' ? tokName : 'unknown';
}

const MD_EXT = new Set(['.md', '.markdown']);
const IMAGE_CT = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/svg+xml', 'image/avif']);

function extOf(name) { return path.extname(String(name || '')).toLowerCase(); }

// ---------------- routes ----------------

async function handle(req, res) {
  const started = Date.now();
  const url = new URL(req.url, 'http://127.0.0.1');
  const p = url.pathname;
  const method = req.method === 'HEAD' ? 'GET' : req.method;

  if (method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Authorization, Content-Type, X-Agent, X-Slug, X-Title, X-Boris-Token',
      'Access-Control-Max-Age': '600',
      ...corsHeaders(req),
    });
    return res.end();
  }

  // ---- health & index ----
  if (method === 'GET' && p === '/api/health') return json(res, 200, { ok: true, uptimeSec: Math.round((Date.now() - STARTED) / 1000) }, req, started);
  if (method === 'GET' && p === '/') {
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('agent-hub collector\nsite: http://127.0.0.1:8090/  (boris)\napi:  http://127.0.0.1:8801/api/docs  (full contract, markdown)\nrules: http://127.0.0.1:8801/api/rules\n');
    return log(req, 200, Date.now() - started);
  }

  // ---- self-serve contract + rules for agents without file access ----
  if (method === 'GET' && (p === '/api/docs' || p === '/api/rules')) {
    const file = p === '/api/docs' ? path.join(store.ROOT, 'API.md') : path.join(store.ROOT, 'AGENTS.md');
    let md;
    try { md = fs.readFileSync(file, 'utf8'); } catch { return err(res, 404, p + ' source missing', req, started); }
    res.writeHead(200, { 'Content-Type': 'text/markdown; charset=utf-8', ...corsHeaders(req) });
    res.end(md);
    return log(req, 200, Date.now() - started);
  }

  // ---- events ----
  if (method === 'GET' && p === '/api/events') {
    const limit = Math.min(parseInt(url.searchParams.get('limit') || '50', 10) || 50, 500);
    return json(res, 200, { ok: true, events: store.listEvents(limit) }, req, started);
  }

  // ---- build visibility ----
  if (method === 'GET' && p === '/api/build') {
    return json(res, 200, { ok: true, build: await buildstate.buildState() }, req, started);
  }

  // ---- questions-for-humans board ----
  if (method === 'GET' && p === '/api/questions') {
    const status = url.searchParams.get('status') || 'open';
    if (!['open', 'answered', 'all'].includes(status)) {
      return err(res, 400, '?status= must be open, answered, or all', req, started);
    }
    const rows = questions.listQuestions(status);
    return json(res, 200, {
      ok: true,
      openCount: questions.openCount(),
      count: rows.length,
      questions: rows,
    }, req, started);
  }

  if (method === 'POST' && p === '/api/questions') {
    const tok = authorized(req, url);
    if (!tok) return err(res, 401, 'unauthorized — pass an upload token', req, started);
    let obj;
    try { obj = JSON.parse((await readBody(req, CFG.maxPostBytes)).toString('utf8') || '{}'); } catch { return err(res, 400, 'invalid JSON body', req, started); }
    try {
      // hard attribution: the token's name is the asker; only the primary
      // (admin) token may name an agent explicitly, else "unknown"
      const agent = pickAgent(req, url, { agent: obj.agent }, tok.name);
      const q = questions.addQuestion({ agent, question: obj.question, context: obj.context });
      store.addEvent({ agent: q.agent, type: 'question', message: 'asked: "' + q.question.slice(0, 160) + '" (' + q.id + ')' });
      return json(res, 201, { ok: true, question: q }, req, started);
    } catch (e) {
      return err(res, 400, String(e.message || e), req, started);
    }
  }

  const qm = /^\/api\/questions\/([a-z0-9][a-z0-9-]*)\/answer$/.exec(p);
  if (method === 'POST' && qm) {
    const tok = authorized(req, url);
    if (!tok) return err(res, 401, 'unauthorized — pass an upload token', req, started);
    if (tok.name !== 'primary') {
      return err(res, 403, 'answering questions is humans-only: use the primary/admin token (.runtime/upload-token)', req, started);
    }
    let obj;
    try { obj = JSON.parse((await readBody(req, CFG.maxPostBytes)).toString('utf8') || '{}'); } catch { return err(res, 400, 'invalid JSON body', req, started); }
    try {
      const q = questions.answerQuestion(qm[1], { answer: obj.answer, by: 'human' });
      if (!q) return err(res, 404, 'no such question', req, started);
      store.addEvent({ agent: 'human', type: 'answer', message: 'answered ' + q.id + ' for ' + q.agent + ': "' + String(q.answer).slice(0, 140) + '"' });
      return json(res, 200, { ok: true, question: q }, req, started);
    } catch (e) {
      return err(res, 400, String(e.message || e), req, started);
    }
  }

  // ---- agent status registry ----
  if (method === 'POST' && p === '/api/agents/status') {
    const tok = authorized(req, url);
    if (!tok) return err(res, 401, 'unauthorized — pass an upload token', req, started);
    let obj;
    try { obj = JSON.parse((await readBody(req, 65536)).toString('utf8') || '{}'); } catch { return err(res, 400, 'invalid JSON body', req, started); }
    try {
      const name = pickAgent(req, url, { agent: obj.agent }, tok.name);
      const entry = agents.setStatus({ agent: name, status: obj.status, role: obj.role, note: obj.note, workingOn: obj.workingOn });
      const what = entry.workingOn || entry.note || entry.role || '';
      store.addEvent({ agent: entry.name, type: 'agent-status', message: 'is ' + entry.status + (what ? ' — ' + what : '') });
      return json(res, 200, { ok: true, agent: entry }, req, started);
    } catch (e) {
      return err(res, 400, String(e.message || e), req, started);
    }
  }

  if (method === 'GET' && p === '/api/agents') {
    const open = questions.listQuestions('open');
    const roster = agents.roster().map((a) => ({
      ...a,
      questionCount: open.filter((q) => q.agent === a.name).length,
    }));
    return json(res, 200, {
      ok: true,
      counts: agents.countsByStatus(),
      openQuestions: questions.openCount(),
      agents: roster,
    }, req, started);
  }

  // ---- shared task board ----
  if (method === 'GET' && p === '/api/tasks') {
    const status = url.searchParams.get('status') || 'all';
    if (!['open', 'claimed', 'done', 'mine', 'all'].includes(status)) {
      return err(res, 400, '?status= must be open, claimed, done, mine, or all', req, started);
    }
    let rows;
    if (status === 'mine') {
      const tok = authorized(req, url);
      if (!tok) return err(res, 401, 'unauthorized — ?status=mine needs a token', req, started);
      rows = tasks.listTasks('all').filter((t) => t.claimedBy === tok.name || t.createdBy === tok.name);
    } else {
      rows = tasks.listTasks(status);
    }
    return json(res, 200, {
      ok: true,
      counts: tasks.countsByStatus(),
      count: rows.length,
      tasks: rows,
    }, req, started);
  }

  if (method === 'POST' && p === '/api/tasks') {
    const tok = authorized(req, url);
    if (!tok) return err(res, 401, 'unauthorized — pass an upload token', req, started);
    let obj;
    try { obj = JSON.parse((await readBody(req, 65536)).toString('utf8') || '{}'); } catch { return err(res, 400, 'invalid JSON body', req, started); }
    try {
      const by = pickAgent(req, url, obj, tok.name);
      const t = tasks.addTask({ title: obj.title, detail: obj.detail, createdBy: by });
      store.addEvent({ agent: t.createdBy, type: 'task', message: 'created task "' + t.title.slice(0, 120) + '" (' + t.id + ')' });
      return json(res, 201, { ok: true, task: t }, req, started);
    } catch (e) {
      return err(res, 400, String(e.message || e), req, started);
    }
  }

  const tm = /^\/api\/tasks\/([a-z0-9][a-z0-9-]*)\/(claim|release|done|delete)$/.exec(p);
  if (method === 'POST' && tm) {
    const tok = authorized(req, url);
    if (!tok) return err(res, 401, 'unauthorized — pass an upload token', req, started);
    let obj = {};
    try { obj = JSON.parse((await readBody(req, 65536)).toString('utf8') || '{}'); } catch { /* body optional */ }
    // claims/transitions are pinned to the token identity — no spoofing
    const by = tok.name;
    const act = tm[2];
    try {
      const t = act === 'claim' ? tasks.claimTask(tm[1], { by })
        : act === 'release' ? tasks.releaseTask(tm[1], { by })
        : act === 'done' ? tasks.completeTask(tm[1], { by, result: obj.result })
        : tasks.deleteTask(tm[1], { by });
      if (!t) return err(res, 404, 'no such task', req, started);
      const label = '"' + t.title.slice(0, 120) + '" (' + t.id + ')';
      if (act === 'claim') store.addEvent({ agent: t.claimedBy, type: 'task', message: 'claimed task ' + label });
      else if (act === 'release') store.addEvent({ agent: by, type: 'task', message: 'released task ' + label });
      else if (act === 'done') store.addEvent({ agent: t.claimedBy, type: 'task', message: 'finished task ' + label + (t.result ? ' — ' + t.result.slice(0, 100) : '') });
      else store.addEvent({ agent: by, type: 'task', message: 'deleted task ' + label });
      return json(res, act === 'claim' ? 201 : 200, { ok: true, task: t }, req, started);
    } catch (e) {
      return err(res, 409, String(e.message || e), req, started);
    }
  }

  // ---- status (dashboard + agents) ----
  if (method === 'GET' && p === '/api/status') {
    store.syncGeneratedDocs(); // keep on-site docs pages in sync with the sources
    const force = url.searchParams.get('refresh') === '1';
    const snap = await snapshot.getSnapshot(CFG, force);
    return json(res, 200, {
      ok: true,
      site: { name: CFG.siteName, generatedAt: new Date().toISOString(), uptimeSec: Math.round((Date.now() - STARTED) / 1000) },
      counts: store.counts(),
      openQuestions: questions.openCount(),
      tasks: tasks.countsByStatus(),
      build: await buildstate.buildState(),
      tokens: store.listTokens().map((t) => ({ name: t.name, created: t.created, lastUsed: t.lastUsed })),
      github: { ...snap.github, fetchedAt: snapshot.snapshotAge() === null ? null : new Date(Date.now() - (snapshot.snapshotAge() || 0)).toISOString() },
      local: snap.local,
      activity: { events: store.eventsForFeed(40) },
    }, req, started);
  }

  // ---- feed (what agents poll) ----
  if (method === 'GET' && p === '/api/feed') {
    const since = url.searchParams.get('since');
    const sinceTs = since ? Date.parse(since) : null;
    const limit = Math.min(parseInt(url.searchParams.get('limit') || '50', 10) || 50, 200);
    // optional narrowers: ?type=post,image,event · ?agent=newbird,secondbird · ?kind=report,milestone
    const types = url.searchParams.get('type')
      ? new Set(url.searchParams.get('type').split(',').map((s) => s.trim()).filter(Boolean)) : null;
    const agentsF = url.searchParams.get('agent')
      ? new Set(url.searchParams.get('agent').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean)) : null;
    const kinds = url.searchParams.get('kind')
      ? new Set(url.searchParams.get('kind').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean)) : null;
    const evTypes = url.searchParams.get('event')
      ? new Set(url.searchParams.get('event').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean)) : null;
    const ic = imageCountMap();
    const items = [];
    for (const post of store.listPosts()) {
      if (post.stub) continue; // stub pages are metadata, not updates
      items.push({ type: 'post', ts: post.ts, slug: post.slug, title: post.title, agent: post.agent, kind: post.kind || 'note', excerpt: post.excerpt, bytes: post.bytes, images: ic[post.slug] || 0, url: post.url });
    }
    for (const img of store.listImages()) items.push({ type: 'image', ts: img.ts, name: img.name, post: img.post, url: img.url });
    for (const ev of store.eventsForFeed(120)) items.push({ type: 'event', ts: ev.ts, agent: ev.agent, event: ev.type, message: ev.message });
    items.sort((a, b) => String(b.ts).localeCompare(String(a.ts)));
    const filtered = items
      .filter((i) => (Number.isFinite(sinceTs) ? Date.parse(i.ts) > sinceTs : true))
      .filter((i) => (types ? types.has(i.type) : true))
      .filter((i) => (agentsF ? (i.agent && agentsF.has(String(i.agent).toLowerCase())) : true))
      .filter((i) => (kinds ? (i.type === 'post' && kinds.has(String(i.kind || 'note'))) : true))
      .filter((i) => (evTypes ? (i.type === 'event' && evTypes.has(String(i.event || ''))) : true));
    return json(res, 200, {
      ok: true,
      now: new Date().toISOString(),
      count: filtered.slice(0, limit).length, // size of THIS batch — trust this
      total: filtered.length,                 // everything matching (backlog)
      items: filtered.slice(0, limit),
      poll: 'pass ?since=<latest-ts> for only newer items; narrow with ?type=post,image,event, ?agent=<name>, ?kind=<post-kind>, ?event=<event-kind>',
    }, req, started);
  }

  // ---- deletions (soft-deleted into .runtime/trash/) ----
  const dm = /^\/api\/posts\/([a-z0-9][a-z0-9-]*)$/.exec(p);
  if (method === 'DELETE' && dm) {
    const tok = authorized(req, url);
    if (!tok) return err(res, 401, 'unauthorized — pass an upload token', req, started);
    const gone = store.deletePost(dm[1]);
    if (!gone) return err(res, 404, 'no such post', req, started);
    store.addEvent({ agent: pickAgent(req, url, null, tok.name), type: 'delete', message: 'deleted post ' + gone.slug });
    return json(res, 200, { ok: true, deleted: gone }, req, started);
  }
  if (method === 'DELETE' && p === '/api/images') {
    const tok = authorized(req, url);
    if (!tok) return err(res, 401, 'unauthorized — pass an upload token', req, started);
    const post = url.searchParams.get('post') || 'media';
    const name = url.searchParams.get('name');
    if (!name) return err(res, 400, 'missing ?post= and ?name=', req, started);
    const gone = store.deleteImage(post, name);
    if (!gone) return err(res, 404, 'no such image', req, started);
    store.addEvent({ agent: pickAgent(req, url, null, tok.name), type: 'delete', message: 'deleted image ' + gone.name + ' from ' + gone.post });
    return json(res, 200, { ok: true, deleted: gone }, req, started);
  }

  // ---- posts ----
  if (method === 'GET' && p === '/api/posts') {
    const ic = imageCountMap();
    return json(res, 200, { ok: true, posts: store.listPosts().map((p) => ({ ...p, images: ic[p.slug] || 0 })) }, req, started);
  }

  if (method === 'GET' && p === '/api/images') {
    return json(res, 200, { ok: true, images: store.listImages() }, req, started);
  }

  let m = /^\/api\/posts\/([a-z0-9][a-z0-9-]*)$/.exec(p);
  if (method === 'GET' && m) {
    const raw = store.getPostRaw(m[1]);
    if (raw == null) return err(res, 404, 'no such post', req, started);
    if (url.searchParams.get('format') === 'raw') {
      res.writeHead(200, { 'Content-Type': 'text/markdown; charset=utf-8', ...corsHeaders(req) });
      res.end(raw);
      return log(req, 200, Date.now() - started);
    }
    const post = store.listPosts().find((x) => x.slug === m[1]) || { slug: m[1] };
    return json(res, 200, { ok: true, post: { ...post, body: raw } }, req, started);
  }

  const writeRoute = /^\/api\/(posts|images|events|upload)$/.exec(p);
  if (writeRoute && (method === 'POST' || method === 'PUT')) {
    const tok = authorized(req, url);
    if (!tok) {
      return err(res, 401, 'unauthorized — pass an upload token (Authorization: Bearer <token> or ?token=); see node collector/tokens.js list', req, started);
    }
    const kind = writeRoute[1];

    // ---- events ----
    if (kind === 'events') {
      let obj;
      try { obj = JSON.parse((await readBody(req, 65536)).toString('utf8') || '{}'); } catch { return err(res, 400, 'invalid JSON body', req, started); }
      if (!obj.message) return err(res, 400, 'missing "message"', req, started);
      const ev = store.addEvent({ agent: pickAgent(req, url, obj, tok.name), type: obj.type || 'note', message: obj.message, meta: obj.meta });
      return json(res, 201, { ok: true, event: ev }, req, started);
    }

    // ---- posts (raw md | JSON | multipart) ----
    if (kind === 'posts') {
      const ct = String(req.headers['content-type'] || '');
      const opts = {
        title: req.headers['x-title'] || url.searchParams.get('title'),
        agent: req.headers['x-agent'] || url.searchParams.get('agent'),
        slug: url.searchParams.get('slug') || req.headers['x-slug'],
        tags: url.searchParams.get('tags'),
        date: url.searchParams.get('date'),
        kind: req.headers['x-kind'] || url.searchParams.get('kind'),
        overwrite: ['1', 'true', 'yes'].includes(url.searchParams.get('overwrite')),
      };
      let md = null;

      if (ct.includes('application/json')) {
        let obj;
        try { obj = JSON.parse((await readBody(req, CFG.maxPostBytes)).toString('utf8')); } catch { return err(res, 400, 'invalid JSON body', req, started); }
        md = obj.body || obj.markdown || obj.content;
        if (typeof md !== 'string') return err(res, 400, 'JSON body needs a string "body" (markdown)', req, started);
        opts.title = obj.title || opts.title;
        opts.agent = obj.agent || opts.agent;
        opts.slug = obj.slug || opts.slug;
        opts.tags = Array.isArray(obj.tags) ? obj.tags : (obj.tags || opts.tags);
        opts.date = obj.date || opts.date;
        opts.kind = obj.kind || opts.kind;
        opts.overwrite = opts.overwrite || !!obj.overwrite;
        if (obj.status) opts.status = obj.status;
      } else if (ct.includes('multipart/form-data')) {
        const parts = parseMultipart(await readBody(req, CFG.maxPostBytes), ct);
        const filePart = parts.find((x) => x.filename && MD_EXT.has(extOf(x.filename)));
        const field = (n) => parts.find((x) => x.name === n && !x.filename);
        if (filePart) {
          md = filePart.data.toString('utf8');
          opts.title = opts.title || path.basename(filePart.filename).replace(/\.(md|markdown)$/i, '');
        } else if (field('body') || field('markdown')) {
          md = (field('body') || field('markdown')).data.toString('utf8');
        } else {
          return err(res, 400, 'multipart needs a .md file part or a body/markdown field', req, started);
        }
        for (const k of ['title', 'agent', 'slug', 'tags', 'date', 'kind']) {
          const f = field(k);
          if (f && !opts[k]) opts[k] = f.data.toString('utf8');
        }
        if (field('overwrite') && !opts.overwrite) opts.overwrite = field('overwrite').data.toString() === '1';
      } else {
        md = (await readBody(req, CFG.maxPostBytes)).toString('utf8');
        if (!md.trim()) return err(res, 400, 'empty markdown body', req, started);
      }

      try {
        if (tok.name !== 'primary' && (CFG.hardAttribution !== false || !opts.agent)) opts.agent = tok.name;
        // typed posts: optional kind allowlist (note is the default); anything
        // else is a bad request, not a silent retype
        if (opts.kind && !store.POST_KINDS.has(String(opts.kind))) {
          return err(res, 400, 'unknown kind "' + opts.kind + '" — allowed: ' + [...store.POST_KINDS].join(', '), req, started);
        }
        const saved = store.savePost({ ...opts, body: md });
        store.addEvent({ agent: saved.agent, type: 'post', message: (saved.updated ? 'updated' : 'published') + ' "' + saved.title + '" (' + saved.slug + ')', meta: { kind: saved.kind } });
        return json(res, saved.updated ? 200 : 201, { ok: true, ...saved }, req, started);
      } catch (e) {
        return err(res, 400, String(e.message || e), req, started);
      }
    }

    // ---- images (raw binary | multipart) ----
    if (kind === 'images') {
      const ct = String(req.headers['content-type'] || '');
      const post = url.searchParams.get('post') || req.headers['x-post'] || 'media';
      const overwrite = ['1', 'true', 'yes'].includes(url.searchParams.get('overwrite'));
      const saved = [];
      const failed = [];

      if (ct.includes('multipart/form-data')) {
        const parts = parseMultipart(await readBody(req, CFG.maxImageBytes * 4), ct);
        for (const part of parts.filter((x) => x.filename)) {
          try {
            saved.push(store.saveImage({ name: part.filename, post: (fieldVal(parts, 'post') || post), buf: part.data, overwrite }));
          } catch (e) { failed.push({ filename: part.filename, error: String(e.message || e) }); }
        }
        if (!saved.length && !failed.length) return err(res, 400, 'multipart needs at least one file part', req, started);
      } else {
        const name = url.searchParams.get('name') || url.searchParams.get('filename') || req.headers['x-filename'];
        if (!name) return err(res, 400, 'missing ?name= (or send multipart/form-data)', req, started);
        try {
          saved.push(store.saveImage({ name, post, buf: await readBody(req, CFG.maxImageBytes), overwrite }));
        } catch (e) {
          return err(res, IMAGE_CT.has(ct) || e.message && e.message.startsWith('images only') ? 415 : 400, String(e.message || e), req, started);
        }
      }
      for (const s of saved) store.addEvent({ agent: pickAgent(req, url, null, tok.name), type: 'image', message: 'uploaded ' + s.name + ' → ' + s.post });
      return json(res, 201, { ok: true, saved, failed: failed.length ? failed : undefined }, req, started);
    }

    // ---- upload: the "dump everything" endpoint (markdown + images ONLY) ----
    if (kind === 'upload') {
      const ct = String(req.headers['content-type'] || '');
      const defaultPost = url.searchParams.get('post') || 'media';
      const overwrite = ['1', 'true', 'yes'].includes(url.searchParams.get('overwrite'));
      const out = { ok: true, posts: [], images: [], skipped: [] };

      if (ct.includes('multipart/form-data')) {
        const parts = parseMultipart(await readBody(req, CFG.maxImageBytes * 4 + CFG.maxPostBytes * 4), ct);
        for (const part of parts.filter((x) => x.filename || x.data.length)) {
          const fname = part.filename || part.name + '.bin';
          const ext = extOf(fname);
          try {
            if (MD_EXT.has(ext)) {
              out.posts.push(store.savePost({
                title: url.searchParams.get('title') || path.basename(fname).replace(/\.(md|markdown)$/i, ''),
                agent: pickAgent(req, url, { agent: fieldVal(parts, 'agent') }, tok.name),
                tags: fieldVal(parts, 'tags') || url.searchParams.get('tags'),
                body: part.data.toString('utf8'),
                overwrite,
              }));
            } else if (store.IMAGE_EXT.has(ext) || IMAGE_CT.has(part.contentType)) {
              out.images.push(store.saveImage({ name: fname, post: fieldVal(parts, 'post') || defaultPost, buf: part.data, overwrite }));
            } else {
              out.skipped.push({ filename: fname, reason: 'markdown and images only' });
            }
          } catch (e) {
            out.skipped.push({ filename: fname, reason: String(e.message || e) });
          }
        }
      } else {
        return err(res, 400, 'POST /api/upload expects multipart/form-data (use /api/posts or /api/images for single raw bodies)', req, started);
      }

      for (const s of out.posts) store.addEvent({ agent: s.agent, type: 'post', message: (s.updated ? 'updated' : 'published') + ' "' + s.title + '" (' + s.slug + ')' });
      for (const s of out.images) store.addEvent({ agent: pickAgent(req, url, null, tok.name), type: 'image', message: 'uploaded ' + s.name + ' → ' + s.post });
      return json(res, 201, out, req, started);
    }
  }

  return err(res, 404, 'no such endpoint — see API.md', req, started);
}

function fieldVal(parts, name) {
  const f = parts.find((x) => x.name === name && !x.filename);
  return f ? f.data.toString('utf8') : null;
}

function imageCountMap() {
  const map = {};
  for (const im of store.listImages()) map[im.post] = (map[im.post] || 0) + 1;
  return map;
}

// ---------------- server ----------------

const server = http.createServer((req, res) => {
  handle(req, res).catch((e) => {
    const code = e.code === 413 ? 413 : 500;
    if (!res.headersSent) err(res, code, String(e.message || e));
  });
});

server.listen(CFG.port, CFG.host || '127.0.0.1', () => {
  console.log('agent-hub collector listening on http://' + (CFG.host || '127.0.0.1') + ':' + CFG.port);
  console.log('site (boris): http://127.0.0.1:8090/  ·  token: .runtime/upload-token');
  store.addEvent({ agent: 'hub', type: 'hub', message: 'collector online on port ' + CFG.port });
});

process.on('SIGINT', () => process.exit(0));
process.on('SIGTERM', () => process.exit(0));
