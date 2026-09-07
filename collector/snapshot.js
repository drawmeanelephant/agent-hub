'use strict';
// Snapshot collectors: GitHub state (via gh CLI) + local git working copies.
// Everything is read-only, best-effort, and cached; failures degrade to
// error notes in the snapshot rather than failing the hub.

const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');

function run(cmd, args, timeoutMs = 9000) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024, encoding: 'utf8' }, (err, stdout) => {
      if (err) reject(err);
      else resolve(stdout);
    });
  });
}

const j = (s) => { try { return JSON.parse(s); } catch { return null; } };

// ---------------- GitHub (via gh) ----------------

async function ghLogin() {
  const out = await run('gh', ['api', 'user', '--jq', '.login']);
  return String(out).trim();
}

function normalizeRepo(r) {
  if (!r || typeof r !== 'object') return null;
  const lang = r.primaryLanguage;
  return {
    name: r.name || '',
    nameWithOwner: r.nameWithOwner || (r.owner && r.owner.login ? r.owner.login + '/' + r.name : r.name || ''),
    description: r.description || '',
    language: lang && typeof lang === 'object' ? lang.name : (lang || ''),
    pushedAt: r.pushedAt || r.updatedAt || null,
    isPrivate: !!r.isPrivate,
    url: r.url || ('https://github.com/' + (r.nameWithOwner || '')),
  };
}

const EVENT_TEXT = {
  PushEvent: (e) => {
    const n = (e.payload && (e.payload.size || (e.payload.commits || []).length)) || 1;
    const branch = String((e.payload && e.payload.ref) || '').replace('refs/heads/', '');
    const first = e.payload && e.payload.commits && e.payload.commits[0];
    const msg = first && first.message ? ' — ' + String(first.message).split('\n')[0].slice(0, 90) : '';
    return 'pushed ' + n + ' commit' + (n === 1 ? '' : 's') + (branch ? ' to ' + branch : '') + msg;
  },
  PullRequestEvent: (e) => {
    const pr = (e.payload && e.payload.pull_request) || {};
    const label = pr.number != null ? 'PR #' + pr.number : 'a PR';
    const title = pr.title ? ' "' + String(pr.title).slice(0, 90) + '"' : '';
    return (e.payload && e.payload.action || 'updated') + ' ' + label + title;
  },
  PullRequestReviewEvent: (e) => {
    const pr = (e.payload && e.payload.pull_request) || {};
    const label = pr.number != null ? 'PR #' + pr.number : 'a PR';
    return 'reviewed ' + label;
  },
  IssuesEvent: (e) => {
    const issue = (e.payload && e.payload.issue) || {};
    const label = issue.number != null ? 'issue #' + issue.number : 'an issue';
    const title = issue.title ? ' "' + String(issue.title).slice(0, 90) + '"' : '';
    return (e.payload && e.payload.action || 'updated') + ' ' + label + title;
  },
  IssueCommentEvent: (e) => {
    const issue = (e.payload && e.payload.issue) || {};
    const label = issue.number != null ? 'issue #' + issue.number : 'an issue';
    return 'commented on ' + label;
  },
  WatchEvent: () => 'starred a repo',
  CreateEvent: (e) => 'created ' + (e.payload && e.payload.ref_type || 'ref') + ' ' + (e.payload && e.payload.ref || ''),
  ForkEvent: () => 'forked a repo',
  ReleaseEvent: (e) => 'released ' + (e.payload && e.payload.release && e.payload.release.tag_name || ''),
  DeleteEvent: (e) => 'deleted ' + (e.payload && e.payload.ref_type || 'ref'),
};

// Each GitHub source fails independently; partial data beats no data.
async function ghAll(cfg) {
  const parts = await Promise.allSettled([
    ghLogin(),
    run('gh', ['repo', 'list', '--limit', String(cfg.repoLimit || 40),
      '--json', 'name,nameWithOwner,owner,description,primaryLanguage,pushedAt,updatedAt,isPrivate,url']),
    run('gh', ['search', 'prs', '--author=@me', '--state=open', '--limit', String(cfg.prLimit || 20),
      '--json', 'repository,number,title,updatedAt,url,author']),
  ]);

  const out = { login: null, repos: [], events: [], prs: [], commits: [], errors: [] };
  const fail = (label, reason) => out.errors.push(label + ': ' + String(reason && reason.message || reason).replace(/\s+/g, ' ').slice(0, 140));

  if (parts[0].status === 'fulfilled') out.login = String(parts[0].value).trim();
  else fail('login', parts[0].reason);

  if (parts[1].status === 'fulfilled') {
    out.repos = (j(parts[1].value) || []).map(normalizeRepo).filter(Boolean)
      .sort((a, b) => String(b.pushedAt || '').localeCompare(String(a.pushedAt || '')));
  } else fail('repo list', parts[1].reason);

  if (parts[2].status === 'fulfilled') {
    out.prs = (j(parts[2].value) || []).map((p) => ({
      repo: p.repository && (p.repository.nameWithOwner || p.repository.name) || '',
      number: p.number,
      title: p.title,
      author: p.author && p.author.login,
      updatedAt: p.updatedAt,
      url: p.url,
    })).filter((p) => p.title);
  } else fail('pr search', parts[2].reason);

  // user activity: public events feed + recent commits across pushed repos
  if (out.login) {
    const eventJobs = Promise.allSettled([
      run('gh', ['api', 'users/' + out.login + '/events/public?per_page=40']),
      Promise.allSettled(out.repos.slice(0, 8).map((r) =>
        run('gh', ['api', 'repos/' + r.nameWithOwner + '/commits?per_page=3'])
          .then((out2) => ({ repo: r.nameWithOwner, commits: j(out2) || [] }))
      )),
    ]);

    const [evRes, commitRes] = await eventJobs;
    if (evRes.status === 'fulfilled') {
      // GitHub redacts PR/issue titles on the public events feed; enrich from
      // the open-PR list when we can, else show the number.
      const prTitles = new Map(
        out.prs.map((p) => [p.repo + '#' + p.number, p.title]));
      out.events = (j(evRes.value) || []).map((e) => {
        const ev = {
          type: e.type || '',
          actor: e.actor && e.actor.login,
          repo: e.repo && e.repo.name,
          at: e.created_at,
          text: (EVENT_TEXT[e.type] || (() => String(e.type || 'event'))) (e),
        };
        const pr = e.payload && e.payload.pull_request;
        if (e.type === 'PullRequestEvent' && pr && !pr.title && pr.number != null) {
          const short = String(ev.repo || '').split('/').pop();
          const known = prTitles.get(short + '#' + pr.number) || prTitles.get(String(ev.repo || '') + '#' + pr.number);
          if (known) ev.text = (e.payload.action || 'updated') + ' PR #' + pr.number + ' "' + String(known).slice(0, 90) + '"';
        }
        return ev;
      }).slice(0, cfg.eventLimit || 25);
    } else fail('events', evRes.reason);

    if (commitRes.status === 'fulfilled') {
      const commits = [];
      for (const r of commitRes.value) {
        if (r.status !== 'fulfilled') continue;
        for (const c of r.value.commits || []) {
          commits.push({
            repo: r.repo,
            sha: c.sha && c.sha.slice(0, 7),
            at: c.commit && c.commit.author && c.commit.author.date,
            author: (c.author && c.author.login) || (c.commit && c.commit.author && c.commit.author.name) || '',
            text: 'pushed ' + (c.sha ? c.sha.slice(0, 7) : '') + ' — ' +
              String((c.commit && c.commit.message) || '').split('\n')[0].slice(0, 110),
          });
        }
      }
      commits.sort((a, b) => String(b.at || '').localeCompare(String(a.at || '')));
      out.commits = commits.slice(0, 15);
    }
  }
  return out;
}

// ---------------- local git working copies ----------------

const SKIP_DIRS = new Set(['node_modules', 'dist', 'build', 'out', 'vendor', 'target',
  '.venv', 'venv', '__pycache__', '.cache', '.zcode', '.git']);

async function findGitDirs(root, maxDepth) {
  const found = [];
  async function walk(dir, depth) {
    let entries;
    try { entries = await fs.promises.readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (!e.isDirectory() || SKIP_DIRS.has(e.name) || e.name.startsWith('.')) continue;
      const full = path.join(dir, e.name);
      try {
        await fs.promises.access(path.join(full, '.git'));
        found.push(full);
        continue; // don't descend into repos
      } catch { /* not a repo */ }
      if (depth < maxDepth) await walk(full, depth + 1);
    }
  }
  await walk(root, 0);
  return found;
}

function nameWithOwnerFromRemote(url) {
  const m = /github\.com[:/](.+?)(?:\.git)?$/.exec(String(url || '').trim());
  return m ? m[1] : null;
}

async function inspectRepo(dir) {
  const info = { name: path.basename(dir), path: dir, branch: null, dirty: 0, ahead: 0, behind: 0, hasUpstream: false, lastCommit: null };
  const g = (...args) => run('git', ['-C', dir, ...args], 6000);
  try { info.branch = (await g('rev-parse', '--abbrev-ref', 'HEAD')).trim(); } catch { /* detached etc */ }
  try { info.dirty = (await g('status', '--porcelain')).split('\n').filter(Boolean).length; } catch { /* */ }
  try {
    await g('rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}');
    info.hasUpstream = true;
    const counts = (await g('rev-list', '--left-right', '--count', 'HEAD...@{u}')).trim().split(/\s+/);
    info.ahead = parseInt(counts[0] || '0', 10);
    info.behind = parseInt(counts[1] || '0', 10);
  } catch { /* no upstream */ }
  try {
    const line = (await g('log', '-1', '--pretty=format:%h%x09%aI%x09%an%x09%s')).trim();
    const [sha, date, author, ...rest] = line.split('\t');
    info.lastCommit = { sha, date, author, subject: rest.join('\t') };
  } catch { /* empty repo */ }
  try {
    info.github = nameWithOwnerFromRemote(await g('config', '--get', 'remote.origin.url'));
  } catch { /* no remote */ }
  return info;
}

async function localScan(cfg) {
  const scanRoot = path.resolve(cfg.ROOT, cfg.scanRoot || '..');
  const dirs = await findGitDirs(scanRoot, cfg.localScanDepth || 2);
  const repos = (await Promise.allSettled(dirs.map(inspectRepo)))
    .filter((r) => r.status === 'fulfilled').map((r) => r.value);
  repos.sort((a, b) => String((b.lastCommit && b.lastCommit.date) || '').localeCompare(String((a.lastCommit && a.lastCommit.date) || '')));
  return { scanRoot, repos };
}

// ---------------- cached snapshot ----------------
// Strategy: never block a request that can be answered with the last good
// snapshot. Stale data is served immediately while a rebuild runs in the
// background, and the last good snapshot is persisted to .runtime/ so a
// collector restart doesn't need a cold gh round-trip to answer.

let cache = { at: 0, data: null };
let pending = null;
let warm = false;

function snapPath(cfg) { return path.join(cfg.ROOT, '.runtime', 'snapshot.json'); }

function loadDisk(cfg) {
  try {
    const raw = JSON.parse(fs.readFileSync(snapPath(cfg), 'utf8'));
    if (raw && raw.at && raw.data) cache = raw;
  } catch { /* no snapshot on disk yet */ }
  warm = true;
}

function saveDisk(cfg) {
  try {
    fs.mkdirSync(path.join(cfg.ROOT, '.runtime'), { recursive: true });
    fs.writeFileSync(snapPath(cfg), JSON.stringify(cache));
  } catch { /* best-effort cache persistence */ }
}

async function build(cfg) {
  const [ghRes, localRes] = await Promise.allSettled([ghAll(cfg), localScan(cfg)]);
  const data = {
    github: ghRes.status === 'fulfilled'
      ? ghRes.value
      : { error: 'gh: ' + (ghRes.reason && ghRes.reason.message || 'unavailable'), repos: [], events: [], prs: [] },
    local: localRes.status === 'fulfilled'
      ? localRes.value
      : { scanRoot: cfg.scanRoot, error: String(localRes.reason || 'scan failed'), repos: [] },
  };
  return data;
}

async function getSnapshot(cfg, force = false) {
  if (!warm) loadDisk(cfg);
  const maxAge = (cfg.snapshotSeconds || 120) * 1000;
  const fresh = cache.data && !force && (Date.now() - cache.at) < maxAge;
  if (fresh) return cache.data;
  if (pending) return cache.data || pending; // latecomers share the in-flight build
  pending = build(cfg).then((data) => {
    cache = { at: Date.now(), data };
    pending = null;
    saveDisk(cfg);
    return data;
  }).catch((e) => {
    pending = null;
    throw e;
  });
  if (cache.data && !force) {
    pending.catch(() => {}); // background refresh; failures surface on the next request
    return cache.data;
  }
  return pending; // nothing to serve yet (or ?refresh=1): block on the build
}

function snapshotAge() { return cache.at ? Date.now() - cache.at : null; }

module.exports = { getSnapshot, snapshotAge };
