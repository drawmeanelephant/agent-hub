/* agent-hub client — renders dashboard + blog from the collector API.
   Zero dependencies; same-origin static site, live data from loopback collector. */
(() => {
  "use strict";

  // Collector base: same hostname the site was opened on, collector port.
  // (Browsing via localhost then talks to localhost:8801 — matching the
  // CORS allowlist in collector/config.json.) Override with
  // window.__HUB_COLLECTOR__ in the layout if the port ever moves.
  const BASE = window.__HUB_COLLECTOR__ ||
    (location.protocol.startsWith("http")
      ? location.protocol + "//" + location.hostname + ":8801"
      : "http://127.0.0.1:8801");
  const REFRESH_MS = 10000;

  /* ---------- helpers ---------- */

  const esc = (v) => String(v == null ? "" : v)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");

  // site-root prefix derived from the theme stylesheet href ("" at root, "../" deeper)
  const sitePrefix = (() => {
    const sheet = document.querySelector('link[rel="stylesheet"][href*="assets/"]');
    const href = sheet ? sheet.getAttribute("href") || "" : "";
    const marker = href.lastIndexOf("assets/");
    return marker >= 0 ? href.slice(0, marker) : "";
  })();

  const wordmark = document.getElementById("hub-wordmark");
  if (wordmark) wordmark.href = sitePrefix + "index.html";
  const docsLink = document.getElementById("hub-docs-link");
  if (docsLink) docsLink.href = sitePrefix + "docs/index.html";

  const relTime = (iso) => {
    if (!iso) return "–";
    const t = Date.parse(iso);
    if (!Number.isFinite(t)) return "–";
    const s = Math.max(0, (Date.now() - t) / 1000);
    if (s < 45) return "just now";
    if (s < 90) return "1m ago";
    if (s < 3600) return Math.round(s / 60) + "m ago";
    if (s < 86400) return Math.round(s / 3600) + "h ago";
    if (s < 86400 * 14) return Math.round(s / 86400) + "d ago";
    return new Date(t).toISOString().slice(0, 10);
  };

  const absTime = (iso) => {
    const t = Date.parse(iso);
    if (!Number.isFinite(t)) return "–";
    const d = new Date(t);
    const pad = (n) => String(n).padStart(2, "0");
    return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate()) +
      " " + pad(d.getHours()) + ":" + pad(d.getMinutes());
  };

  const hue = (str) => {
    let h = 0;
    for (let i = 0; i < String(str).length; i++) h = (h * 31 + String(str).charCodeAt(i)) >>> 0;
    return h % 360;
  };

  const agentChip = (agent) => {
    const a = String(agent || "unknown");
    return '<span class="chip chip--agent" style="--c:hsl(' + hue(a) + ' 70% 68%)">' + esc(a) + "</span>";
  };

  const fetchJSON = async (path, timeoutMs = 6000) => {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(BASE + path, { signal: ctrl.signal });
      if (!res.ok) throw new Error("HTTP " + res.status);
      return await res.json();
    } finally { clearTimeout(timer); }
  };

  const setBodyWide = () => document.body.classList.add("hub-wide");

  const footerClock = () => {
    const el = document.getElementById("hub-clock");
    if (el) el.textContent = absTime(new Date().toISOString());
  };
  footerClock();
  setInterval(footerClock, 30000);

  /* ---------- theme switcher (dark / light / pride) ---------- */

  const COLOR_SCHEME = { dark: "dark", light: "light", pride: "dark" };

  const applyTheme = (name) => {
    document.documentElement.dataset.theme = name;
    const meta = document.querySelector('meta[name="color-scheme"]');
    if (meta) meta.setAttribute("content", COLOR_SCHEME[name] || "dark");
    document.querySelectorAll(".theme-switch button[data-set-theme]").forEach((b) => {
      b.setAttribute("aria-pressed", b.dataset.setTheme === name ? "true" : "false");
    });
  };

  const themeSwitch = document.querySelector(".theme-switch");
  if (themeSwitch) {
    themeSwitch.addEventListener("click", (e) => {
      const btn = e.target.closest("button[data-set-theme]");
      if (!btn) return;
      const name = btn.dataset.setTheme;
      try { localStorage.setItem("hub-theme", name); } catch { /* storage blocked */ }
      applyTheme(name);
    });
    // sync button state with whatever the pre-paint snippet picked
    applyTheme(document.documentElement.dataset.theme || "dark");
  }

  /* ---------- status pill ---------- */

  const statusEl = document.getElementById("hub-status");
  const checkStatus = async () => {
    if (!statusEl) return;
    try {
      await fetchJSON("/api/status", 4000);
      statusEl.className = "hub-status is-live";
      statusEl.querySelector(".hub-status__label").textContent = "live";
    } catch {
      statusEl.className = "hub-status is-down";
      statusEl.querySelector(".hub-status__label").textContent = "collector down";
    }
  };
  checkStatus();
  setInterval(checkStatus, 15000);

  /* ---------- dashboard ---------- */

  const dashRoot = document.getElementById("dashboard-root");

  const glyphFor = (type) => ({
    PushEvent: "▲", PullRequestEvent: "⇄", PullRequestReviewEvent: "⇄",
    IssuesEvent: "◎", IssueCommentEvent: "◇", CreateEvent: "+",
    WatchEvent: "★", ForkEvent: "⑂", ReleaseEvent: "✦", DeleteEvent: "−"
  })[type] || "•";

  const langDot = (lang) => lang
    ? '<span class="dot dot--lang" style="background:hsl(' + hue(lang) + ' 62% 62%)"></span>'
    : '<span class="dot dot--lang" style="background:var(--border-strong)"></span>';

  const localRepoCard = (r) => {
    const dirty = r.dirty > 0;
    const sync = r.hasUpstream
      ? (r.ahead || r.behind
        ? '<span title="ahead/behind upstream">↑' + (r.ahead || 0) + " ↓" + (r.behind || 0) + "</span>"
        : '<span class="chip chip--ok">synced</span>')
      : '<span title="no upstream configured">local only</span>';
    return '<div class="card">' +
      '<div class="repo-head"><span class="repo-name">' + esc(r.name) + "</span>" +
      '<span class="chip chip--branch">' + esc(r.branch || "?") + "</span></div>" +
      '<div class="repo-meta">' +
      '<span><span class="dot ' + (dirty ? "dot--dirty" : "dot--ok") + '"></span>' +
      (dirty ? r.dirty + " dirty" : "clean") + "</span>" + sync +
      '<span style="margin-left:auto">' + relTime(r.lastCommit && r.lastCommit.date) + "</span></div>" +
      (r.lastCommit
        ? '<div class="repo-commit"><span class="sha">' + esc((r.lastCommit.sha || "").slice(0, 7)) + "</span> " +
          esc(r.lastCommit.subject || "") + "</div>"
        : "") +
      "</div>";
  };

  const ghRepoCard = (r) =>
    '<a class="card" href="' + esc(r.url || "#") + '" target="_blank" rel="noopener noreferrer">' +
    '<div class="repo-head"><span class="repo-name">' + esc(r.nameWithOwner || r.name) + "</span>" +
    (r.isPrivate ? '<span class="chip">private</span>' : "") + "</div>" +
    '<div class="repo-meta">' + langDot(r.language) + "<span>" + esc(r.language || "—") + "</span>" +
    '<span style="margin-left:auto">pushed ' + relTime(r.pushedAt) + "</span></div>" +
    (r.description ? '<p class="repo-desc">' + esc(r.description) + "</p>" : "") +
    "</a>";

  const prRow = (p) =>
    '<li class="feed-item"><span class="feed-item__glyph">⇄</span>' +
    '<div class="feed-item__body"><div class="feed-item__text">' + esc(p.title) + "</div>" +
    '<div class="feed-item__sub">' + esc(p.repo) + " #" + esc(p.number) + " · " + esc(p.author || "") + "</div></div>" +
    '<span class="feed-item__time">' + relTime(p.updatedAt) + "</span></li>";

  const ghEventRow = (e) =>
    '<li class="feed-item"><span class="feed-item__glyph">' + glyphFor(e.type) + "</span>" +
    '<div class="feed-item__body"><div class="feed-item__text">' + esc(e.text) + "</div>" +
    '<div class="feed-item__sub">' + esc([e.repo, e.author].filter(Boolean).join(" · ")) + "</div></div>" +
    '<span class="feed-item__time">' + relTime(e.at) + "</span></li>";

  const ghActivity = (gh) => {
    const items = []
      .concat((gh.commits || []).map((c) => ({ type: "PushEvent", at: c.at, repo: c.repo, author: c.author, text: c.text })))
      .concat(gh.events || [])
      .sort((a, b) => String(b.at || "").localeCompare(String(a.at || "")));
    return items.length
      ? '<ul class="feed-list">' + items.slice(0, 12).map(ghEventRow).join("") + "</ul>"
      : emptyBox("no recent github activity");
  };

  const agentEventRow = (e) =>
    '<li class="feed-item"><span class="feed-item__glyph">' + agentChip(e.agent) + "</span>" +
    '<div class="feed-item__body"><div class="feed-item__text">' + esc(e.message) + "</div>" +
    '<div class="feed-item__sub">' + esc(e.type || "") + "</div></div>" +
    '<span class="feed-item__time">' + relTime(e.ts) + "</span></li>";

  const postCard = (p, builtIso) =>
    '<a class="card" href="' + sitePrefix + "posts/" + encodeURIComponent(p.slug) + '.html">' +
    '<div class="post-card__meta">' + agentChip(p.agent) +
    '<span class="chip chip--kind" title="post kind">' + esc(p.kind || "note") + "</span>" +
    (p.stub ? '<span class="chip">stub</span>' : "") +
    (builtIso && Date.parse(p.ts) > Date.parse(builtIso) ? '<span class="chip chip--warn">building…</span>' : "") +
    "<time>" + absTime(p.ts) + "</time>" +
    (p.images ? "<span>" + p.images + " img</span>" : "") +
    "</div>" +
    '<h3 class="post-card__title">' + esc(p.title) + "</h3>" +
    '<p class="post-card__excerpt">' + esc(p.excerpt || "") + "</p></a>";

  const buildChip = (b) => {
    if (!b) return "";
    if (b.state === "ok") return '<span class="chip chip--ok" title="last rebuild ' + esc(b.lastBuildAt || "") + '">build ok · ' + relTime(b.lastBuildAt) + "</span>";
    if (b.state === "building" || b.state === "no-build-yet") return '<span class="chip chip--warn">build pending · ' + (b.pendingSeconds || 0) + "s</span>";
    if (b.state === "likely-failing") return '<span class="chip chip--err">build failing</span>';
    return '<span class="chip">build ' + esc(b.state) + "</span>";
  };

  const tokensLine = (tokens) => {
    if (!tokens || !tokens.length) return "";
    return '<p class="feed-item__sub" style="margin:10px 0 0">api tokens: ' +
      tokens.map((t) => esc(t.name) + (t.lastUsed ? " (" + relTime(t.lastUsed) + ")" : "")).join(" · ") + "</p>";
  };

  const mediaThumb = (m) =>
    '<figure><a href="' + sitePrefix + esc(m.url) + '" target="_blank" rel="noopener noreferrer">' +
    '<img loading="lazy" src="' + sitePrefix + esc(m.url) + '" alt="' + esc(m.name) + '"></a>' +
    "<figcaption>" + esc(m.name) + "</figcaption></figure>";

  const section = (title, hintHTML, inner, cls) =>
    '<section class="hub-section"><div class="hub-section__head"><h2>' + esc(title) + "</h2>" +
    (hintHTML ? '<span class="hub-section__hint">' + hintHTML + "</span>" : "") +
    '</div>' + (inner || '<div class="empty">nothing yet</div>') + "</section>";

  const emptyBox = (msg) => '<div class="empty">' + msg + "</div>";

  /* ---------- fleet (agent status registry) ---------- */

  const NON_AGENTS = new Set(["hub", "collector", "system", "human", "unknown", "boris"]);

  const fleetCard = (a) => {
    const st = a.status || "unknown";
    return '<div class="card fleet-card">' +
      '<div class="repo-head"><span class="fleet-dot fleet-dot--' + esc(st) + '" title="' + esc(st) + '"></span>' +
      '<span class="repo-name">' + esc(a.name) + "</span>" +
      (a.role ? '<span class="chip">' + esc(a.role) + "</span>" : "") +
      (a.questionCount ? '<span class="chip chip--warn">' + a.questionCount + " open q</span>" : "") +
      "</div>" +
      '<div class="repo-meta"><span class="fleet-status fleet-status--' + esc(st) + '">' + esc(st) + "</span>" +
      '<span style="margin-left:auto">seen ' + relTime(a.lastSeen) + "</span></div>" +
      (a.workingOn ? '<div class="repo-commit">on: ' + esc(a.workingOn) + "</div>" : "") +
      (a.note ? '<p class="repo-desc">' + esc(a.note) + "</p>" : "") +
      "</div>";
  };

  // Roster from /api/agents merged with agents only seen in feed events —
  // they get a card too, with lastSeen from their last event.
  const fleetRoster = (posted, acts) => {
    const byName = new Map();
    for (const a of posted || []) if (a && a.name) byName.set(String(a.name).toLowerCase(), { ...a });
    for (const ev of acts || []) {
      const name = String(ev.agent || "").trim();
      if (!name || NON_AGENTS.has(name.toLowerCase())) continue;
      const key = name.toLowerCase();
      const prev = byName.get(key);
      const ts = Date.parse(ev.ts) || 0;
      if (prev) {
        if (ts > (Date.parse(prev.lastSeen) || 0)) prev.lastSeen = ev.ts;
      } else {
        byName.set(key, { name, status: null, lastSeen: ev.ts });
      }
    }
    return [...byName.values()].sort((a, b) => String(b.lastSeen || "").localeCompare(String(a.lastSeen || "")));
  };

  /* ---------- shared task board ---------- */

  const taskGlyph = (st) => (st === "done" ? "✓" : st === "claimed" ? "◐" : "○");

  const taskRow = (t) =>
    '<li class="feed-item"><span class="feed-item__glyph">' + taskGlyph(t.status) + "</span>" +
    '<div class="feed-item__body"><div class="feed-item__text">' + esc(t.title) + "</div>" +
    '<div class="feed-item__sub">' +
    (t.status === "claimed" && t.claimedBy ? agentChip(t.claimedBy) + " " : "") +
    esc(t.createdBy || "") + " · " + relTime(t.updatedAt) +
    (t.status === "done" && t.result ? " · " + esc(t.result) : "") +
    "</div></div>" +
    '<span class="feed-item__time">' + esc(t.status) + "</span></li>";

  const taskBoard = (allTasks) => {
    const open = allTasks.filter((t) => t.status === "open");
    const claimed = allTasks.filter((t) => t.status === "claimed");
    const done = allTasks.filter((t) => t.status === "done").slice(0, 5);
    const input =
      '<div class="q-answer-row" style="margin:0 0 12px">' +
      '<input type="text" class="q-answer-input task-title-input" placeholder="add a task for the fleet…">' +
      '<button type="button" class="q-answer-btn task-add-btn">Add task</button>' +
      '<span class="q-answer-msg task-add-msg" role="status" aria-live="polite"></span></div>';
    const rows = open.map(taskRow).concat(claimed.map(taskRow)).concat(done.map(taskRow));
    return input +
      (rows.length
        ? '<ul class="feed-list">' + rows.join("") + "</ul>"
        : emptyBox('no tasks yet — <code>POST /api/tasks {"title": "…"}</code>, claim with <code>/api/tasks/&lt;id&gt;/claim</code>'));
  };

  /* ---------- idea lab (pitch → refine → spec → graduate) ---------- */

  const pitchGlyph = { open: "○", refining: "◐", "spec-ready": "◈", graduated: "✓", shelved: "×" };

  const pitchRow = (p) => {
    const actionable = p.status === "open" || p.status === "refining" || p.status === "spec-ready";
    return '<li class="feed-item"><span class="feed-item__glyph">' + (pitchGlyph[p.status] || "○") + "</span>" +
      '<div class="feed-item__body"><div class="feed-item__text">' + esc(p.title) + "</div>" +
      '<div class="feed-item__sub">' + agentChip(p.createdBy) + " " +
      (p.refinedBy ? "<span>refining: " + esc(p.refinedBy) + "</span> · " : "") +
      (p.specSlug ? '<a href="' + sitePrefix + "posts/" + encodeURIComponent(p.specSlug) + '.html">spec ↗</a> · ' : "") +
      (p.graduatedTo ? "<span>→ task " + esc(p.graduatedTo) + "</span> · " : "") +
      '<span style="font-style:italic">' + esc((p.idea || "").slice(0, 140)) + "</span> · " + relTime(p.updatedAt) +
      "</div>" +
      (actionable
        ? '<div class="pitch-actions">' +
          (p.status === "spec-ready" ? '<button type="button" class="pitch-graduate-btn" data-pid="' + esc(p.id) + '">Graduate → task</button>' : "") +
          '<button type="button" class="pitch-shelve-btn" data-pid="' + esc(p.id) + '">Shelve</button>' +
          '<span class="pitch-msg" role="status" aria-live="polite"></span></div>'
        : "") +
      "</div>" +
      '<span class="feed-item__time">' + esc(p.status) + "</span></li>";
  };

  const ideaLab = (allPitches) => {
    const order = { open: 0, refining: 1, "spec-ready": 2, graduated: 3, shelved: 4 };
    const rows = [...allPitches].sort((a, b) => (order[a.status] ?? 9) - (order[b.status] ?? 9));
    const input =
      '<div class="q-answer-row" style="margin:0 0 12px">' +
      '<textarea class="q-answer-input pitch-idea-input" rows="2" placeholder="spitball an idea — first line becomes the title, the rest is context"></textarea>' +
      '<button type="button" class="q-answer-btn pitch-add-btn">Pitch it</button>' +
      '<span class="q-answer-msg pitch-add-msg" role="status" aria-live="polite"></span></div>';
    return input +
      (rows.length
        ? '<ul class="feed-list">' + rows.map(pitchRow).join("") + "</ul>"
        : emptyBox('no pitches yet — raw ideas welcome; agents refine them into specs, only you graduate them'));
  };

  const decisionRow = (p) =>
    '<li class="feed-item"><span class="feed-item__glyph">⚖</span>' +
    '<div class="feed-item__body"><div class="feed-item__text">' + esc(p.title) + "</div>" +
    '<div class="feed-item__sub">' + agentChip(p.agent) + " " + relTime(p.ts) + "</div></div>" +
    '<a class="feed-item__time" href="' + sitePrefix + "posts/" + encodeURIComponent(p.slug) + '.html">open ↗</a></li>';

  /* ---------- questions-for-humans board ---------- */

  const ADMIN_KEY = "hub-admin-token";

  const adminToken = () => {
    let t = null;
    try { t = localStorage.getItem(ADMIN_KEY); } catch { /* storage blocked */ }
    if (!t) {
      t = window.prompt("Admin token required to answer (the collector's .runtime/upload-token):");
      if (t) { try { localStorage.setItem(ADMIN_KEY, t); } catch { /* storage blocked */ } }
    }
    return t;
  };

  const questionItem = (q) => {
    const head =
      '<div class="q-head">' + agentChip(q.agent) +
      '<span class="q-when">' + relTime(q.askedAt) + "</span></div>" +
      '<p class="q-text">' + esc(q.question) + "</p>" +
      (q.context ? '<p class="q-context">' + esc(q.context) + "</p>" : "");
    if (q.status === "answered") {
      const short = q.question.length > 110 ? q.question.slice(0, 110) + "…" : q.question;
      return '<li class="q-item q-item--answered">' +
        '<details class="q-details"><summary>' + esc(short) + "</summary>" + head +
        '<p class="q-given"><span class="q-given__label">answer</span> ' + esc(q.answer || "") +
        ' <span class="q-when">· ' + relTime(q.answeredAt) + "</span></p>" +
        "</details></li>";
    }
    return '<li class="q-item q-item--open" data-qid="' + esc(q.id) + '">' + head +
      '<div class="q-answer-row">' +
      '<textarea class="q-answer-input" rows="2" placeholder="type the human answer…"></textarea>' +
      '<button type="button" class="q-answer-btn">Answer</button>' +
      '<span class="q-answer-msg" role="status" aria-live="polite"></span>' +
      "</div></li>";
  };

  const renderDashboard = (status, posts, images, fleetPosted, allQuestions, allTasks, allPitches) => {
    const gh = (status && status.github) || {};
    const local = (status && status.local) || {};
    const acts = (status && status.activity && status.activity.events) || [];
    const counts = (status && status.counts) || {};

    const since = Date.now() - 86400000;
    const events24 = acts.filter((e) => Date.parse(e.ts) > since).length;
    const lastPost = posts && posts[0];

    const stats =
      '<div class="stat-row">' +
      '<div class="stat"><div class="stat__num">' + (counts.posts || 0) + '</div><div class="stat__label">posts</div></div>' +
      '<div class="stat"><div class="stat__num">' + (counts.images || 0) + '</div><div class="stat__label">media</div></div>' +
      '<div class="stat"><div class="stat__num">' + events24 + '</div><div class="stat__label">events · 24h</div></div>' +
      '<div class="stat"><div class="stat__num">' + ((gh.repos || []).length) + '</div><div class="stat__label">gh repos</div></div>' +
      '<div class="stat"><div class="stat__num">' + ((gh.prs || []).length) + '</div><div class="stat__label">open prs</div></div>' +
      '<div class="stat"><div class="stat__num" style="font-size:17px;padding-top:6px">' + (lastPost ? relTime(lastPost.ts) : "–") + '</div><div class="stat__label">last upload</div></div>' +
      "</div>";

    const localRepos = (local.repos || []).length
      ? '<div class="card-grid">' + local.repos.map(localRepoCard).join("") + "</div>"
      : emptyBox("no git repos under <code>" + esc(local.scanRoot || "scan root") + "</code>");

    const ghRepos = (gh.repos || []).length
      ? '<div class="card-grid">' + gh.repos.slice(0, 12).map(ghRepoCard).join("") + "</div>"
      : emptyBox(gh.error ? esc(gh.error) : "no github data");

    const prs = (gh.prs || []).length
      ? '<ul class="feed-list">' + gh.prs.slice(0, 8).map(prRow).join("") + "</ul>"
      : emptyBox("no open pull requests");

    const ghEvents = ghActivity(gh);

    const agentEvents = acts.length
      ? '<ul class="timeline">' + acts.slice(0, 14).map(agentEventRow).join("") + "</ul>"
      : emptyBox('no agent activity yet — agents post via <code>POST /api/events</code>');

    const latest = (posts || []).length
      ? '<div class="card-grid">' + posts.slice(0, 6).map((p) => postCard(p, status.build && status.build.lastBuildAt)).join("") + "</div>"
      : emptyBox("no posts yet — agents drop markdown via <code>POST /api/posts</code>");

    const media = (images || []).length
      ? '<div class="media-strip">' + images.slice(0, 10).map(mediaThumb).join("") + "</div>"
      : emptyBox("no media yet — images go in alongside posts");

    let html = section("Status", buildChip(status.build), stats +
      tokensLine(status.tokens) +
      (status.build && status.build.state === "likely-failing" && (status.build.recentErrors || []).length
        ? '<pre style="margin:10px 0 0">' + esc(status.build.recentErrors.join("\n")) + "</pre>"
        : ""));

    const fleetRows = fleetRoster(fleetPosted, acts);
    const fleet = fleetRows.length
      ? '<div class="card-grid">' + fleetRows.map(fleetCard).join("") + "</div>"
      : emptyBox('no agents seen yet — agents report via <code>POST /api/agents/status</code>');
    html += section("Fleet", "who is doing what · <code>POST /api/agents/status</code>", fleet);

    const tAll = allTasks || [];
    const taskHint = tAll.length
      ? ((status.tasks && status.tasks.open) || tAll.filter((t) => t.status === "open").length) + " open · " +
        ((status.tasks && status.tasks.claimed) || tAll.filter((t) => t.status === "claimed").length) + " claimed" +
        ' · <code>POST /api/tasks</code>'
      : 'create + claim via <code>POST /api/tasks</code>';
    html += section("Task board", taskHint, taskBoard(tAll));

    const pAll = allPitches || [];
    const pOpen = pAll.filter((p) => ["open", "refining", "spec-ready"].includes(p.status)).length;
    const pitchHint = pAll.length
      ? pOpen + " in flight" +
        ' · refine via <code>POST /api/pitches/&lt;id&gt;/refine</code>'
      : 'raw ideas in, specs out · <code>POST /api/pitches</code>';
    html += section("Idea lab", pitchHint, ideaLab(pAll));

    const qs = allQuestions || [];
    const qOpen = qs.filter((q) => q.status === "open");
    const qAnswered = qs.filter((q) => q.status === "answered");
    const qList = (qOpen.length
      ? '<ul class="q-list">' + qOpen.map(questionItem).join("") + "</ul>"
      : emptyBox("no open questions — the humans can relax")) +
      (qAnswered.length
        ? '<p class="q-answered-note">' + qAnswered.length + " answered (recent below)</p>" +
          '<ul class="q-list">' + qAnswered.slice(0, 5).map(questionItem).join("") + "</ul>"
        : "");
    html += section("Questions for humans",
      (status.openQuestions || qOpen.length ? (status.openQuestions || qOpen.length) + " open" : "") + ' · ask via <code>POST /api/questions</code>',
      qList);

    if ((local.repos || []).length) html += section("Local working copies", esc(local.scanRoot || ""), localRepos);
    html += section("GitHub repositories", gh.login ? "as " + esc(gh.login) : "", ghRepos);
    html += '<div class="hub-cols">' +
      section("Agent activity", "collector event log", agentEvents) +
      section("GitHub activity", "recent events", ghEvents) +
      "</div>";
    html += section("Open pull requests", "", prs);

    const decisions = (posts || []).filter((p) => p.kind === "decision");
    html += section("Decision log", "record with <code>X-Kind: decision</code>",
      decisions.length
        ? '<ul class="feed-list">' + decisions.slice(0, 8).map(decisionRow).join("") + "</ul>"
        : emptyBox('nothing decided yet — durable choices go here so agents never re-derive them'));

    html += section("Latest posts", 'full blog → <a href="' + sitePrefix + 'posts/index.html">posts/index.html</a>', latest);
    html += section("Recent media", "", media);

    dashRoot.innerHTML = html;
  };

  const initDashboard = () => {
    setBodyWide();

    // inline add-task flow: admin token (prompted once, then remembered) →
    // POST /api/tasks — claims/transitions stay agent-side, by design
    dashRoot.addEventListener("click", async (e) => {
      const btn = e.target.closest(".task-add-btn");
      if (!btn) return;
      const row = btn.closest(".q-answer-row");
      const input = row.querySelector(".task-title-input");
      const msg = row.querySelector(".task-add-msg");
      const title = input ? input.value.trim() : "";
      if (!title) { msg.textContent = "give the task a title first"; return; }
      const token = adminToken();
      if (!token) { msg.textContent = "admin token required"; return; }
      btn.disabled = true;
      try {
        const res = await fetch(BASE + "/api/tasks", {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: "Bearer " + token },
          body: JSON.stringify({ title })
        });
        const data = await res.json().catch(() => ({}));
        if (res.status === 401 || res.status === 403) {
          try { localStorage.removeItem(ADMIN_KEY); } catch { /* storage blocked */ }
        }
        if (!res.ok) throw new Error(data.error || "HTTP " + res.status);
        input.value = "";
        msg.textContent = "added ✓";
        load();
      } catch (err) {
        msg.textContent = String(err.message || err);
      } finally { btn.disabled = false; }
    });

    // idea lab: add-pitch / graduate / shelve — all human (admin token) moves.
    // Refinement stays agent-side via the API; graduation auto-creates the task.
    dashRoot.addEventListener("click", async (e) => {
      const grad = e.target.closest(".pitch-graduate-btn");
      const shv = e.target.closest(".pitch-shelve-btn");
      const add = e.target.closest(".pitch-add-btn");
      if (!grad && !shv && !add) return;
      const btn = grad || shv || add;
      const row = btn.closest(".q-answer-row");
      const msgEl = row
        ? row.querySelector(".pitch-msg") || row.querySelector(".pitch-add-msg")
        : btn.parentElement.querySelector(".pitch-msg");
      const token = adminToken();
      let url, body, inputEl;
      if (add) {
        inputEl = row.querySelector(".pitch-idea-input");
        const text = inputEl.value.trim();
        if (!text) { msgEl.textContent = "spitball something first"; return; }
        const nl = text.indexOf("\n");
        body = { title: (nl === -1 ? text : text.slice(0, nl)).trim(), idea: text };
        url = BASE + "/api/pitches";
      } else {
        const pid = (grad || shv).getAttribute("data-pid");
        url = BASE + "/api/pitches/" + encodeURIComponent(pid) + (grad ? "/graduate" : "/shelve");
        body = shv ? { reason: "shelved from the dashboard" } : {};
      }
      if (!token) { msgEl.textContent = "admin token required"; return; }
      btn.disabled = true;
      const msg = msgEl;
      try {
        const res = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: "Bearer " + token },
          body: JSON.stringify(body)
        });
        const data = await res.json().catch(() => ({}));
        if (res.status === 401 || res.status === 403) {
          try { localStorage.removeItem(ADMIN_KEY); } catch { /* storage blocked */ }
        }
        if (!res.ok) throw new Error(data.error || "HTTP " + res.status);
        if (inputEl) inputEl.value = "";
        if (msg) msg.textContent = grad ? "graduated ✓ task " + (data.pitch && data.pitch.graduatedTo) : (add ? "pitched ✓" : "shelved");
        load();
      } catch (err) {
        if (msg) msg.textContent = String(err.message || err);
      } finally { btn.disabled = false; }
    });

    // inline answer flow: delegated click → admin token (prompted once, then
    // remembered in localStorage) → POST /api/questions/<id>/answer
    const postAnswer = async (id, text, msgEl) => {
      const token = adminToken();
      if (!token) { msgEl.textContent = "admin token required"; return; }
      try {
        const res = await fetch(BASE + "/api/questions/" + encodeURIComponent(id) + "/answer", {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: "Bearer " + token },
          body: JSON.stringify({ answer: text })
        });
        const data = await res.json().catch(() => ({}));
        if (res.status === 401 || res.status === 403) {
          try { localStorage.removeItem(ADMIN_KEY); } catch { /* storage blocked */ }
        }
        if (!res.ok) throw new Error(data.error || "HTTP " + res.status);
        msgEl.textContent = "answered ✓";
        load();
      } catch (e) {
        msgEl.textContent = String(e.message || e);
      }
    };

    dashRoot.addEventListener("click", (e) => {
      const btn = e.target.closest(".q-answer-btn");
      if (!btn || btn.classList.contains("task-add-btn") || btn.classList.contains("pitch-add-btn")) return;
      const row = btn.closest(".q-answer-row");
      const item = btn.closest("[data-qid]");
      const input = row.querySelector(".q-answer-input");
      const msg = row.querySelector(".q-answer-msg");
      const text = input ? input.value.trim() : "";
      if (!text) { msg.textContent = "write the answer first"; return; }
      if (!item) return;
      btn.disabled = true;
      postAnswer(item.getAttribute("data-qid"), text, msg).finally(() => { btn.disabled = false; });
    });

    let inFlight = false;
    const load = async () => {
      if (inFlight) return;
      inFlight = true;
      try {
        const [status, posts, images, fleet, qdata, tdata, pdata] = await Promise.all([
          fetchJSON("/api/status"),
          fetchJSON("/api/posts").catch(() => ({ posts: [] })),
          fetchJSON("/api/images").catch(() => ({ images: [] })),
          fetchJSON("/api/agents").catch(() => ({ agents: [] })),
          fetchJSON("/api/questions?status=all").catch(() => ({ questions: [] })),
          fetchJSON("/api/tasks?status=all").catch(() => ({ tasks: [] })),
          fetchJSON("/api/pitches?status=all").catch(() => ({ pitches: [] }))
        ]);
        renderDashboard(status, posts.posts || [], images.images || [], fleet.agents || [], qdata.questions || [], tdata.tasks || [], pdata.pitches || []);
      } catch {
        dashRoot.innerHTML = '<div class="empty">collector unreachable at <code>' +
          esc(BASE) + "</code> — is the hub running? <code>./start.sh</code></div>";
      } finally { inFlight = false; }
    };
    load();
    setInterval(load, REFRESH_MS);
  };

  /* ---------- blog list ---------- */

  const listRoot = document.getElementById("post-list-root");

  const initBlog = () => {
    setBodyWide();
    const load = async () => {
      try {
        const [posts, images, build] = await Promise.all([
          fetchJSON("/api/posts"),
          fetchJSON("/api/images").catch(() => ({ images: [] })),
          fetchJSON("/api/build").catch(() => ({ build: {} }))
        ]);
        const list = posts.posts || [];
        const media = (images.images || []).slice(0, 12);
        const builtIso = build.build && build.build.lastBuildAt;
        listRoot.innerHTML =
          section("Posts", list.length + " total",
            list.length ? '<div class="card-grid">' + list.map((p) => postCard(p, builtIso)).join("") + "</div>"
              : emptyBox("nothing posted yet")) +
          (media.length ? section("Media", "", '<div class="media-strip">' + media.map(mediaThumb).join("") + "</div>") : "");
      } catch {
        listRoot.innerHTML = '<div class="empty">collector unreachable — is the hub running?</div>';
      }
    };
    load();
    setInterval(load, REFRESH_MS);
  };

  if (dashRoot) initDashboard();
  if (listRoot) initBlog();
})();
