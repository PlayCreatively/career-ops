#!/usr/bin/env node
// Probe control + monitoring dashboard.
//
//   node probe-dashboard.mjs            # serve on http://localhost:7878
//   node probe-dashboard.mjs --port 9000
//
// A zero-dependency local web UI for probe-studios.mjs. It:
//   • lists every probe-capable ATS (auto-discovered from providers/*.mjs), with
//     its throttle status, the Retry-After wait it last handed back (counted down
//     live), "time since last checked", and ledger coverage (cleared/hit/open);
//   • launches a probe with the same knobs as the CLI (ATS targets, concurrency,
//     request-delay, per-host, waves, cooldown, patience, no-timeout, quick, …);
//   • streams the run live (pass, concurrency, pending/resolved/hits, stderr log)
//     over SSE, and shows the final hits / needs-review / uncertain tallies;
//   • persists per-ATS status to data/probe-status.json so the table survives
//     restarts and reflects the last time each ATS was actually contacted.
//
// Per-ATS parallelism: a "run" spawns ONE prober process per selected ATS (each
// with --ats <id>), so throttling is isolated per ATS — a rate-limited breezy can
// never hold up a fast greenhouse. Each instance writes its own live snapshot
// (data/.probe-live-<ats>.json) and its own ledger shard (data/.probe-ledger-<ats>.tsv,
// seeded from the main ledger); the server merges the shards back into
// data/probe-state.tsv as they progress, and shows one live progress bar per ATS.

import http from 'node:http';
import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync, readdirSync, copyFileSync } from 'node:fs';
import { pathToFileURL, fileURLToPath } from 'node:url';
import path from 'node:path';

// This server lives in probe/, so the repo root is its parent; data + providers
// are resolved there, while the prober it spawns sits beside it in probe/.
const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(SCRIPT_DIR, '..');
const PROBER = path.join(SCRIPT_DIR, 'probe-studios.mjs');
const PROVIDERS_DIR = path.join(ROOT, 'providers');
const LEDGER_FILE = path.join(ROOT, 'data', 'probe-state.tsv');
const PERSIST_FILE = path.join(ROOT, 'data', 'probe-status.json');
const HISTORY_FILE = path.join(ROOT, 'data', 'probe-history.json');
const SCHED_FILE = path.join(ROOT, 'data', 'probe-schedules.json');
const HITS_FILE = path.join(ROOT, 'data', 'probe-hits.json');
const STUDIOS_FILE = path.join(ROOT, 'studios.yml');
const HISTORY_MAX = 50; // keep the last N runs (newest first)
const SCHED_TICK_MS = 60000; // how often the scheduler checks for a due job

// Mirror of probe-studios.mjs KNOWN_THROTTLE_ATES — drives the "throttle-prone"
// badge and the auto-applied concurrency-1 + delay defaults in the prober.
const KNOWN_THROTTLE_ATES = new Set(['bamboohr', 'breezy', 'workable', 'workday']);

const portIdx = process.argv.indexOf('--port');
const PORT = portIdx !== -1 ? Number(process.argv[portIdx + 1]) : 7878;

// ── discover probe-capable ATSes (same rule the prober uses) ──────────
// Cached full descriptors (incl. the live slug-endpoint url + parse fns, which
// can't be JSON-serialized) so the canary sweep can hit each ATS directly.
let PROVIDERS = [];
async function loadProviders() {
  if (PROVIDERS.length) return PROVIDERS;
  const out = [];
  for (const f of readdirSync(PROVIDERS_DIR)) {
    if (!f.endsWith('.mjs') || f.startsWith('_')) continue;
    const id = f.replace(/\.mjs$/, '');
    let mod;
    try { mod = await import(pathToFileURL(path.join(PROVIDERS_DIR, f)).href); }
    catch { continue; }
    if (!mod.probe || !Array.isArray(mod.probe.endpoints)) continue;
    const slug = mod.probe.endpoints.find((e) => e.kind === 'slug');
    let domain = null;
    if (slug) { try { domain = new URL(slug.url('canary')).hostname.split('.').slice(-2).join('.'); } catch {} }
    out.push({
      id, domain,
      canary: mod.probe.canary || null,
      throttleProne: KNOWN_THROTTLE_ATES.has(id),
      slugUrl: slug ? slug.url : null,
      parse: slug ? slug.parse : null,
    });
  }
  out.sort((a, b) => a.id.localeCompare(b.id));
  PROVIDERS = out;
  return PROVIDERS;
}
// JSON-safe view (drops the function refs) for /api/state.
const serializeProvider = (p) => ({ id: p.id, domain: p.domain, canary: !!p.canary, canarySlug: p.canary, throttleProne: p.throttleProne });

// ── live canary ping: hit each ATS's known-live slug and read its real-time
// state, mirroring probe-studios.mjs classifyCanary semantics:
//   parseable 2xx  → live        (ATS up, not blocking us)
//   403 / 429      → throttled    (rate-limited / soft-banned; capture Retry-After)
//   5xx / network  → down         (hard block / outage)
//   404 / 410 / unparseable 2xx → stale (canary slug moved; ATS itself may be fine)
function parseRetryAfter(v) {
  if (!v) return null;
  const s = String(v).trim();
  if (/^\d+$/.test(s)) return parseInt(s, 10);
  const d = Date.parse(s);
  return Number.isNaN(d) ? null : Math.max(0, Math.round((d - Date.now()) / 1000));
}
async function pingCanary(p) {
  if (!p.canary || !p.slugUrl) return { state: 'no-canary' };
  const url = p.slugUrl(p.canary);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 9000);
  const t0 = Date.now();
  try {
    const res = await fetch(url, { signal: ctrl.signal, headers: { 'user-agent': 'Mozilla/5.0 (probe-dashboard canary)' } });
    const ms = Date.now() - t0;
    const ra = parseRetryAfter(res.headers.get('retry-after'));
    if (res.status === 403 || res.status === 429) return { state: 'throttled', http: res.status, retryAfterSec: ra, ms };
    if (res.status >= 500) return { state: 'down', http: res.status, ms };
    if (res.status === 404 || res.status === 410) return { state: 'stale', http: res.status, ms };
    if (res.ok) {
      let data = null;
      try { data = await res.json(); } catch { data = null; }
      return data != null ? { state: 'live', http: res.status, ms } : { state: 'stale', http: res.status, ms, detail: 'unparseable 2xx' };
    }
    return { state: 'uncertain', http: res.status, ms };
  } catch (e) {
    return { state: 'down', detail: e.name === 'AbortError' ? 'timeout' : (e.cause?.code || e.message), ms: Date.now() - t0 };
  } finally { clearTimeout(timer); }
}
// In-memory result of the last canary sweep (refreshed on startup + Refresh).
const canarySweep = { ts: null, running: false, results: {}, _inflight: null };
async function runCanarySweep() {
  // Coalesce concurrent callers onto the in-flight sweep so none gets a half-done
  // snapshot (e.g. the Refresh button racing the startup sweep).
  if (canarySweep._inflight) { await canarySweep._inflight; return canarySweep; }
  canarySweep.running = true;
  canarySweep._inflight = (async () => {
    try {
      const provs = await loadProviders();
      const pairs = await Promise.all(provs.map(async (p) => [p.id, await pingCanary(p)]));
      canarySweep.results = Object.fromEntries(pairs);
      canarySweep.ts = new Date().toISOString();
      // Fold throttle/live signal into the persistent store so "last checked" and
      // the Retry-After countdown reflect this ping too, not just full probe runs.
      const store = loadPersist();
      for (const [id, r] of pairs) {
        if (r.state === 'no-canary') continue;
        store[id] = {
          lastCheck: canarySweep.ts,
          throttled: r.state === 'throttled' || r.state === 'down',
          disabled: false,
          retryAfterSec: r.retryAfterSec ?? null,
          sampleHost: null,
          via: 'canary',
        };
      }
      savePersist(store);
    } finally { canarySweep.running = false; canarySweep._inflight = null; }
  })();
  await canarySweep._inflight;
  return canarySweep;
}

// ── ledger coverage: per-ATS cleared / hit counts ────────────────────
function ledgerCoverage(ids) {
  const cov = {};
  for (const id of ids) cov[id] = { cleared: 0, hit: 0, total: 0, lastProbe: null };
  if (!existsSync(LEDGER_FILE)) return { cov, total: 0 };
  let total = 0;
  for (const line of readFileSync(LEDGER_FILE, 'utf8').split('\n')) {
    if (!line || line.startsWith('#')) continue;
    const col = line.split('\t');
    if (col.length < 5) continue;
    total++;
    const hit = new Set((col[3] || '').split(',').map((s) => s.trim()).filter(Boolean));
    const missed = new Set((col[4] || '').split(',').map((s) => s.trim()).filter(Boolean));
    const date = (col[5] || '').trim() || null; // last_probe column (YYYY-MM-DD)
    for (const id of ids) {
      cov[id].total++;
      if (hit.has(id)) cov[id].hit++;
      else if (missed.has(id)) cov[id].cleared++;
      // Most recent date this ATS was actually probed for any studio — a real
      // "last checked" even for ATSes only ever run from the CLI (no persisted
      // throttle snapshot), so the table isn't blank/"never" for them.
      if ((hit.has(id) || missed.has(id)) && date && date > (cov[id].lastProbe || '')) cov[id].lastProbe = date;
    }
  }
  return { cov, total };
}

// ── per-ATS ledger shards (parallel-run support) ─────────────────────
// In per-ATS mode each prober instance writes its own ledger shard so concurrent
// processes never clobber the one shared probe-state.tsv. These three helpers fold
// the shards back into the main ledger. They mirror probe-studios.mjs's
// loadLedger/writeLedger/mergeLedger format; a kept-local copy keeps the dashboard
// decoupled from the prober module. Union semantics are correct here because every
// shard is seeded from main at the SAME scan version (the prober's stale-version
// reset never triggers), so merging only ever ADDS cleared/hit cells.
function parseLedger(file) {
  const m = new Map();
  if (!existsSync(file)) return m;
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const t = line.trimEnd(); if (!t || t.startsWith('#')) continue;
    const [key, name, version, hit, missed, last, conf] = t.split('\t');
    if (!key) continue;
    m.set(key, { name: name || '', version: Number(version) || 0, hit: hit || '', hitConf: conf || '', missed: new Set((missed || '').split(',').filter(Boolean)), last: last || '' });
  }
  return m;
}
function serializeLedger(m) {
  const rows = [
    '# probe-state ledger — per-studio ATS coverage so re-runs skip already-cleared work.',
    '# Written by probe-studios.mjs / probe-dashboard.mjs (per-ATS shard merge).',
    '# hit_confidence: high|medium = trusted win, verify = namesake risk (needs review), empty = legacy.',
    '# name_norm\tname\tscan_version\thit_ats\tmissed_ats(csv)\tlast_probe\thit_confidence',
  ];
  for (const [key, v] of [...m.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    rows.push([key, v.name, v.version, v.hit, [...v.missed].sort().join(','), v.last, v.hitConf || ''].join('\t'));
  }
  return rows.join('\n') + '\n';
}
// Fold every per-ATS shard back into the main ledger. Each shard ran one ATS, so it
// differs from main only in that ATS's column → union missed-sets, keep the first
// hit. Idempotent, so it's safe to call repeatedly DURING a run (coverage bars climb
// live) as well as on completion.
function mergeShardsIntoMain(instances) {
  const main = parseLedger(LEDGER_FILE);
  let touched = false;
  for (const inst of instances) {
    const shard = parseLedger(inst.ledgerFile);
    for (const [key, s] of shard) {
      const prev = main.get(key);
      if (!prev) { main.set(key, { ...s, missed: new Set(s.missed) }); touched = true; continue; }
      for (const id of s.missed) { if (!prev.missed.has(id)) { prev.missed.add(id); touched = true; } }
      if (!prev.hit && s.hit) { prev.hit = s.hit; prev.hitConf = s.hitConf; touched = true; }
      prev.version = Math.max(prev.version, s.version);
      if (s.last > prev.last) { prev.last = s.last; touched = true; }
      if (!prev.name && s.name) prev.name = s.name;
    }
  }
  if (touched) { try { writeFileSync(LEDGER_FILE, serializeLedger(main)); } catch {} }
}

// ── persistent per-ATS status store ──────────────────────────────────
function loadPersist() {
  if (!existsSync(PERSIST_FILE)) return {};
  try { return JSON.parse(readFileSync(PERSIST_FILE, 'utf8')); } catch { return {}; }
}
function savePersist(obj) {
  try { writeFileSync(PERSIST_FILE, JSON.stringify(obj, null, 2)); } catch {}
}
// Fold the prober's final live snapshot into the persistent store: every provider
// it actually contacted gets its lastCheck + throttle/wait refreshed.
function foldSnapshotIntoPersist(snap) {
  if (!snap || !snap.providers) return;
  const store = loadPersist();
  for (const [id, p] of Object.entries(snap.providers)) {
    store[id] = {
      lastCheck: snap.ts,
      throttled: !!p.throttled,
      disabled: !!p.disabled,
      retryAfterSec: p.retryAfterSec ?? null,
      sampleHost: p.sampleHost ?? null,
    };
  }
  savePersist(store);
}
function readLiveFile(file) {
  if (!existsSync(file)) return null;
  try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return null; }
}
// Aggregate the live snapshots of every running instance into one view the client
// renders as N progress bars: a per-instance `instances[]` (each ATS's own wave),
// a merged `providers` map (one throttle entry per ATS, for the table overlay +
// persist fold), and summed `progress` for the headline counters.
function readLive() {
  if (!current || !current.instances || !current.instances.length) return null;
  const instances = []; const providers = {};
  let ts = null, pass = 0, pending = 0, resolved = 0, hits = 0;
  for (const inst of current.instances) {
    const snap = readLiveFile(inst.liveFile);
    const pr = (snap && snap.progress) || {};
    instances.push({ ats: inst.ats, status: inst.status, phase: snap ? snap.phase : (inst.status === 'running' ? 'starting' : inst.status), progress: pr });
    if (snap && snap.ts && (!ts || snap.ts > ts)) ts = snap.ts;
    if (snap && snap.providers) Object.assign(providers, snap.providers);
    pass = Math.max(pass, Number(pr.pass) || 0);
    pending += Number(pr.pending) || 0; resolved += Number(pr.resolved) || 0; hits += Number(pr.hits) || 0;
  }
  return { ts: ts || new Date().toISOString(), instances, providers, progress: { pass, pending, resolved, hits } };
}

// ── run history ──────────────────────────────────────────────────────
// A rolling log of completed probe runs (newest first) so the dashboard can show
// whether draining is progressing across runs. Persisted to data/probe-history.json
// (gitignored); each record is a compact summary, never the full hit list.
function loadHistory() {
  if (!existsSync(HISTORY_FILE)) return [];
  try { const h = JSON.parse(readFileSync(HISTORY_FILE, 'utf8')); return Array.isArray(h) ? h : []; } catch { return []; }
}
function appendHistory(rec) {
  const h = loadHistory();
  h.unshift(rec);
  try { writeFileSync(HISTORY_FILE, JSON.stringify(h.slice(0, HISTORY_MAX), null, 2)); } catch {}
}
// Summarize a finished run into one history row. `result` is the prober's JSON
// (null if it crashed / was killed before emitting); `params` is what was launched.
function summarizeRun(params, result, startedAt, status) {
  const targets = (params && params.ats) ? params.ats : 'all';
  return {
    ts: new Date(startedAt).toISOString(),
    durationMs: Date.now() - startedAt,
    status,
    targets,
    noTimeout: !!(params && params.noTimeout),
    hits: result ? (result.trustedHits?.length ?? 0) : 0,
    review: result ? (result.reviewHits?.length ?? 0) : 0,
    uncertain: result ? (result.uncertain?.length ?? 0) : 0,
    cleanMisses: result ? (result.cleanMisses ?? 0) : 0,
    ledgerSkipped: result ? (result.ledgerSkipped ?? 0) : 0,
    passes: result ? (result.passes ?? 0) : 0,
  };
}

// ── pending-hits store ───────────────────────────────────────────────
// Probe hits (name + ATS + canonical careers_url) accumulate across runs and are
// only "done" once added to studios.yml. The prober's hit list lives only in the
// per-run result (memory), so a hit found two runs ago that you never added would
// vanish from the UI. This durable store (data/probe-hits.json, gitignored) unions
// every run's hits, keyed by name|careers_url, and is pruned of anything already
// in studios.yml — so the dashboard always shows the FULL backlog of unacted hits,
// not just the last run's. Added/duplicate hits drop out automatically on prune.
function loadPendingHits() {
  if (!existsSync(HITS_FILE)) return [];
  try { const h = JSON.parse(readFileSync(HITS_FILE, 'utf8')); return Array.isArray(h) ? h : []; } catch { return []; }
}
function savePendingHits(list) {
  try { writeFileSync(HITS_FILE, JSON.stringify(list, null, 2)); } catch {}
}
const pendingHitKey = (h) => `${(h.name || '').trim().toLowerCase()}|${h.careersUrl || ''}`;
// Fold a finished run's hits into the store (union by key; keep the freshest
// metadata, preserve the original firstSeen). Only hits carrying a canonical
// careersUrl are storable (others can't be one-click added anyway).
function mergeHitsIntoStore(hits) {
  if (!Array.isArray(hits) || !hits.length) return;
  const store = loadPendingHits();
  const byKey = new Map(store.map((h) => [pendingHitKey(h), h]));
  const now = new Date().toISOString();
  for (const h of hits) {
    if (!h || !h.careersUrl || !h.provider) continue;
    const key = pendingHitKey(h);
    const prev = byKey.get(key);
    byKey.set(key, { ...h, firstSeen: prev?.firstSeen || now, lastSeen: now });
  }
  savePendingHits([...byKey.values()]);
}
// Drop hits already present in studios.yml (added since, or duplicates). Returns
// the live list; rewrites the file when it shrank so the store self-heals.
function prunePendingHits() {
  const store = loadPendingHits();
  if (!store.length) return store;
  const content = existsSync(STUDIOS_FILE) ? readFileSync(STUDIOS_FILE, 'utf8') : '';
  const live = store.filter((h) => !studioExists(content, h.name, h.careersUrl));
  if (live.length !== store.length) savePendingHits(live);
  return live;
}

// ── recurring schedules ──────────────────────────────────────────────
// Auto re-probe on a cadence (e.g. drain breezy every 24h) so a throttled ATS
// keeps getting chipped at without you babysitting the dashboard. Schedules live
// in data/probe-schedules.json (gitignored) and are re-armed on startup. A single
// master tick checks for due jobs; one only fires if no probe is already running
// (the prober is the bottleneck — a scheduled run waits its turn, never stacks).
// NOTE: schedules only fire while this dashboard process is running; closing it
// pauses them (they resume, recomputing next-run, when you relaunch).
function loadSchedules() {
  if (!existsSync(SCHED_FILE)) return [];
  try { const s = JSON.parse(readFileSync(SCHED_FILE, 'utf8')); return Array.isArray(s) ? s : []; } catch { return []; }
}
function saveSchedules(list) {
  try { writeFileSync(SCHED_FILE, JSON.stringify(list, null, 2)); } catch {}
}
function addSchedule(params, everyHours) {
  const h = Number(everyHours);
  if (!Number.isFinite(h) || h < 0.25 || h > 720) return { ok: false, error: 'everyHours must be between 0.25 and 720' };
  const list = loadSchedules();
  const now = Date.now();
  const rec = {
    id: 's' + now.toString(36) + Math.random().toString(36).slice(2, 6),
    params: params || {},
    everyHours: h,
    createdAt: new Date(now).toISOString(),
    lastRun: null,
    nextRun: now + h * 3600e3,
    enabled: true,
  };
  list.push(rec);
  saveSchedules(list);
  return { ok: true, schedule: rec };
}
function deleteSchedule(id) {
  const list = loadSchedules();
  const next = list.filter((s) => s.id !== id);
  if (next.length === list.length) return { ok: false, error: 'no such schedule' };
  saveSchedules(next);
  return { ok: true };
}
// A compact, label-friendly view of a schedule's target for the UI.
function schedTarget(s) { return (s.params && s.params.ats) ? s.params.ats : 'all'; }
// Master tick: fire the soonest due, enabled schedule if nothing's running.
function schedulerTick() {
  if (current && current.status === 'running') return; // bottleneck busy — try next tick
  const list = loadSchedules();
  const now = Date.now();
  const due = list.filter((s) => s.enabled && typeof s.nextRun === 'number' && s.nextRun <= now)
                  .sort((a, b) => a.nextRun - b.nextRun);
  if (!due.length) return;
  const job = due[0];
  job.lastRun = new Date(now).toISOString();
  job.nextRun = now + job.everyHours * 3600e3;
  saveSchedules(list);
  // Resolve the ATS instance list (async — needs the provider list), then launch
  // one process per ATS, same as a manual run.
  (async () => {
    try {
      const providers = await loadProviders();
      const ids = expandIds(job.params || {}, providers.map((p) => p.id));
      if (!ids.length) { process.stderr.write(`Scheduled probe ${job.id}: no ATS resolved, skipped.\n`); return; }
      startProbe(ids, job.params || {});
      process.stdout.write(`Scheduled probe fired: ${job.id} (target=${schedTarget(job)}, ${ids.length} instance(s))\n`);
    } catch (e) {
      process.stderr.write(`Scheduled probe ${job.id} failed to start: ${e.message}\n`);
    }
  })();
}

// ── one-click "add hit to studios.yml" ───────────────────────────────
// Append a probe hit as a tracked studio, mirroring the manual merge format
// (grouped `provider:` + `careers_url:`). Idempotent on the studio name and the
// careers_url host: a duplicate is reported, never double-written. The hit carries
// `provider` + `careersUrl` straight from the prober (each provider builds its own
// canonical URL), so the dashboard does no ATS-shape guessing.
const STUDIO_NAME_RE = /^\s*-\s+name:\s+"?([^"\n]+)"?/gm;
function studioExists(content, name, careersUrl) {
  const lc = name.trim().toLowerCase();
  for (const m of content.matchAll(STUDIO_NAME_RE)) {
    if (m[1].trim().toLowerCase() === lc) return `name "${name}" already tracked`;
  }
  let host = '';
  try { host = new URL(careersUrl).hostname.toLowerCase().replace(/^www\./, ''); } catch {}
  // host+path uniqueness for shared-host ATSes (jobs.lever.co/<slug>, etc.).
  if (careersUrl && content.includes(careersUrl)) return `careers_url ${careersUrl} already tracked`;
  return null;
}
function addStudio({ name, provider, careersUrl }, knownProviderIds) {
  if (!name || typeof name !== 'string') return { ok: false, error: 'missing name' };
  if (!provider || !knownProviderIds.has(provider)) return { ok: false, error: `unknown provider "${provider}"` };
  let u;
  try { u = new URL(careersUrl); } catch { return { ok: false, error: `invalid careers_url: ${careersUrl}` }; }
  if (u.protocol !== 'https:') return { ok: false, error: 'careers_url must be https' };
  if (!existsSync(STUDIOS_FILE)) return { ok: false, error: 'studios.yml not found' };
  const content = readFileSync(STUDIOS_FILE, 'utf8');
  const dup = studioExists(content, name, careersUrl);
  if (dup) return { ok: false, duplicate: true, error: dup };
  // Escape a double-quote in the name so the YAML stays valid.
  const safeName = name.replace(/"/g, '\\"');
  const block = `\n  # Added from probe dashboard (${new Date().toISOString().slice(0, 10)})\n` +
    `  - name: "${safeName}"\n    provider: ${provider}\n    careers_url: ${careersUrl}\n`;
  const tail = content.endsWith('\n') ? '' : '\n';
  writeFileSync(STUDIOS_FILE, content + tail + block);
  return { ok: true, name, provider, careersUrl };
}

// ── current run state ────────────────────────────────────────────────
// A run is a SET of per-ATS instances. current.status is the aggregate ('running'
// until every instance exits); current.instances[] each hold their own child,
// stdout/result, live snapshot file and ledger shard.
let current = null; // { startedAt, status, params, log:[], result, error, clients:Set, liveTimer, instances:[], args:[] }

function broadcast(event, data) {
  if (!current) return;
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of current.clients) { try { res.write(payload); } catch {} }
}

// Build the CLI for ONE per-ATS instance: a single --ats, its own live snapshot
// file and ledger shard. (skipAts is resolved up-front into the instance list, so
// it's never passed to the prober.)
function buildArgs(p, ats, liveFile, ledgerFile) {
  const a = [PROBER];
  if (p.backlog !== false) a.push('--backlog');
  if (p.includeBlocked) a.push('--include-blocked');
  a.push('--ats', ats);
  if (Number(p.concurrency) > 0) a.push('--concurrency', String(p.concurrency));
  if (Number(p.requestDelay) > 0) a.push('--request-delay', String(p.requestDelay));
  if (Number(p.perHost) > 0) a.push('--per-host', String(p.perHost));
  if (Number(p.maxPasses) > 0) a.push('--max-passes', String(p.maxPasses));
  if (Number(p.cooldown) > 0) a.push('--cooldown', String(p.cooldown));
  if (Number(p.patience) > 0) a.push('--patience', String(p.patience));
  if (p.noTimeout) a.push('--no-timeout');
  if (p.quick) a.push('--quick');
  if (p.reprobeAll) a.push('--reprobe-all');
  a.push('--json', '--status-file', liveFile, '--ledger', ledgerFile);
  return a;
}

// Resolve which ATSes a run should launch as separate instances: the picked set,
// or ALL discovered providers when none picked, minus any skip list. There's no
// reason to probe one ATS at a time — each becomes its own process so a throttled
// ATS only ever slows itself.
function expandIds(params, allIds) {
  let ids = params.ats ? String(params.ats).split(',').map((s) => s.trim()).filter(Boolean) : allIds.slice();
  if (params.skipAts) { const drop = new Set(String(params.skipAts).split(',').map((s) => s.trim()).filter(Boolean)); ids = ids.filter((i) => !drop.has(i)); }
  return [...new Set(ids)];
}

// A filesystem-safe token for an ATS id (provider ids are already [a-z0-9-], but
// be defensive about anything used to build a shard filename).
const safeAts = (id) => String(id).replace(/[^a-z0-9_-]/gi, '_');

// Merge one finished/aggregate set of instance results into the prober's JSON
// shape the results panel + history expect. Hits/review/uncertain concat cleanly
// (each is a real per-ATS finding); counters sum (fuzzy across per-ATS runs but
// only cosmetic); passes = the deepest wave any instance reached.
function mergedResult(instances) {
  if (instances.every((i) => i.result == null)) return null;
  const acc = { hits: [], trustedHits: [], reviewHits: [], uncertain: [], cleanMisses: 0, ledgerSkipped: 0, passes: 0, disabledProviders: [] };
  for (const i of instances) {
    const r = i.result; if (!r) continue;
    acc.hits.push(...(r.hits || []));
    acc.trustedHits.push(...(r.trustedHits || []));
    acc.reviewHits.push(...(r.reviewHits || []));
    acc.uncertain.push(...(r.uncertain || []));
    acc.cleanMisses += r.cleanMisses || 0;
    acc.ledgerSkipped += r.ledgerSkipped || 0;
    acc.passes = Math.max(acc.passes, r.passes || 0);
    acc.disabledProviders.push(...(r.disabledProviders || []));
  }
  return acc;
}

// Finalize once EVERY instance has exited: stop the live tick, fold shards into the
// main ledger one last time, log history, and fire a single aggregate `done`.
function finalizeRun() {
  if (!current || current.status !== 'running') return;
  if (current.liveTimer) { clearInterval(current.liveTimer); current.liveTimer = null; }
  mergeShardsIntoMain(current.instances);
  const anyDone = current.instances.some((i) => i.status === 'done');
  current.status = anyDone ? 'done' : 'error';
  current.durationMs = Date.now() - current.startedAt;
  current.result = mergedResult(current.instances);
  // Bank this run's hits into the durable cross-run store so they stay actionable
  // until added to studios.yml (not just until the next run overwrites the panel).
  if (current.result) mergeHitsIntoStore([...(current.result.trustedHits || []), ...(current.result.reviewHits || [])]);
  current.error = current.status === 'error' ? ((current.instances.find((i) => i.error) || {}).error || 'all instances failed') : null;
  const targetParams = { ...current.params, ats: current.instances.map((i) => i.ats).join(',') };
  if (current.result || current.status === 'done') {
    appendHistory(summarizeRun(targetParams, current.result, current.startedAt, current.status));
  }
  broadcast('done', { status: current.status, result: current.result, error: current.error, startedAt: current.startedAt, durationMs: current.durationMs, params: targetParams });
}

// One instance exited (or failed to spawn). Idempotent per instance (close + error
// can both fire). Folds its shard into main + persists its throttle snapshot, then
// finalizes the run if it was the last one standing.
function onInstanceClose(inst, code) {
  if (inst.done) return;
  inst.done = true;
  if (inst.status === 'running') inst.status = code === 0 ? 'done' : 'error';
  inst.durationMs = Date.now() - inst.startedAt;
  try { inst.result = JSON.parse(inst.stdout); } catch { inst.result = null; }
  if (code !== 0 && !inst.result && !inst.error) inst.error = `exit ${code}`;
  mergeShardsIntoMain([inst]);
  foldSnapshotIntoPersist(readLiveFile(inst.liveFile));
  if (current && current.instances.every((i) => i.done)) finalizeRun();
}

// Launch a run: one prober process per ATS in `ids`, each into its own shard.
function startProbe(ids, params) {
  current = { params, startedAt: Date.now(), status: 'running', log: [], result: null, error: null, clients: new Set(), liveTimer: null, instances: [], args: [] };
  for (const ats of ids) {
    const liveFile = path.join(ROOT, 'data', `.probe-live-${safeAts(ats)}.json`);
    const ledgerFile = path.join(ROOT, 'data', `.probe-ledger-${safeAts(ats)}.tsv`);
    // Seed the shard from the main ledger so this instance skips studios already
    // cleared for its ATS and only re-probes what's still open.
    try { if (existsSync(LEDGER_FILE)) copyFileSync(LEDGER_FILE, ledgerFile); else writeFileSync(ledgerFile, ''); } catch {}
    // Clear any stale live snapshot from a PRIOR run before spawning — otherwise
    // the live panel / table overlay reads the old file and shows a phantom
    // throttle for this ATS before the fresh prober has written a single wave.
    try { if (existsSync(liveFile)) writeFileSync(liveFile, ''); } catch {}
    const args = buildArgs(params, ats, liveFile, ledgerFile);
    const inst = { ats, args, status: 'running', startedAt: Date.now(), stdout: '', result: null, error: null, durationMs: null, liveFile, ledgerFile, done: false, child: null };
    const child = spawn(process.execPath, args, { cwd: ROOT });
    inst.child = child;
    child.stdout.on('data', (d) => { inst.stdout += d.toString(); });
    let buf = '';
    child.stderr.on('data', (d) => {
      buf += d.toString();
      const lines = buf.split('\n');
      buf = lines.pop();
      for (const line of lines) {
        if (!line.trim()) continue;
        const l = `[${ats}] ${line}`;
        current.log.push(l);
        if (current.log.length > 1500) current.log.shift();
        broadcast('log', { line: l });
      }
      broadcast('live', readLive());
    });
    child.on('close', (code) => {
      if (buf.trim()) { const l = `[${ats}] ${buf}`; current.log.push(l); broadcast('log', { line: l }); }
      onInstanceClose(inst, code);
    });
    child.on('error', (err) => { if (inst.status === 'running') { inst.status = 'error'; inst.error = err.message; } onInstanceClose(inst, 1); });
    current.instances.push(inst);
    current.args.push(args);
  }
  // Steady tick: merge shards into the main ledger (so coverage bars climb live)
  // and push the aggregated snapshot to clients, independent of stderr chatter.
  current.liveTimer = setInterval(() => { mergeShardsIntoMain(current.instances); broadcast('live', readLive()); }, 1500);
  return current.args;
}

// ── HTTP ─────────────────────────────────────────────────────────────
function sendJSON(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(obj));
}
function readBody(req) {
  return new Promise((resolve) => {
    let b = ''; req.on('data', (c) => (b += c)); req.on('end', () => { try { resolve(JSON.parse(b || '{}')); } catch { resolve({}); } });
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);

  if (url.pathname === '/') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(HTML);
    return;
  }

  if (url.pathname === '/api/state') {
    const providers = await loadProviders();
    const ids = providers.map((p) => p.id);
    const { cov } = ledgerCoverage(ids);
    const persist = loadPersist();
    const rows = providers.map((p) => ({
      ...serializeProvider(p),
      coverage: cov[p.id],
      status: persist[p.id] || null,
      canaryResult: canarySweep.results[p.id] || null,
    }));
    sendJSON(res, 200, {
      providers: rows,
      canary: { ts: canarySweep.ts, running: canarySweep.running },
      run: current ? { status: current.status, args: current.args, startedAt: current.startedAt, result: current.result, error: current.error } : null,
      live: readLive(),
      history: loadHistory().slice(0, 20),
      schedules: loadSchedules(),
      pendingHits: prunePendingHits(),
    });
    return;
  }

  // Recurring schedule: create / delete an auto re-probe job.
  if (url.pathname === '/api/schedule' && req.method === 'POST') {
    const body = await readBody(req);
    const r = addSchedule(body.params, body.everyHours);
    sendJSON(res, r.ok ? 200 : 400, r);
    return;
  }
  if (url.pathname === '/api/schedule/delete' && req.method === 'POST') {
    const body = await readBody(req);
    const r = deleteSchedule(body.id);
    sendJSON(res, r.ok ? 200 : 404, r);
    return;
  }

  // One-click: append a probe hit to studios.yml (trusted add / namesake confirm).
  if (url.pathname === '/api/add-studio' && req.method === 'POST') {
    const body = await readBody(req);
    const providers = await loadProviders();
    const ids = new Set(providers.map((p) => p.id));
    const r = addStudio(body, ids);
    // Added or already-tracked → it's no longer pending; drop it from the store.
    if (r.ok || r.duplicate) {
      const key = `${(body.name || '').trim().toLowerCase()}|${body.careersUrl || ''}`;
      savePendingHits(loadPendingHits().filter((h) => pendingHitKey(h) !== key));
    }
    sendJSON(res, r.ok ? 200 : (r.duplicate ? 409 : 400), r);
    return;
  }

  // Active canary sweep: ping every ATS's known-live slug NOW (startup + Refresh).
  if (url.pathname === '/api/refresh' && req.method === 'POST') {
    await runCanarySweep();
    sendJSON(res, 200, { ts: canarySweep.ts, results: canarySweep.results });
    return;
  }

  if (url.pathname === '/api/probe' && req.method === 'POST') {
    if (current && current.status === 'running') { sendJSON(res, 409, { error: 'A probe is already running.' }); return; }
    const params = await readBody(req);
    const providers = await loadProviders();
    const ids = expandIds(params, providers.map((p) => p.id));
    if (!ids.length) { sendJSON(res, 400, { error: 'No ATS resolved to probe.' }); return; }
    const args = startProbe(ids, params);
    sendJSON(res, 200, { ok: true, instances: ids, args });
    return;
  }

  if (url.pathname === '/api/stop' && req.method === 'POST') {
    if (current && current.status === 'running') { for (const i of current.instances) { try { i.child.kill('SIGTERM'); } catch {} } sendJSON(res, 200, { ok: true }); }
    else sendJSON(res, 200, { ok: false, note: 'no run active' });
    return;
  }

  if (url.pathname === '/api/log') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    res.write('\n');
    if (current) {
      for (const line of current.log) res.write(`event: log\ndata: ${JSON.stringify({ line })}\n\n`);
      res.write(`event: live\ndata: ${JSON.stringify(readLive())}\n\n`);
      if (current.status !== 'running') res.write(`event: done\ndata: ${JSON.stringify({ status: current.status, result: current.result, error: current.error, startedAt: current.startedAt, durationMs: current.durationMs, params: current.params })}\n\n`);
      current.clients.add(res);
      req.on('close', () => { if (current) current.clients.delete(res); });
    }
    return;
  }

  res.writeHead(404); res.end('not found');
});

const HTML = String.raw`<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Probe Dashboard</title>
<style>
:root{--bg:#0f1115;--panel:#171a21;--panel2:#1e222b;--line:#2a2f3a;--fg:#e6e8ec;--muted:#8b93a1;--ok:#39d98a;--warn:#f5a623;--bad:#ff5f56;--accent:#5b9dff}
*{box-sizing:border-box}
body{margin:0;font:14px/1.5 ui-sans-serif,system-ui,Segoe UI,Roboto,sans-serif;background:var(--bg);color:var(--fg)}
h1{font-size:18px;margin:0}h2{font-size:13px;text-transform:uppercase;letter-spacing:.08em;color:var(--muted);margin:0 0 10px}
header{display:flex;align-items:center;gap:14px;padding:14px 20px;border-bottom:1px solid var(--line);position:sticky;top:0;background:var(--bg);z-index:5}
header .spacer{flex:1}
.wrap{display:grid;grid-template-columns:1fr 380px;gap:16px;padding:16px 20px;align-items:start}
@media(max-width:1000px){.wrap{grid-template-columns:1fr}}
.panel{background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:14px;margin-bottom:16px}
table{width:100%;border-collapse:collapse}
th,td{text-align:left;padding:7px 8px;border-bottom:1px solid var(--line);vertical-align:middle}
th{color:var(--muted);font-weight:600;font-size:12px}
td.id{font-weight:600}
.badge{display:inline-block;padding:1px 7px;border-radius:20px;font-size:11px;font-weight:600}
.b-ok{background:rgba(57,217,138,.15);color:var(--ok)}
.b-warn{background:rgba(245,166,35,.15);color:var(--warn)}
.b-bad{background:rgba(255,95,86,.15);color:var(--bad)}
.b-mut{background:rgba(139,147,161,.15);color:var(--muted)}
.bar{height:7px;border-radius:4px;background:var(--panel2);overflow:hidden;display:flex;min-width:90px}
.bar i{display:block;height:100%}
.bar .c{background:var(--ok)}.bar .h{background:var(--accent)}.bar .o{background:#3a3f4b}
.small{font-size:11px;color:var(--muted)}
button{background:var(--accent);color:#06101f;border:0;border-radius:7px;padding:8px 14px;font-weight:600;cursor:pointer}
button.ghost{background:var(--panel2);color:var(--fg);border:1px solid var(--line)}
button:disabled{opacity:.45;cursor:not-allowed}
label{display:block;font-size:12px;color:var(--muted);margin:9px 0 3px}
input[type=number],input[type=text],select{width:100%;background:var(--panel2);border:1px solid var(--line);color:var(--fg);border-radius:6px;padding:6px 8px}
.row{display:grid;grid-template-columns:1fr 1fr;gap:10px}
.chk{display:flex;align-items:center;gap:7px;margin:6px 0;color:var(--fg);font-size:13px}
.chk input{width:auto}
.atspick{display:flex;flex-wrap:wrap;gap:6px;margin-top:4px}
.atspick label{display:inline-flex;align-items:center;gap:5px;background:var(--panel2);border:1px solid var(--line);border-radius:20px;padding:3px 10px;margin:0;color:var(--fg);cursor:pointer;font-size:12px}
.atspick label.tp{border-color:rgba(245,166,35,.5)}
.nums{display:grid;grid-template-columns:repeat(4,1fr);gap:10px;text-align:center}
.nums .k{font-size:22px;font-weight:700}.nums .l{font-size:11px;color:var(--muted)}
.pbar{height:9px;border-radius:5px;background:var(--panel2);overflow:hidden;margin:12px 0 2px}
.pbar i{display:block;height:100%;width:0;background:var(--ok);transition:width .35s ease}
.pbar.indet i{width:35%;background:var(--accent);animation:slide 1.1s ease-in-out infinite}
@keyframes slide{0%{margin-left:-35%}100%{margin-left:100%}}
#livebars{margin:10px 0 2px}
.ibar{margin:9px 0}
.ibl{display:flex;justify-content:space-between;align-items:baseline;margin-bottom:3px}
.ibl b{color:var(--accent)}
.ibar.done .pbar i{background:var(--ok)}
.ibar.err .pbar i{background:var(--bad)}
#log{background:#0a0c10;border:1px solid var(--line);border-radius:8px;padding:10px;height:260px;overflow:auto;font:12px/1.5 ui-monospace,Menlo,Consolas,monospace;white-space:pre-wrap;color:#cdd3dd}
.dot{display:inline-block;width:8px;height:8px;border-radius:50%;margin-right:6px}
.live .dot{background:var(--ok);animation:pulse 1.2s infinite}
@keyframes pulse{50%{opacity:.3}}
.results .grp{margin-top:10px}.results .grp b{color:var(--accent)}
.hit{font-size:12px;padding:4px 0;border-bottom:1px solid var(--line);display:flex;justify-content:space-between;align-items:center;gap:8px}
.hit .meta{min-width:0}
.hitact{display:flex;align-items:center;gap:8px;flex:none;white-space:nowrap}
button.mini{padding:3px 9px;font-size:11px;border-radius:5px}
button.mini.confirm{background:var(--warn);color:#1a1205}
.added{color:var(--ok);font-weight:600;font-size:11px}
.dup{color:var(--muted);font-size:11px}
a{color:var(--accent)}
tr.ready{background:rgba(57,217,138,.06)}
tr.ready td.id{box-shadow:inset 3px 0 0 var(--ok)}
#nudge{display:none;margin:0 0 12px;padding:9px 12px;border:1px solid rgba(57,217,138,.4);background:rgba(57,217,138,.08);border-radius:8px;font-size:12px;align-items:center;gap:10px}
#nudge.show{display:flex}
#nudge b{color:var(--ok)}
.hist{width:100%;border-collapse:collapse;font-size:12px}
.hist th,.hist td{text-align:left;padding:4px 6px;border-bottom:1px solid var(--line)}
.hist th{color:var(--muted);font-weight:600}
.hist .n{font-variant-numeric:tabular-nums}
.schedrow{display:flex;align-items:center;gap:7px;margin-top:10px;flex-wrap:wrap}
.schedrow input[type=number]{width:64px}
.sched{display:flex;align-items:center;gap:8px;padding:6px 0;border-bottom:1px solid var(--line)}
.sched .t{flex:1;min-width:0}
.sched .t b{color:var(--accent)}
.sched .next{font-variant-numeric:tabular-nums;color:var(--muted)}
button.x{background:var(--panel2);color:var(--bad);border:1px solid var(--line);padding:2px 8px;font-size:11px;border-radius:5px}
</style></head>
<body>
<header>
  <h1>🛰️ Probe Dashboard</h1>
  <span id="runstate" class="badge b-mut">idle</span>
  <span class="spacer"></span>
  <span class="small" id="canaryage">canary: never pinged</span>
  <button class="ghost" id="notify" title="Browser notification when a probe finishes">🔔 Notify: off</button>
  <button class="ghost" id="refresh">↻ Refresh (ping canaries)</button>
</header>

<div class="wrap">
  <div>
    <div id="nudge"><span><b id="nudgeids"></b> — Retry-After window elapsed; the block may have lifted.</span><span style="flex:1"></span><button class="mini" id="nudgeprobe">▶ Probe these</button></div>
    <div class="panel">
      <h2>ATS status <span id="ledgertotal" class="small"></span></h2>
      <table id="atstable"><thead><tr>
        <th>ATS</th><th>Coverage (cleared / hit / open)</th><th>Live status</th><th>Wait left</th><th>Last checked</th>
      </tr></thead><tbody></tbody></table>
      <div class="small" style="margin-top:8px"><b>Live status</b> = a real-time ping of each ATS's canary slug (Refresh re-pings all): <b style="color:var(--ok)">live</b> · <b style="color:var(--warn)">throttled</b> (rate-limited) · <b style="color:var(--bad)">down</b> (5xx/blocked) · <span style="color:var(--muted)">stale canary</span> (slug moved). Coverage bar over the ledger: <b style="color:var(--ok)">green</b>=cleared · <b style="color:var(--accent)">blue</b>=hit · grey=open. ⚠ = throttle-prone.</div>
    </div>

    <div class="panel live" id="livepanel" style="display:none">
      <h2><span class="dot"></span>Live run</h2>
      <div class="nums">
        <div><div class="k" id="n-pass">–</div><div class="l">wave</div></div>
        <div><div class="k" id="n-pending">–</div><div class="l">pending</div></div>
        <div><div class="k" id="n-resolved">–</div><div class="l">resolved</div></div>
        <div><div class="k" id="n-hits">–</div><div class="l">hits</div></div>
      </div>
      <div id="livebars"></div>
      <div class="small" id="liveprov" style="margin:10px 0"></div>
      <div id="log"></div>
    </div>

    <div class="panel results" id="pendingpanel" style="display:none">
      <h2>Pending hits <span class="small" id="pendingcount"></span></h2>
      <div class="small" style="margin-bottom:6px">Every unacted probe hit across all runs — stays here until added to studios.yml.</div>
      <div id="pendingbody"></div>
    </div>

    <div class="panel results" id="resultspanel" style="display:none">
      <h2>Last result</h2>
      <div id="resultsbody"></div>
    </div>
  </div>

  <div>
    <div class="panel">
      <h2>New probe</h2>
      <label>ATS targets <span class="small">(none = all probe-capable)</span></label>
      <div class="atspick" id="atspick"></div>
      <label>Skip ATS <span class="small">(csv, optional)</span></label>
      <input type="text" id="skipAts" placeholder="e.g. breezy,workable">
      <div class="row">
        <div><label>Concurrency <span class="small">(blank=auto)</span></label><input type="number" id="concurrency" min="1" placeholder="auto"></div>
        <div><label>Request delay (ms)</label><input type="number" id="requestDelay" min="0" placeholder="auto"></div>
        <div><label>Per-host cap</label><input type="number" id="perHost" min="1" placeholder="4"></div>
        <div><label>Max passes</label><input type="number" id="maxPasses" min="1" placeholder="6"></div>
        <div><label>Cooldown (s)</label><input type="number" id="cooldown" min="1" placeholder="60"></div>
        <div><label>Patience (min)</label><input type="number" id="patience" min="1" placeholder="20"></div>
      </div>
      <label class="chk"><input type="checkbox" id="backlog" checked> Backlog (studios.yml unresolved)</label>
      <label class="chk"><input type="checkbox" id="noTimeout"> No timeout (drain until exhaustive)</label>
      <label class="chk"><input type="checkbox" id="quick"> Quick (slug-only, skip domain sweep)</label>
      <label class="chk"><input type="checkbox" id="includeBlocked"> Include kind:blocked</label>
      <label class="chk"><input type="checkbox" id="reprobeAll"> Re-probe all (ignore ledger)</label>
      <div style="display:flex;gap:8px;margin-top:12px">
        <button id="start">▶ Start probe</button>
        <button class="ghost" id="stop" disabled>■ Stop</button>
      </div>
      <div class="small" id="cmdpreview" style="margin-top:8px;font-family:ui-monospace,monospace"></div>
      <div class="schedrow">
        <span class="small">Auto-repeat every</span>
        <input type="number" id="everyHours" min="0.25" step="0.25" value="24" title="hours between automatic re-probes">
        <span class="small">h</span>
        <button class="ghost mini" id="schedule" title="Re-run this probe automatically on a cadence (while the dashboard is open)">⏰ Schedule it</button>
      </div>
    </div>

    <div class="panel">
      <h2>Schedules</h2>
      <div id="schedules" class="small">none — set one with “⏰ Schedule it”</div>
    </div>

    <div class="panel">
      <h2>Run history</h2>
      <div id="history" class="small">no runs yet</div>
    </div>
  </div>
</div>

<script>
const $ = (s) => document.querySelector(s);
const esc = (s) => String(s==null?'':s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
let providers = [];
let es = null;
let lastResult = null;                 // last finished run result (for re-render after an add)
const addedStudios = new Set();        // name|careersUrl already merged into studios.yml this session
let notifyOn = localStorage.getItem('probeNotify') === '1'; // browser finish-notification opt-in
let schedules = [];                    // active recurring schedules (from /api/state)
let streamRunAt = null;                // startedAt of the run our EventSource is bound to (reconnect on new run)
let lastNotifiedAt = null;             // startedAt of the run we last notified for (dedupe)
let liveSnapshot = null;               // latest data/.probe-live.json (per-ATS throttle + progress)
let runActive = false;                 // is a probe running right now (gates the live table overlay)
let savedSettings = null;              // New-probe form, restored from localStorage

function rel(ts){ if(!ts) return '—'; const s=Math.floor((Date.now()-new Date(ts))/1000);
  if(s<60) return s+'s ago'; if(s<3600) return Math.floor(s/60)+'m ago'; if(s<86400) return Math.floor(s/3600)+'h ago'; return Math.floor(s/86400)+'d ago'; }
function dur(sec){ if(sec==null) return '—'; sec=Math.max(0,Math.round(sec)); const h=Math.floor(sec/3600),m=Math.floor(sec%3600/60),s=sec%60;
  if(h) return h+'h '+m+'m'; if(m) return m+'m '+s+'s'; return s+'s'; }

// During a run, the prober's own snapshot is the freshest truth for an ATS it's
// actively hitting — return its live entry (else null) so the table can prefer it.
function liveProv(p){
  if(!runActive||!liveSnapshot||!liveSnapshot.providers) return null;
  return liveSnapshot.providers[p.id]||null;
}
// PRIMARY signal = the live canary ping; the ledger/persisted run is the fallback.
function statusBadge(p){
  // A running probe seeing this ATS throttled/disabled overrides a stale canary.
  const lp=liveProv(p);
  if(lp){
    if(lp.disabled) return '<span class="badge b-bad" title="disabled by the running probe">disabled</span>';
    if(lp.throttled) return '<span class="badge b-warn" title="throttled (observed by the running probe)">throttled</span>';
  }
  const c=p.canaryResult;
  if(c){
    const ms=c.ms!=null?' '+c.ms+'ms':'';
    if(c.state==='live')      return '<span class="badge b-ok" title="canary live ('+c.http+')'+ms+'">live</span>';
    if(c.state==='throttled') return '<span class="badge b-warn" title="HTTP '+c.http+'">throttled</span>';
    if(c.state==='down')      return '<span class="badge b-bad" title="'+(c.detail||('HTTP '+c.http))+'">down</span>';
    if(c.state==='stale')     return '<span class="badge b-mut" title="canary slug 404/unparseable — refresh it">stale canary</span>';
    if(c.state==='no-canary') {/* fall through to ledger */}
    else return '<span class="badge b-mut">'+c.state+'</span>';
  }
  // No canary (e.g. workable) or not yet pinged — fall back to ledger evidence.
  if(p.status){
    if(p.status.disabled) return '<span class="badge b-bad">disabled</span>';
    if(p.status.throttled) return '<span class="badge b-warn">throttled</span>';
    return '<span class="badge b-ok" title="from last run">ok</span>';
  }
  if(p.coverage&&p.coverage.lastProbe) return '<span class="badge b-ok" title="from ledger">ok</span>';
  return p.canary? '<span class="badge b-mut">not pinged</span>' : '<span class="badge b-mut" title="provider has no canary slug">no canary</span>';
}
function lastChecked(p){
  if(p.status) return rel(p.status.lastCheck);
  if(p.coverage&&p.coverage.lastProbe) return rel(p.coverage.lastProbe);
  return '—';
}
// Retry-After bookkeeping — the running probe wins, then the live canary, then the
// last run. The live:true flag marks a throttle the prober is seeing RIGHT NOW even
// when the ATS handed back no Retry-After number (so wait-left can say "throttled").
function retryInfo(p){
  const lp=liveProv(p);
  if(lp&&(lp.throttled||lp.disabled)){
    const base=liveSnapshot&&liveSnapshot.ts?new Date(liveSnapshot.ts).getTime():Date.now();
    if(lp.retryAfterSec!=null) return {ra:lp.retryAfterSec, base, left:(base+lp.retryAfterSec*1000-Date.now())/1000, live:true};
    return {ra:null, live:true};
  }
  const c=p.canaryResult;
  let base=null, ra=null;
  if(c&&(c.state==='throttled'||c.state==='down')&&c.retryAfterSec!=null){ ra=c.retryAfterSec; base=p.status?new Date(p.status.lastCheck).getTime():Date.now(); }
  else if(p.status&&p.status.retryAfterSec!=null){ ra=p.status.retryAfterSec; base=new Date(p.status.lastCheck).getTime(); }
  if(ra==null) return {ra:null};
  return {ra, base, left:(base+ra*1000-Date.now())/1000};
}
function waitLeft(p){
  const ri=retryInfo(p);
  if(ri.ra==null) return ri.live?'<span class="badge b-warn" title="throttled right now, but the ATS sent no Retry-After header — so there is no countdown to show (e.g. breezy 403s carry no wait time). It clears when the ATS stops 403ing.">throttled</span>':'—';
  if(ri.left<=0) return '<span class="badge b-ok">ready</span>';
  return '<span class="badge b-warn">'+dur(ri.left)+'</span>';
}
// "Ready to re-probe" = we recorded a wait for this ATS and it has now elapsed
// (the throttle/down block may have lifted) — drives the row highlight + nudge.
function reprobeReady(p){ const ri=retryInfo(p); return ri.ra!=null && ri.left<=0; }

function renderTable(){
  const tb=$('#atstable tbody'); tb.innerHTML='';
  const ready=[];
  for(const p of providers){
    const c=p.coverage||{cleared:0,hit:0,total:0,open:0};
    const open=Math.max(0,c.total-c.cleared-c.hit);
    const t=c.total||1;
    const tr=document.createElement('tr');
    if(reprobeReady(p)){ tr.className='ready'; ready.push(p.id); }
    tr.innerHTML=
      '<td class="id">'+p.id+(p.throttleProne?' <span title="throttle-prone">⚠</span>':'')+'<div class="small">'+(p.domain||'')+'</div></td>'+
      '<td><div class="bar">'+
        '<i class="c" style="width:'+(100*c.cleared/t)+'%"></i>'+
        '<i class="h" style="width:'+(100*c.hit/t)+'%"></i>'+
        '<i class="o" style="width:'+(100*open/t)+'%"></i>'+
      '</div><div class="small">'+c.cleared+' / '+c.hit+' / '+open+' of '+c.total+'</div></td>'+
      '<td>'+statusBadge(p)+'</td>'+
      '<td>'+waitLeft(p)+'</td>'+
      '<td class="small">'+lastChecked(p)+'</td>';
    tb.appendChild(tr);
  }
  renderNudge(ready);
}
// Nudge: surface ATSes whose Retry-After elapsed so re-probing is timed, not guessed.
let readyIds=[];
function renderNudge(ready){
  readyIds=ready;
  const el=$('#nudge');
  if(!ready.length){ el.classList.remove('show'); return; }
  $('#nudgeids').textContent=ready.join(', ')+(ready.length>1?' are':' is')+' ready to re-probe';
  el.classList.add('show');
}

function renderLive(live){
  if(!live){return;}
  liveSnapshot=live;
  const pr=live.progress||{};
  $('#n-pass').textContent=pr.pass??'–';
  $('#n-pending').textContent=pr.pending??'–';
  $('#n-resolved').textContent=pr.resolved??'–';
  $('#n-hits').textContent=pr.hits??'–';
  // One progress bar PER ATS instance: resolved/(resolved+pending) for that ATS's
  // own wave. A finished instance shows a full bar tagged done/error; one with no
  // snapshot yet shows an indeterminate sweep instead of 0%.
  const insts=live.instances||[];
  let h='';
  for(const it of insts){
    const p=it.progress||{};
    const resolved=Number(p.resolved), pending=Number(p.pending);
    const finished=it.status&&it.status!=='running';
    let cls='ibar', barcls='pbar', right, width='0';
    if(finished){
      cls+=(it.status==='done'?' done':' err'); width='100';
      right=(it.status==='done'?'done':'error')+(Number.isFinite(resolved)?' · '+resolved:'');
    } else if(Number.isFinite(resolved)&&Number.isFinite(pending)&&(resolved+pending)>0){
      const total=resolved+pending, pct=100*resolved/total;
      width=pct.toFixed(1); right=pct.toFixed(0)+'% · '+resolved+'/'+total;
    } else { barcls+=' indet'; right='starting…'; }
    const inner=(barcls.indexOf('indet')>=0)?'<i></i>':'<i style="width:'+width+'%"></i>';
    h+='<div class="'+cls+'"><div class="small ibl"><b>'+esc(it.ats)+'</b><span>'+esc(right)+'</span></div>'+
       '<div class="'+barcls+'">'+inner+'</div></div>';
  }
  $('#livebars').innerHTML=h;
  const ds=[]; for(const [id,v] of Object.entries(live.providers||{})){
    if(v.disabled) ds.push(id+' <span class="badge b-bad">disabled</span>');
    else if(v.throttled) ds.push(id+' <span class="badge b-warn">'+(v.retryAfterSec?dur(v.retryAfterSec):'throttled')+'</span>');
  }
  $('#liveprov').innerHTML = ds.length?('throttle: '+ds.join(' · ')):'';
  // A running probe is the freshest throttle signal there is — reflect it in the
  // ATS table immediately (the canary sweep only re-pings on Refresh/startup).
  if(runActive && $('#atstable tbody').children.length) renderTable();
}

function hitKey(x){ return x.name+'|'+(x.careersUrl||''); }
// One hit row: metadata + an action cell. The confirm flag styles the button as
// a namesake-confirm (review hits) vs a plain trusted add.
function hitRow(x, confirm){
  const meta='<span class="meta">['+esc(x.confidence)+'] <b>'+esc(x.name)+'</b> · '+esc(x.ats)+' · '+esc(x.where||'')+
    ' ('+esc(x.count)+' jobs'+(x.loc?', e.g. '+esc(x.loc):'')+')'+(x.namesakeFlag?' ⚑ '+esc(x.namesakeFlag):'')+'</span>';
  let act;
  if(addedStudios.has(hitKey(x))) act='<span class="added">✓ added</span>';
  else if(!x.careersUrl||!x.provider) act='<span class="dup" title="prober gave no canonical URL — add manually">— manual</span>';
  else act='<a href="'+esc(x.careersUrl)+'" target="_blank" rel="noopener">check ↗</a>'+
    '<button class="mini add'+(confirm?' confirm':'')+'" data-name="'+esc(x.name)+'" data-provider="'+esc(x.provider)+'" data-url="'+esc(x.careersUrl)+'">'+(confirm?'confirm + add':'+ add')+'</button>';
  return '<div class="hit">'+meta+'<span class="hitact">'+act+'</span></div>';
}
function renderResults(r){
  if(!r){$('#resultspanel').style.display='none';return;}
  lastResult=r;
  $('#resultspanel').style.display='';
  const trusted=r.trustedHits||[], review=r.reviewHits||[], unc=r.uncertain||[];
  let h='<div class="nums" style="grid-template-columns:repeat(3,1fr)">'+
    '<div><div class="k" style="color:var(--ok)">'+trusted.length+'</div><div class="l">new hits</div></div>'+
    '<div><div class="k" style="color:var(--warn)">'+review.length+'</div><div class="l">needs review</div></div>'+
    '<div><div class="k" style="color:var(--muted)">'+unc.length+'</div><div class="l">uncertain</div></div></div>'+
    '<div class="small">Hits to add are in the Pending hits panel above (kept across runs).</div>';
  if(r.disabledProviders&&r.disabledProviders.length)h+='<div class="grp small">auto-disabled this run: '+esc(r.disabledProviders.join(', '))+'</div>';
  $('#resultsbody').innerHTML=h;
}
// The durable cross-run add surface: every unacted hit, not just the last run's.
function renderPendingHits(list){
  list=list||[];
  if(!list.length){$('#pendingpanel').style.display='none';return;}
  $('#pendingpanel').style.display='';
  const trusted=list.filter(x=>x.confidence!=='verify'), review=list.filter(x=>x.confidence==='verify');
  $('#pendingcount').textContent='('+list.length+' across all runs)';
  let h='';
  if(trusted.length){h+='<div class="grp"><b>New hits</b> <span class="small">(one-click add to studios.yml)</span>';for(const x of trusted)h+=hitRow(x,false);h+='</div>';}
  if(review.length){h+='<div class="grp"><b>Needs review (namesake risk)</b> <span class="small">(open ↗ to verify before confirming)</span>';for(const x of review)h+=hitRow(x,true);h+='</div>';}
  $('#pendingbody').innerHTML=h;
}
// Delegated handler for the per-hit "add" buttons (shared by both panels).
async function onAddClick(e){
  const btn=e.target.closest('button.add'); if(!btn) return;
  const name=btn.dataset.name, provider=btn.dataset.provider, careersUrl=btn.dataset.url;
  btn.disabled=true; btn.textContent='adding…';
  try{
    const res=await fetch('/api/add-studio',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name,provider,careersUrl})});
    const j=await res.json();
    if(j.ok||j.duplicate){ addedStudios.add(name+'|'+careersUrl); btn.closest('.hitact').innerHTML=j.duplicate?'<span class="dup">already tracked</span>':'<span class="added">✓ added</span>'; load(); }
    else { btn.disabled=false; btn.textContent='+ add'; alert('Add failed: '+(j.error||'unknown')); }
  }catch(err){ btn.disabled=false; btn.textContent='+ add'; alert('Add failed: '+err.message); }
}
$('#resultsbody').addEventListener('click', onAddClick);
$('#pendingbody').addEventListener('click', onAddClick);

function buildPreview(){
  const p=collect(); const a=['probe-studios.mjs'];
  if(p.backlog!==false)a.push('--backlog'); if(p.includeBlocked)a.push('--include-blocked');
  if(p.ats)a.push('--ats',p.ats); if(p.skipAts)a.push('--skip-ats',p.skipAts);
  if(p.concurrency)a.push('--concurrency',p.concurrency); if(p.requestDelay)a.push('--request-delay',p.requestDelay);
  if(p.perHost)a.push('--per-host',p.perHost); if(p.maxPasses)a.push('--max-passes',p.maxPasses);
  if(p.cooldown)a.push('--cooldown',p.cooldown); if(p.patience)a.push('--patience',p.patience);
  if(p.noTimeout)a.push('--no-timeout'); if(p.quick)a.push('--quick'); if(p.reprobeAll)a.push('--reprobe-all');
  $('#cmdpreview').textContent='node '+a.join(' ');
}

function collect(){
  const ats=[...document.querySelectorAll('#atspick input:checked')].map(i=>i.value).join(',');
  return {
    ats, skipAts:$('#skipAts').value.trim(),
    concurrency:$('#concurrency').value, requestDelay:$('#requestDelay').value, perHost:$('#perHost').value,
    maxPasses:$('#maxPasses').value, cooldown:$('#cooldown').value, patience:$('#patience').value,
    backlog:$('#backlog').checked, noTimeout:$('#noTimeout').checked, quick:$('#quick').checked,
    includeBlocked:$('#includeBlocked').checked, reprobeAll:$('#reprobeAll').checked,
  };
}

function renderPicker(){
  const el=$('#atspick'); el.innerHTML='';
  const want=new Set((savedSettings&&savedSettings.ats?String(savedSettings.ats).split(','):[]).map(s=>s.trim()).filter(Boolean));
  for(const p of providers){
    const lab=document.createElement('label'); if(p.throttleProne)lab.className='tp';
    const checked=want.has(p.id)?' checked':'';
    lab.innerHTML='<input type="checkbox" value="'+p.id+'"'+checked+'>'+p.id+(p.throttleProne?' ⚠':'');
    lab.querySelector('input').addEventListener('change',onFormChange);
    el.appendChild(lab);
  }
}

// ── New-probe form persistence ───────────────────────────────────────
const SETTINGS_KEY='probeSettings';
function saveSettings(){ try{ localStorage.setItem(SETTINGS_KEY, JSON.stringify(collect())); }catch{} }
function onFormChange(){ buildPreview(); saveSettings(); }
// Restore the scalar/checkbox fields now (the inputs already exist); ATS-target
// checkboxes are restored later in renderPicker once providers are known.
function restoreSettings(){
  try{ savedSettings=JSON.parse(localStorage.getItem(SETTINGS_KEY)||'null'); }catch{ savedSettings=null; }
  const s=savedSettings; if(!s) return;
  $('#skipAts').value=s.skipAts||'';
  $('#concurrency').value=s.concurrency||''; $('#requestDelay').value=s.requestDelay||'';
  $('#perHost').value=s.perHost||''; $('#maxPasses').value=s.maxPasses||'';
  $('#cooldown').value=s.cooldown||''; $('#patience').value=s.patience||'';
  $('#backlog').checked=s.backlog!==false;
  $('#noTimeout').checked=!!s.noTimeout; $('#quick').checked=!!s.quick;
  $('#includeBlocked').checked=!!s.includeBlocked; $('#reprobeAll').checked=!!s.reprobeAll;
}

function setRunState(s){
  runActive=(s==='running');
  const el=$('#runstate'); el.className='badge '+(s==='running'?'b-warn':s==='done'?'b-ok':s==='error'?'b-bad':'b-mut');
  el.textContent=s;
  $('#start').disabled=(s==='running'); $('#stop').disabled=(s!=='running');
}

let canaryMeta={ts:null,running:false};
async function load(){
  const r=await fetch('/api/state').then(x=>x.json());
  providers=r.providers;
  canaryMeta=r.canary||{ts:null,running:false};
  if(!$('#atspick').children.length) renderPicker();
  renderTable(); renderCanaryAge(); renderHistory(r.history||[]); renderSchedules(r.schedules||[]);
  renderPendingHits(r.pendingHits||[]);
  $('#ledgertotal').textContent=providers[0]?('· '+(providers[0].coverage.total)+' studios in ledger'):'';
  if(r.run){
    setRunState(r.run.status);
    if(r.run.status==='running'){
      // A run is active — make sure our log stream is bound to it. This also picks
      // up runs the SERVER started (a fired schedule), which we never clicked.
      ensureStream(r.run.startedAt);
      $('#livepanel').style.display='';
    } else {
      renderResults(r.run.result);
      $('#livepanel').style.display='none';
    }
  }
  else setRunState('idle');
  if(r.live) renderLive(r.live);
}
function renderHistory(list){
  const el=$('#history');
  if(!list||!list.length){ el.textContent='no runs yet'; return; }
  let h='<table class="hist"><thead><tr><th>when</th><th>target</th><th>took</th><th title="hits / review / uncertain">h/r/u</th></tr></thead><tbody>';
  for(const x of list){
    const took=dur(x.durationMs/1000);
    const st=x.status==='error'?' <span class="badge b-bad" style="padding:0 5px">err</span>':'';
    h+='<tr><td>'+rel(x.ts)+st+'</td><td>'+esc(x.targets||'all')+(x.noTimeout?' <span class="small">∞</span>':'')+'</td>'+
       '<td class="n">'+took+'</td>'+
       '<td class="n"><b style="color:var(--ok)">'+x.hits+'</b>/<span style="color:var(--warn)">'+x.review+'</span>/<span style="color:var(--muted)">'+x.uncertain+'</span></td></tr>';
  }
  h+='</tbody></table>';
  el.innerHTML=h;
}
// ── finish notifications (Feature 4) ─────────────────────────────────
function renderNotifyBtn(){
  const b=$('#notify');
  const denied=('Notification' in window) && Notification.permission==='denied';
  b.textContent = denied ? '🔔 Notify: blocked' : ('🔔 Notify: '+(notifyOn?'on':'off'));
  b.disabled=denied;
}
async function toggleNotify(){
  if(!('Notification' in window)){ alert('This browser has no Notification API.'); return; }
  if(notifyOn){ notifyOn=false; localStorage.setItem('probeNotify','0'); renderNotifyBtn(); return; }
  let perm=Notification.permission;
  if(perm==='default') perm=await Notification.requestPermission();
  if(perm!=='granted'){ renderNotifyBtn(); return; }
  notifyOn=true; localStorage.setItem('probeNotify','1'); renderNotifyBtn();
  try{ new Notification('Probe notifications on',{body:'You’ll be pinged when a probe run finishes.'}); }catch{}
}
// Fire a notification for a finished run (deduped by its startedAt so a reconnect
// replaying the done event can't double-notify). Long drains are exactly when the
// user has wandered off, so this closes the loop.
function notifyDone(d){
  if(!notifyOn || !('Notification' in window) || Notification.permission!=='granted') return;
  const key=d.startedAt||0;
  if(key && key===lastNotifiedAt) return;
  lastNotifiedAt=key;
  const r=d.result||{};
  const tgt=(d.params&&d.params.ats)?d.params.ats:'all ATSes';
  const took=d.durationMs!=null?dur(d.durationMs/1000):'';
  const body = d.status==='error'
    ? ('Probe errored'+(took?' after '+took:'')+(d.error?(' — '+d.error):''))
    : ((r.trustedHits?.length??0)+' new · '+(r.reviewHits?.length??0)+' review · '+(r.uncertain?.length??0)+' uncertain'+(took?' · '+took:''));
  try{ new Notification('Probe finished: '+tgt, { body, tag:'probe-done' }); }catch{}
}

// ── recurring schedules (Feature 5) ──────────────────────────────────
function renderSchedules(list){
  schedules=list||[];
  const el=$('#schedules');
  if(!schedules.length){ el.innerHTML='none — set one with “⏰ Schedule it”'; return; }
  let h='';
  for(const s of schedules){
    const left=s.nextRun!=null?(s.nextRun-Date.now())/1000:null;
    const when=left==null?'—':(left<=0?'due now':'in '+dur(left));
    h+='<div class="sched" data-id="'+esc(s.id)+'">'+
       '<span class="t"><b>'+esc(schedTargetLabel(s))+'</b> · every '+esc(s.everyHours)+'h'+
       (s.params&&s.params.noTimeout?' <span class="small">∞</span>':'')+
       '<div class="small next" data-next="'+(s.nextRun||0)+'">next: '+when+'</div></span>'+
       '<button class="x" data-del="'+esc(s.id)+'">✕</button></div>';
  }
  el.innerHTML=h;
}
function schedTargetLabel(s){ return (s.params&&s.params.ats)?s.params.ats:'all'; }
// Tick the "next: in …" countdowns without a network round-trip.
function tickScheduleCountdowns(){
  for(const el of document.querySelectorAll('#schedules .next')){
    const nr=Number(el.dataset.next)||0; if(!nr) continue;
    const left=(nr-Date.now())/1000;
    el.textContent='next: '+(left<=0?'due now':'in '+dur(left));
  }
}

function renderCanaryAge(){
  const el=$('#canaryage');
  if(canaryMeta.running){ el.textContent='canary: pinging…'; return; }
  el.textContent = canaryMeta.ts ? ('canary: pinged '+rel(canaryMeta.ts)) : 'canary: never pinged';
}
// Active canary sweep — pings every ATS NOW. Used by Refresh + on startup.
async function pingCanaries(){
  $('#refresh').disabled=true; canaryMeta.running=true; renderCanaryAge();
  try{ await fetch('/api/refresh',{method:'POST'}); }catch{}
  await load();
  $('#refresh').disabled=false;
}

function connectStream(){
  if(es) es.close();
  es=new EventSource('/api/log');
  const log=$('#log'); log.textContent=''; // clear so a reconnect's replay doesn't duplicate
  es.addEventListener('log',e=>{ const {line}=JSON.parse(e.data); log.textContent+=line+'\n'; log.scrollTop=log.scrollHeight; });
  es.addEventListener('live',e=>{ const d=JSON.parse(e.data); if(d) renderLive(d); });
  es.addEventListener('done',e=>{ const d=JSON.parse(e.data); setRunState(d.status); renderResults(d.result); $('#livepanel').style.display='none'; notifyDone(d); load(); });
}
// Bind the SSE stream to a specific run (by startedAt); a no-op if already bound,
// so the 5s poll won't reconnect every tick. New run id (incl. a server-fired
// schedule) → (re)connect and stream it live.
function ensureStream(startedAt){
  if(streamRunAt===startedAt && es) return;
  streamRunAt=startedAt;
  connectStream();
}

$('#start').addEventListener('click',async()=>{
  $('#log').textContent=''; $('#livepanel').style.display=''; $('#resultspanel').style.display='none';
  setRunState('running');
  const res=await fetch('/api/probe',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(collect())});
  if(!res.ok){ const j=await res.json(); alert(j.error||'failed'); setRunState('idle'); return; }
  streamRunAt=null; connectStream(); // next poll's ensureStream rebinds to the real startedAt
});
$('#stop').addEventListener('click',()=>fetch('/api/stop',{method:'POST'}));
$('#refresh').addEventListener('click',pingCanaries);
$('#notify').addEventListener('click',toggleNotify);
// Schedule the current form as a recurring auto re-probe.
$('#schedule').addEventListener('click',async()=>{
  const everyHours=Number($('#everyHours').value);
  const btn=$('#schedule'); btn.disabled=true;
  try{
    const res=await fetch('/api/schedule',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({params:collect(),everyHours})});
    const j=await res.json();
    if(!j.ok) alert('Schedule failed: '+(j.error||'unknown'));
    await load();
  }catch(err){ alert('Schedule failed: '+err.message); }
  btn.disabled=false;
});
// Delegated cancel for a schedule row.
$('#schedules').addEventListener('click',async(e)=>{
  const x=e.target.closest('button[data-del]'); if(!x) return;
  x.disabled=true;
  try{ await fetch('/api/schedule/delete',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({id:x.dataset.del})}); }catch{}
  await load();
});
// Nudge → preselect the ready ATSes in the picker and jump to the probe form.
$('#nudgeprobe').addEventListener('click',()=>{
  const want=new Set(readyIds);
  for(const i of document.querySelectorAll('#atspick input')) i.checked=want.has(i.value);
  buildPreview();
  $('#start').scrollIntoView({behavior:'smooth',block:'center'});
});
document.querySelectorAll('input').forEach(i=>{ i.addEventListener('input',onFormChange); i.addEventListener('change',onFormChange); });

// tick: re-render countdowns + canary age every second (no network)
setInterval(()=>{ if($('#atstable tbody').children.length) renderTable(); renderCanaryAge(); tickScheduleCountdowns(); },1000);
// background state poll (cheap, no canary ping) so a running probe updates live
setInterval(load,5000);

// startup: restore the saved form, load state, then ping canaries for fresh liveness
renderNotifyBtn();
restoreSettings();
load().then(()=>{ if(!canaryMeta.ts) pingCanaries(); });
buildPreview(); connectStream();
</script>
</body></html>`;

server.listen(PORT, () => {
  console.log(`Probe dashboard → http://localhost:${PORT}`);
  // Warm the canary state on boot so the first page load shows live liveness.
  runCanarySweep().then(() => console.log(`Canary sweep done (${Object.keys(canarySweep.results).length} ATSes pinged)`));
  // Arm the recurring-schedule master tick (fires due jobs while we're running).
  const armed = loadSchedules().filter((s) => s.enabled).length;
  if (armed) console.log(`Scheduler armed: ${armed} active schedule(s)`);
  setInterval(schedulerTick, SCHED_TICK_MS).unref();
});
