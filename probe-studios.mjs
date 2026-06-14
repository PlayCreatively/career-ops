#!/usr/bin/env node
// Comprehensive ATS discovery probe. The set of ATSes it probes is NOT hardcoded:
// it auto-loads every provider in providers/*.mjs that exports a `probe`
// descriptor (see the Probe typedef in providers/_types.js) — greenhouse, lever
// (US+EU), ashby, teamtailor (subdomain + custom domain), recruitee, workable,
// smartrecruiters, breezy today. Add a discoverable ATS by dropping in a provider
// file with a `probe` export; no edit here is needed. Aggregators and
// recipe/parser providers omit `probe` and are skipped.
//
// It also DEDUPES against studios.yml (skips already-tracked studios) and tags
// each hit with a confidence so namesake-prone single-word slug hits
// (greenhouse/lever/ashby) are flagged rather than trusted blindly.
//
// Usage:
//   node probe-studios.mjs --names file.txt      # one "Name" or "Name|domain.com" per line
//   node probe-studios.mjs --backlog             # probe studios.yml's own backlog
//                                                #   (status: unresolved + recipe kind browser/unresolved)
//   node probe-studios.mjs --backlog --include-blocked  # also re-probe kind: blocked
//   node probe-studios.mjs --wikipedia-sweden     # pull the Wikipedia SE list
//   node probe-studios.mjs --names f.txt --json   # machine-readable
//   ... --quick                                   # slug-only ATS (skip custom-domain sweep).
//                                                 #   Won't close domain-capable providers
//                                                 #   (teamtailor/recruitee) in the ledger, so a
//                                                 #   later full run still sweeps their domains.
//   ... --ats breezy[,lever]                      # probe only these provider id(s)
//   ... --skip-ats breezy                         # probe all EXCEPT these
//   ... --concurrency 4                           # starting concurrency (auto-halves when throttled)
//   ... --per-host 4                              # max simultaneous requests to ONE host (burst-ban
//                                                 #   defense); a host that throttles drops to...
//   ... --per-host-throttled 2                    # ...this tighter cap automatically
//   ... --max-passes 6                            # adaptive wave cap (default 6)
//   ... --cooldown 60                             # base seconds between throttled waves (default 60)
//   ... --patience 20                             # hard cap in minutes before giving up (default 20)
//   ... --no-timeout                              # run until EXHAUSTIVELY resolved (no cap) — for
//                                                 #   the final slow drain once a throttle clears
//   ... --reprobe-all                             # ignore the ledger; fresh full probe of every studio
//
// Progressive draining (data/probe-state.tsv ledger): each run records, per
// studio, which ATSes were definitively CLEARED (cleanly missed) or HIT plus a
// scan version. The next run SKIPS fully-cleared studios and re-probes only each
// studio's still-OPEN ATSes — so a throttled backlog drains a bit more every pass
// instead of re-hitting the same wall. Adding a new provider auto-opens it for all
// studios (its id isn't in any missed-set); SCAN_VERSION bumps invalidate prior
// misses when an existing ATS's probing improves. The ledger is flushed every wave,
// so a long / --no-timeout run loses nothing if interrupted.
//
// Rate-limit honesty + self-pacing (adaptive waves): a 403/429/5xx/timeout is
// NEVER treated as "no feed". The probe runs in WAVES — wave 1 hits everything at
// full concurrency; only the studios an ATS could not confirm/deny carry to the
// next wave, and each carried studio is re-probed against ONLY the ATSes that left
// it uncertain (the well-behaved ATSes are never re-hit). Each wave halves
// concurrency and cools down (longer while a host is still throttling), so the
// slow work self-isolates to the misbehaving ATS. The run ends when the uncertain
// set is empty (exhaustively finished) OR a --patience / --max-passes cap is hit —
// at which point the leftovers are reported as UNCERTAIN (host never recovered),
// never as a clean miss.
//
// Disguised-throttle defense (canary): a throttle doesn't always look like 403. A
// WAF can return a 404 (hiding the endpoint) OR a 200 challenge/interstitial page —
// both of which our certain-miss logic would otherwise read as "no tenant" (a 404,
// or a 2xx body parse() rejects). A provider can export `canary` (a known-live
// slug) on its probe descriptor; before each wave we hit the canary, and if it
// stops returning parseable data we DISTRUST that ATS's misses for the wave — both
// its 404/410s AND its parse-rejected 2xx bodies become uncertain (requeued). When
// the canary is live, those stay clean misses.
//
// Tag-aware dedup: only studios that are actually SCANNABLE (real provider /
// recipe json|html / parser / api / careers_url ATS) count as "already tracked"
// and are skipped. Backlog entries (status: unresolved, recipe kind
// blocked|browser|unresolved) are NOT skipped — they're the whole point of
// re-probing, and live IN studios.yml. Mirrors track-check.mjs's classification.

import { readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { pathToFileURL, fileURLToPath } from 'node:url';
import path from 'node:path';
import yaml from 'js-yaml';

const TIMEOUT_MS = 7000;
// Numeric CLI flag reader (returns the default when absent or non-positive).
function numFlag(name, dflt) {
  const i = process.argv.indexOf(name);
  return i !== -1 && Number(process.argv[i + 1]) > 0 ? Number(process.argv[i + 1]) : dflt;
}
// Starting concurrency; auto-halves each wave once a host throttles.
const CONCURRENCY = numFlag('--concurrency', 16);
// --no-timeout: run until the backlog is EXHAUSTIVELY resolved (no pass/patience
// cap). Safe because the ledger is flushed every wave, so an interrupted run loses
// nothing. Use for the final slow drain passes once a throttler's IP block clears.
const NO_TIMEOUT = process.argv.includes('--no-timeout');
const MAX_PASSES = NO_TIMEOUT ? Infinity : numFlag('--max-passes', 6);     // adaptive wave cap
const BASE_COOLDOWN_S = numFlag('--cooldown', 60); // base seconds between throttled waves
const PATIENCE_MS = NO_TIMEOUT ? Infinity : numFlag('--patience', 20) * 60_000; // hard wall-clock cap
const QUICK = process.argv.includes('--quick');
const JSON_OUT = process.argv.includes('--json');
const REPROBE_ALL = process.argv.includes('--reprobe-all'); // ignore the ledger, fresh full probe

// Probe-state ledger version. Bump ONLY when the discovery logic for an EXISTING
// ATS materially improves (slug generation, a parse() that now matches more) —
// that invalidates every prior "missed" so studios get a full re-probe. Adding a
// NEW provider does NOT need a bump: its id is simply absent from every studio's
// recorded missed-set, so the ledger marks it OPEN and it gets probed everywhere
// automatically. This is what lets a throttled backlog drain PROGRESSIVELY across
// runs instead of re-hitting the same wall — each pass persists the ATSes it could
// definitively clear, so the next pass only re-probes what's still open.
const SCAN_VERSION = 1;
const PREFIXES = ['jobs', 'career', 'careers', 'join', 'work', 'jobb'];
const TLDS = ['com', 'se', 'io', 'games'];

const SCANNABLE_RECIPE_KINDS = new Set(['json', 'html']);
const TAG_RECIPE_KINDS = new Set(['blocked', 'browser', 'unresolved']);

// Is this studios.yml entry already pullable by scan.mjs? Backlog tags are NOT
// (so the probe should look at them). Recipe tag-kind wins over a careers_url —
// a blocked/browser entry may still carry a careers_url hint.
function isScannable(c) {
  if (c.recipe && typeof c.recipe === 'object') {
    if (SCANNABLE_RECIPE_KINDS.has(c.recipe.kind)) return true;
    if (TAG_RECIPE_KINDS.has(c.recipe.kind)) return false;
  }
  if (c.parser?.command) return true;
  if (c.provider) return true;
  if (c.status === 'unresolved') return false;
  if (c.api || c.careers_url) return true;
  if (c.status) return false;
  return false;
}

// Registrable-ish domain (last two labels) from a URL — for pCustomDomain hints.
function registrableDomain(url) {
  try {
    const host = new URL(url).hostname.toLowerCase().replace(/^www\./, '');
    return host.split('.').slice(-2).join('.');
  } catch { return ''; }
}

// ── studios.yml dedup ───────────────────────────────────────────────
function norm(s) { return (s || '').toLowerCase().replace(/\b(ab|inc|ltd|llc|studios?|games?|interactive|entertainment|group|the)\b/g, '').replace(/[^a-z0-9]+/g, ''); }
function loadTracked() {
  const names = new Set(), hosts = new Set();
  if (!existsSync('studios.yml')) return { names, hosts };
  const doc = yaml.load(readFileSync('studios.yml', 'utf8'));
  for (const c of doc.tracked_companies || []) {
    if (!isScannable(c)) continue; // backlog entries stay probeable
    if (c.name) names.add(norm(c.name));
    if (typeof c.careers_url === 'string') {
      try { hosts.add(new URL(c.careers_url).hostname.toLowerCase().replace(/^www\./, '')); } catch {}
    }
  }
  return { names, hosts };
}

// ── backlog input (--backlog) ───────────────────────────────────────
// Feed studios.yml's own un-scannable entries back in as probe targets, using
// any careers_url as a domain hint. blocked entries are excluded unless
// --include-blocked (they were judged dead; only re-probe on request).
function loadBacklog() {
  if (!existsSync('studios.yml')) return [];
  const includeBlocked = process.argv.includes('--include-blocked');
  const doc = yaml.load(readFileSync('studios.yml', 'utf8'));
  const out = [];
  for (const c of doc.tracked_companies || []) {
    if (!c.name || isScannable(c)) continue;
    if (c.recipe?.kind === 'blocked' && !includeBlocked) continue;
    const domain = typeof c.careers_url === 'string' ? registrableDomain(c.careers_url) : '';
    out.push({ name: c.name, domains: domain ? [domain] : [] });
  }
  return out;
}

// ── probe-state ledger (data/probe-state.tsv) ───────────────────────
// Per-studio record of which ATSes were definitively CLEARED (cleanly missed) or
// HIT, plus the scan version. Lets re-runs skip fully-resolved studios and probe
// only each studio's still-OPEN ATSes — the mechanism that drains a throttled
// backlog progressively. Sidecar TSV (mirrors scan-history.tsv) so studios.yml's
// hand-curated comments/order are never touched.
const LEDGER_PATH = path.join('data', 'probe-state.tsv');
const today = () => new Date().toISOString().slice(0, 10);

// Confidence tiers a slug/domain hit can carry (see tierFor). HIGH = own-domain
// match, MEDIUM = name-specific slug — both trustworthy. VERIFY = generic slug
// (namesake risk: a different company on the same ATS). An empty tier is a legacy
// row written before the ledger tracked confidence — treated as untrusted too, so
// it re-surfaces for review rather than silently counting as a win.
const TRUSTED_TIERS = new Set(['high', 'medium']);

// name_norm \t name \t scan_version \t hit_ats \t missed_ats(csv) \t last_probe \t hit_confidence
// hit_confidence is the LAST column so a legacy 6-column row still parses (conf
// reads as undefined → '' → untrusted). Never insert columns mid-row.
export function loadLedger(file = LEDGER_PATH) {
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
function writeLedger(m, file = LEDGER_PATH) {
  const rows = [
    '# probe-state ledger — per-studio ATS coverage so re-runs skip already-cleared work.',
    '# Written by probe-studios.mjs. name_norm and missed_ats use provider ids.',
    '# hit_confidence: high|medium = trusted win, verify = namesake risk (needs review), empty = legacy.',
    '# name_norm\tname\tscan_version\thit_ats\tmissed_ats(csv)\tlast_probe\thit_confidence',
  ];
  for (const [key, v] of [...m.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    rows.push([key, v.name, v.version, v.hit, [...v.missed].sort().join(','), v.last, v.hitConf || ''].join('\t'));
  }
  writeFileSync(file, rows.join('\n') + '\n');
}
// Which ATS ids are still OPEN for a studio? null = probe EVERYTHING (no ledger
// entry, or it predates the current SCAN_VERSION → its misses are invalidated).
// An empty Set = nothing open (fully cleared / already hit) → caller skips it.
export function ledgerOpen(led, key, providerIds) {
  const e = led.get(key);
  if (!e || e.version < SCAN_VERSION) return null;     // never probed at this version → all open
  if (e.hit && TRUSTED_TIERS.has(e.hitConf)) return new Set(); // trusted hit → resolved, skip
  // A verify/legacy-tier hit is NOT a confirmed win (namesake risk): keep the
  // studio OPEN so it stays in the needs-review bucket on every run until a human
  // resolves it (adds the real careers_url to studios.yml, or confirms it's junk).
  return new Set(providerIds.filter(id => !e.missed.has(id)));
}
// Fold one studio's result into the ledger: union the newly-cleared ATSes onto
// what we already knew (reset first if the prior record predates SCAN_VERSION).
// A hit also records the confidence tier the probe computed so re-runs and
// downstream readers can tell a trusted win from a namesake-risk match.
export function mergeLedger(led, key, name, result) {
  const prev = led.get(key) || { version: 0, hit: '', hitConf: '', missed: new Set() };
  const base = prev.version >= SCAN_VERSION ? prev.missed : new Set(); // version bump wipes stale misses
  const missed = new Set(base);
  for (const id of (result.missedAts || [])) missed.add(id);
  const hit = result.ats || prev.hit || '';
  // On a fresh hit, store its tier; otherwise carry the prior tier alongside the
  // prior hit (a no-hit pass must not blank an earlier hit's confidence).
  const hitConf = result.ats ? (result.confidence || '') : (prev.hitConf || '');
  led.set(key, { name, version: SCAN_VERSION, hit, hitConf, missed, last: today() });
}

// ── slug + domain generation ────────────────────────────────────────
function nameSlugs(name) {
  const base = name.toLowerCase().replace(/\(.*?\)/g, '').trim();
  const alnum = base.replace(/[^a-z0-9]+/g, '');
  const hyphen = base.replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  const noSuffix = base.replace(/\b(studios?|games?|interactive|entertainment|the|group)\b/g, '').trim().replace(/[^a-z0-9]+/g, '');
  return [...new Set([alnum, hyphen, noSuffix].filter(s => s && s.length >= 4))];
}
function domainGuesses(name, domains) {
  if (domains && domains.length) return domains;
  const a = name.toLowerCase().replace(/\(.*?\)/g, '').replace(/[^a-z0-9]+/g, '');
  const ns = name.toLowerCase().replace(/\b(studios?|games?|interactive|entertainment|the|group)\b/g, '').replace(/[^a-z0-9]+/g, '');
  const stems = [...new Set([a, ns].filter(s => s && s.length >= 3))];
  return stems.flatMap(s => TLDS.map(t => `${s}.${t}`));
}

// ── HTTP ────────────────────────────────────────────────────────────
// Certainty model (inverted, fail-safe): we only call something a MISS when the
// ATS positively says "not here" — an HTTP 404/410, or a 200 body the endpoint's
// parse() rejects (SmartRecruiters totalFound:0, Breezy's marketing HTML, an
// empty greenhouse board, …). EVERYTHING else (403/429 throttle, 5xx, timeouts,
// connection errors) is UNCERTAIN with a recorded reason — never silently a miss.
// A guessed custom domain that simply doesn't resolve (ENOTFOUND) is the one
// network error that IS a clean miss, but only for the domain sweep (handled in
// runEndpoint via endpoint.kind), since the host we invented just doesn't exist.
const GET_RETRIES = 2;                 // retry transient/uncertain results within one get()
const RETRYABLE_STATUS = new Set([403, 429, 500, 502, 503, 504]);
const throttleHosts = new Map();       // host -> 403/429 count (end-of-run warning)
const uncertainReasons = new Map();    // reason string -> count (aggregate, FINAL uncertain only)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function hostOf(u) { try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return u; } }
function bump(map, k) { map.set(k, (map.get(k) || 0) + 1); }
function sumMap(map) { let n = 0; for (const v of map.values()) n += v; return n; }

// ── per-host concurrency gate (burst-ban defense) ───────────────────
// Global CONCURRENCY bounds TOTAL in-flight work, but it's host-blind: with N
// studios probing in parallel, up to N requests can land on ONE host at the same
// instant and trip its WAF (Breezy/Workable's Cloudflare returns 1015 at ~10
// simultaneous hits). This gate caps how many requests may be in flight to any
// SINGLE host. Requests to different hosts still run fully parallel, so the
// well-behaved ATSes are unaffected. It's adaptive: a host starts at PER_HOST_MAX,
// but once it has thrown a throttle (recorded in throttleHosts) its cap drops to
// PER_HOST_THROTTLED — so a misbehaving host self-isolates to a trickle without
// slowing the good ones. This makes a low-and-steady rate the DEFAULT, avoiding
// the burst that earns the ban in the first place (cheaper than reactive cooldowns).
const PER_HOST_MAX = numFlag('--per-host', 4);
const PER_HOST_THROTTLED = Math.min(numFlag('--per-host-throttled', 2), PER_HOST_MAX);
const hostGates = new Map();           // host -> { active, queue:[] }
function hostCap(host) { return throttleHosts.has(host) ? PER_HOST_THROTTLED : PER_HOST_MAX; }
// Run fn() while holding a slot for `host`; waiters re-check the (possibly
// tightened) cap on wake, so a host that throttles mid-run squeezes immediately.
async function withHostLimit(host, fn) {
  let g = hostGates.get(host);
  if (!g) { g = { active: 0, queue: [] }; hostGates.set(host, g); }
  while (g.active >= hostCap(host)) await new Promise((r) => g.queue.push(r));
  g.active++;
  try { return await fn(); }
  finally {
    g.active--;
    const q = g.queue; g.queue = []; // wake all; each re-checks the cap in the while loop
    for (const r of q) r();
  }
}

// Pure: map one fetch outcome to a kind. Exported for testing/reasoning.
//   { kind: 'notfound' }                    → certain miss (subject to canary distrust)
//   { kind: 'data', body }                  → 2xx; let parse() decide hit vs miss
//   { kind: 'uncertain', reason }           → throttle/5xx/odd-4xx/network/timeout
//   { kind: 'dnsfail', reason }             → host didn't resolve (ENOTFOUND)
export function classifyStatus(status) {
  if (status === 404 || status === 410) return { kind: 'notfound' };
  if (status >= 200 && status < 300) return { kind: 'data' };
  if (status === 403 || status === 429) return { kind: 'uncertain', reason: 'throttled' };
  return { kind: 'uncertain', reason: `http_${status}` };
}
export function classifyError(err) {
  if (err?.name === 'AbortError') return { kind: 'uncertain', reason: 'timeout' };
  const code = err?.cause?.code || err?.code || '';
  if (code === 'ENOTFOUND') return { kind: 'dnsfail', reason: 'dns_notfound' };
  return { kind: 'uncertain', reason: code ? code.toLowerCase() : 'network' };
}

// One classified fetch attempt (no retry). A `retry` flag tells get() whether a
// non-terminal result is worth another attempt. The host slot is held only for
// the network round-trip, not the inter-attempt backoff, so a sleeping retry
// doesn't tie up the host's budget.
async function fetchOnce(url, json) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: ctrl.signal, redirect: 'follow', headers: { 'User-Agent': 'Mozilla/5.0', Accept: json ? 'application/json' : '*/*' } });
    if (res.status === 403 || res.status === 429) bump(throttleHosts, hostOf(url));
    const c = classifyStatus(res.status);
    if (c.kind === 'data') {
      const text = await res.text();
      if (!json) return { kind: 'data', data: text };
      try { return { kind: 'data', data: JSON.parse(text) }; }
      catch { return { kind: 'data', data: null }; } // 2xx non-JSON (e.g. Breezy marketing) → parse() = miss
    }
    if (c.kind === 'notfound') return c;
    return { ...c, retry: RETRYABLE_STATUS.has(res.status) }; // uncertain; odd 4xx won't retry
  } catch (err) {
    const c = classifyError(err);
    if (c.kind === 'dnsfail') return c; // won't resolve on retry
    return { ...c, retry: true };       // timeout / network → worth a retry
  } finally { clearTimeout(t); }
}

// Returns a classified result: { kind:'notfound' } | { kind:'data', data } |
// { kind:'uncertain', reason } | { kind:'dnsfail', reason }. Routes every attempt
// through the per-host gate so bursts can't trip a host's WAF.
async function get(url, json = true) {
  const host = hostOf(url);
  let last = { kind: 'uncertain', reason: 'network' };
  for (let attempt = 0; attempt <= GET_RETRIES; attempt++) {
    if (attempt > 0) await sleep(500 * 2 ** (attempt - 1) + Math.floor(Math.random() * 400));
    const r = await withHostLimit(host, () => fetchOnce(url, json));
    if (r.kind === 'data' || r.kind === 'notfound' || r.kind === 'dnsfail') return r; // terminal
    last = r;
    if (!r.retry) return r; // odd 4xx: don't burn retries
  }
  return last;
}
const GENERIC = /^(the|game|games|studio|play|fun|echo|grin|ghost|mirage|upside|overflow|pathos|brimstone|foxglove|carbon|merge|linear|render|sun|moon|core|solid|focus|frontier|niantic)$/;

// ── Provider-driven probe descriptors ───────────────────────────────
// The set of ATSes to probe is NOT hardcoded here — it is auto-loaded from
// providers/*.mjs. Any provider that exports a `probe` descriptor (see the Probe
// typedef in providers/_types.js) is picked up; aggregators and recipe/parser
// providers omit it and are skipped. Adding a discoverable ATS = drop in one
// provider file, no edit here. Mirrors how scan.mjs auto-loads providers.
const PROVIDERS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'providers');

async function loadProbeProviders(dir) {
  const out = [];
  if (!existsSync(dir)) return out;
  for (const file of readdirSync(dir).filter(f => f.endsWith('.mjs') && !f.startsWith('_')).sort()) {
    let mod;
    try { mod = await import(pathToFileURL(path.join(dir, file)).href); }
    catch (e) { process.stderr.write(`⚠️  ${file}: failed to load — ${e.message}\n`); continue; }
    if (!mod.probe || !Array.isArray(mod.probe.endpoints)) continue; // not discoverable → skip
    const id = mod.default?.id || file.replace(/\.mjs$/, '');
    out.push({ id, ...mod.probe });
  }
  return out;
}

// Resolve the confidence tier for a slug hit: per-endpoint override wins, else a
// namesake-prone provider downgrades short/generic slugs to 'verify', else the
// provider's base tier (default 'medium').
function tierFor(p, endpoint, key) {
  if (endpoint.confidence) return endpoint.confidence;
  if (p.namesakeProne) return (key.length >= 6 && !GENERIC.test(key)) ? 'medium' : 'verify';
  return p.confidence || 'medium';
}

// Canary check (404-as-throttle defense). For each provider that declares a
// `canary` (a known-live slug), hit it on the provider's slug endpoint; if it
// does NOT return parseable data, that ATS is currently unhealthy and its 404s
// must be DISTRUSTED for this wave. Returns { untrusted:Set<id>, checked:[[id,state]] }.
async function checkCanaries(providers) {
  const untrusted = new Set();
  const checked = [];
  for (const p of providers) {
    if (!p.canary) continue;
    const ep = p.endpoints.find(e => e.kind === 'slug');
    if (!ep) continue;
    const r = await get(ep.url(p.canary));
    const live = r.kind === 'data' && !!ep.parse(r.data);
    if (!live) untrusted.add(p.id);
    checked.push([p.id, live ? 'ok' : (r.reason || r.kind)]);
  }
  return { untrusted, checked };
}

// Returns one of:
//   {type:'hit', ...}                  — confirmed feed
//   {type:'miss'}                      — CERTAIN miss (404/410 or parse-rejected 2xx;
//                                        also a non-resolving guessed custom domain)
//   {type:'uncertain', reason}         — couldn't confirm OR deny (throttle/5xx/network/
//                                        or a distrusted 404 on a canary-down ATS)
async function runEndpoint(p, endpoint, key, untrusted) {
  const r = await get(endpoint.url(key));
  if (r.kind === 'data') {
    const hit = endpoint.parse(r.data);
    if (!hit) {
      // A 2xx body the ATS served that parse() rejects is normally a CERTAIN miss
      // (dead tenant / empty board / totalFound:0). But if the canary says this ATS
      // is unhealthy, that "2xx" may be a WAF challenge / interstitial page
      // masquerading as content — distrust it like a disguised 404 (slug endpoints
      // only; domain-sweep guesses stay a miss).
      if (untrusted && untrusted.has(p.id) && endpoint.kind !== 'domain') {
        return { type: 'uncertain', reason: 'maybe_throttled_2xx' };
      }
      return { type: 'miss' };                    // 2xx the ATS served but no match → certain
    }
    return {
      type: 'hit',
      ats: endpoint.label || p.id,
      where: endpoint.where(key),
      count: hit.count,
      loc: hit.loc || '',
      confidence: tierFor(p, endpoint, key),
    };
  }
  if (r.kind === 'notfound') {
    // 404-as-throttle: if this ATS's canary is down, a 404 can't be trusted as a
    // real "no tenant" — requeue it as uncertain. Only for slug endpoints; the
    // domain sweep guesses hosts so a 404 there is genuinely "not our ATS".
    if (untrusted && untrusted.has(p.id) && endpoint.kind !== 'domain') {
      return { type: 'uncertain', reason: 'maybe_throttled_404' };
    }
    return { type: 'miss' };
  }
  // dnsfail: a custom-domain GUESS that doesn't resolve is a clean miss; on a fixed
  // ATS host (slug endpoints) it's our own DNS trouble → uncertain.
  if (r.kind === 'dnsfail') return endpoint.kind === 'domain' ? { type: 'miss' } : { type: 'uncertain', reason: r.reason };
  // For the domain sweep we're guessing hosts — only a positive feed matters; any
  // other response (throttle/5xx on a parked host) is just "not our ATS" = miss.
  if (endpoint.kind === 'domain') return { type: 'miss' };
  return { type: 'uncertain', reason: r.reason };
}

// Probe one studio. `restrict` (Set<providerId>|null) limits which ATSes to try —
// used by later waves to re-probe ONLY the ATSes that left this studio uncertain,
// so the well-behaved ATSes resolved in wave 1 are never re-hit. `untrusted`
// (Set<providerId>) carries the canary verdict for the 404 distrust above.
async function probe(entry, tracked, probeProviders, { restrict = null, untrusted = new Set() } = {}) {
  if (tracked.names.has(norm(entry.name))) return { name: entry.name, skipped: 'already in studios.yml' };
  const providers = restrict ? probeProviders.filter(p => restrict.has(p.id)) : probeProviders;
  // Track ATSes we could NOT confirm/deny for THIS studio (throttle/5xx/network).
  // If the studio ends with no hit, these make it "uncertain" (a real feed may be
  // hiding behind the error), not a clean miss. uncertainAts = "ats:reason" for the
  // report; retryAts = bare provider ids for the next wave's `restrict`.
  const uncertainAts = new Set();
  const retryAts = new Set();
  const missedAts = new Set();   // provider ids whose every slug/endpoint cleanly missed (for the ledger)
  // 1) slug-based ATS. Each provider supplies its own slug set (default = name-
  //    derived) so case-sensitive ATSes (SmartRecruiters) work without special-casing.
  for (const p of providers) {
    const slugEndpoints = p.endpoints.filter(e => e.kind === 'slug');
    if (!slugEndpoints.length) continue;
    const slugs = p.slugs ? p.slugs(entry.name) : nameSlugs(entry.name);
    let pUncertain = false;
    for (const slug of slugs) {
      for (const endpoint of slugEndpoints) {
        const r = await runEndpoint(p, endpoint, slug, untrusted);
        if (r.type === 'hit') return finalize(entry, r, tracked, missedAts);
        if (r.type === 'uncertain') { pUncertain = true; uncertainAts.add(`${endpoint.label || p.id}:${r.reason}`); }
      }
    }
    // This ATS is "cleared" for the ledger only if NONE of its probes were
    // uncertain — a single throttle leaves it OPEN for the next pass. AND only if
    // it was probed EXHAUSTIVELY: in --quick we skip the custom-domain sweep, so a
    // provider that has a domain endpoint (teamtailor, recruitee) was NOT fully
    // tried — don't close it, or a later full run would wrongly skip its domain
    // sweep. Slug-only providers are fully covered by quick, so they DO close.
    const fullyProbed = !(QUICK && p.endpoints.some(e => e.kind === 'domain'));
    if (pUncertain) retryAts.add(p.id);
    else if (fullyProbed) missedAts.add(p.id);
  }
  // 2) custom-domain sweep — providers with a `domain` endpoint, on the studio's
  //    own host (skipped in --quick). When restricting (later waves), only sweep if
  //    a restricted provider actually has a domain endpoint.
  if (!QUICK) {
    const domainProbes = providers.flatMap(p => p.endpoints.filter(e => e.kind === 'domain').map(e => [p, e]));
    if (domainProbes.length) {
      for (const domain of domainGuesses(entry.name, entry.domains)) {
        for (const prefix of PREFIXES) {
          const host = `${prefix}.${domain}`;
          for (const [p, endpoint] of domainProbes) {
            const r = await runEndpoint(p, endpoint, host, untrusted);
            if (r.type === 'hit') return finalize(entry, r, tracked);
            // domain sweep never yields 'uncertain' (guesses → miss), so nothing to track
          }
        }
      }
    }
  }
  // No hit. If any ATS left us uncertain, this is NOT a confirmed miss — carry the
  // retry set so the next wave re-probes only those ATSes. (uncertainReasons is
  // bumped only when a studio FINALLY ends uncertain — see the wave loop.)
  // missedAts (cleanly-cleared ATSes) rides along in BOTH cases for the ledger.
  if (uncertainAts.size) {
    return { name: entry.name, ats: null, uncertain: [...uncertainAts], retryAts: [...retryAts], missedAts: [...missedAts] };
  }
  return { name: entry.name, ats: null, missedAts: [...missedAts] };
}
function finalize(entry, hit, tracked, missedAts) {
  const { type, ...rest } = hit; // drop the internal control-flow tag
  if (tracked.hosts.has(hit.where.replace(/^www\./, '').split('/')[0])) return { name: entry.name, skipped: `host ${hit.where} already tracked` };
  return { name: entry.name, ...rest, missedAts: [...(missedAts || [])] };
}

// ── adaptive wave loop ──────────────────────────────────────────────
// Wave 1 probes everything at full concurrency. Hits / 404-or-parse-reject misses
// / skips are terminal. Studios left uncertain by a throttling ATS carry to the
// next wave, re-probed against ONLY the ATSes that failed them (restrict), at
// halved concurrency after a cooldown. Ends when uncertain is empty (exhaustive)
// or a --max-passes / --patience cap is hit (leftovers → reported uncertain).
async function runWaves(pending, tracked, probeProviders, led) {
  const startedAt = Date.now();
  const terminal = [];
  const waveLog = [];
  let conc = CONCURRENCY;
  let pass = 0;
  while (pending.length) {
    pass++;
    // Which providers are in play this wave (for the canary check)?
    const inPlay = probeProviders.filter(p => pending.some(x => !x.restrict || x.restrict.has(p.id)));
    const { untrusted, checked } = await checkCanaries(inPlay);
    const throttleBefore = sumMap(throttleHosts);
    const passResults = await runPool(pending,
      x => probe(x.entry, tracked, probeProviders, { restrict: x.restrict, untrusted }), conc);
    const throttleDelta = sumMap(throttleHosts) - throttleBefore;
    const next = [];
    for (let k = 0; k < passResults.length; k++) {
      const r = passResults[k];
      if (r.ats || r.skipped || !r.uncertain) terminal.push(r); // hit / skip / clean miss = terminal
      else next.push({ entry: pending[k].entry, restrict: new Set(r.retryAts), lastUncertain: r.uncertain });
    }
    // Persist progress EVERY wave (not just at the end) so a long / no-timeout run
    // that's interrupted still keeps the ATSes it cleared. mergeLedger unions, so
    // folding a still-uncertain studio's partial misses repeatedly is idempotent.
    if (led) {
      for (const r of passResults) {
        if (r.skipped) continue;
        mergeLedger(led, norm(r.name), r.name, r);
      }
      writeLedger(led);
    }
    const prevRemaining = pending.length;
    waveLog.push({ pass, conc, in: prevRemaining, resolved: prevRemaining - next.length, remaining: next.length, throttleDelta, untrusted: [...untrusted], canaries: checked });
    pending = next;
    if (!pending.length) break; // EXHAUSTIVELY finished — every studio reached a terminal state

    const elapsed = Date.now() - startedAt;
    const stillStruggling = throttleDelta > 0 || untrusted.size > 0;
    const noProgress = pending.length >= prevRemaining;
    // Stop conditions: pass/patience cap, OR genuinely stuck with no throttle in
    // sight (persistent network failure — retrying won't help). A canary-down /
    // throttling host keeps us looping (cooling) until a cap, per design.
    if (pass >= MAX_PASSES || elapsed >= PATIENCE_MS || (noProgress && !stillStruggling)) {
      for (const x of pending) {
        for (const u of x.lastUncertain) bump(uncertainReasons, u);
        terminal.push({ name: x.entry.name, ats: null, uncertain: x.lastUncertain });
      }
      const why = pass >= MAX_PASSES ? `max-passes (${MAX_PASSES})` : elapsed >= PATIENCE_MS ? `patience (${PATIENCE_MS / 60000}m)` : 'no progress / no throttle';
      process.stderr.write(`  giving up after wave ${pass} — ${pending.length} still uncertain (${why}); reported as UNCERTAIN, not misses.\n`);
      pending = [];
      break;
    }
    conc = Math.max(2, Math.floor(conc / 2));
    const cool = BASE_COOLDOWN_S * (stillStruggling ? pass : 1);
    process.stderr.write(`  wave ${pass}: ${next.length} uncertain remain${stillStruggling ? ` (throttle/canary active)` : ''} — cooling ${cool}s, re-probing at concurrency ${conc}...\n`);
    await sleep(cool * 1000);
  }
  return { results: terminal, passes: pass, waveLog };
}

// ── input loading ───────────────────────────────────────────────────
async function loadNames() {
  const out = [];
  if (process.argv.includes('--wikipedia-sweden')) {
    const r = await get('https://en.wikipedia.org/w/api.php?action=parse&page=List_of_video_game_companies_of_Sweden&format=json&prop=wikitext');
    const wt = r?.kind === 'data' ? (r.data?.parse?.wikitext?.['*'] || '') : '';
    let active = true; // skip See also / References / External links sections
    for (const line of wt.split('\n')) {
      const h = line.match(/^==+\s*(.*?)\s*==+\s*$/);
      if (h) { active = !/see also|references|external links|further reading|notes|sources/i.test(h[1]); continue; }
      if (!active) continue;
      const m = line.match(/^\*+\s+(.*)$/); if (!m) continue;
      if (/https?:\/\/|\[http/i.test(m[1])) continue; // citation/external-link bullets
      let s = m[1]
        .replace(/<ref[\s\S]*?<\/ref>/g, '').replace(/<ref[^>]*\/>/g, '').replace(/\{\{[^}]*\}\}/g, '')
        .replace(/<small>[\s\S]*?<\/small>/g, '')
        .replace(/\[\[([^\]|]*)\|([^\]]*)\]\]/g, '$2').replace(/\[\[([^\]]*)\]\]/g, '$1');
      s = s.split(/\s*[;(]/)[0];                       // drop "(notes)" and "; Other AB" tails
      s = s.replace(/<[^>]+>/g, '').replace(/["'']/g, '').trim().replace(/\s+(AB|HB)$/i, '').trim();
      if (s && s.length >= 2 && !/^lists? of|^video games? (in|developer|publisher)/i.test(s)) out.push({ name: s });
    }
  }
  const nf = process.argv[process.argv.indexOf('--names') + 1];
  if (process.argv.includes('--names') && nf && existsSync(nf)) {
    for (const line of readFileSync(nf, 'utf8').split('\n')) {
      const t = line.trim(); if (!t || t.startsWith('#')) continue;
      const [name, ...d] = t.split('|');
      out.push({ name: name.trim(), domains: d.map(x => x.trim()).filter(Boolean) });
    }
  }
  if (process.argv.includes('--backlog')) out.push(...loadBacklog());
  // dedupe by name
  return [...new Map(out.map(e => [e.name.toLowerCase(), e])).values()];
}

async function runPool(items, worker, limit) {
  const out = []; let i = 0;
  async function next() { while (i < items.length) { const idx = i++; out[idx] = await worker(items[idx]); } }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, next));
  return out;
}

// ── main (only when run as a script; importing for tests is side-effect-free) ──
async function main() {
  const tracked = loadTracked();
  let probeProviders = await loadProbeProviders(PROVIDERS_DIR);
  // --ats breezy,lever  → probe only these provider id(s). Targeted re-probes of a
  // single ATS (e.g. to recheck a rate-limited run) without re-hitting all of them.
  const atsIdx = process.argv.indexOf('--ats');
  if (atsIdx !== -1 && process.argv[atsIdx + 1]) {
    const want = new Set(process.argv[atsIdx + 1].split(',').map(s => s.trim().toLowerCase()).filter(Boolean));
    probeProviders = probeProviders.filter(p => want.has(p.id));
    if (!probeProviders.length) { process.stderr.write(`No probe providers match --ats ${[...want].join(',')}\n`); process.exit(1); }
  }
  // --skip-ats breezy  → probe everything EXCEPT these (e.g. to survey other ATSes
  // while one is in an IP-throttle cooldown).
  const skipIdx = process.argv.indexOf('--skip-ats');
  if (skipIdx !== -1 && process.argv[skipIdx + 1]) {
    const drop = new Set(process.argv[skipIdx + 1].split(',').map(s => s.trim().toLowerCase()).filter(Boolean));
    probeProviders = probeProviders.filter(p => !drop.has(p.id));
  }
  const names = await loadNames();

  // Ledger: skip studios already fully cleared at this scan version, and restrict
  // the rest to only their still-OPEN ATSes — so each pass drains a bit more of a
  // throttled backlog instead of re-probing everything. --reprobe-all bypasses it.
  const led = loadLedger();
  const providerIds = probeProviders.map(p => p.id);
  const pending = [];
  let ledgerSkipped = 0;
  for (const e of names) {
    if (REPROBE_ALL) { pending.push({ entry: e, restrict: null, lastUncertain: null }); continue; }
    const open = ledgerOpen(led, norm(e.name), providerIds);
    if (open && open.size === 0) { ledgerSkipped++; continue; } // fully cleared at this version
    pending.push({ entry: e, restrict: open, lastUncertain: null }); // null = probe all; Set = open subset
  }

  const canaryNote = probeProviders.filter(p => p.canary).map(p => p.id);
  const capNote = NO_TIMEOUT ? 'no-timeout (until exhaustive)' : `up to ${MAX_PASSES} waves, patience ${PATIENCE_MS / 60000}m`;
  process.stderr.write(`Probing ${pending.length} studios (${QUICK ? 'quick' : 'full'}) across ${probeProviders.length} ATS providers (${probeProviders.map(p => p.id).join(', ')}); ${tracked.names.size} scannable + ${ledgerSkipped} ledger-cleared, skipped. ${capNote}${canaryNote.length ? `, canary: ${canaryNote.join(',')}` : ''}.\n`);

  const { results, passes, waveLog } = await runWaves(pending, tracked, probeProviders, led);

  const hits = results.filter(r => r.ats);
  const skipped = results.filter(r => r.skipped);
  // Studios we could NOT clear because an ATS rate-limited us — NOT "no feed".
  const uncertain = results.filter(r => !r.ats && !r.skipped && r.uncertain);
  const cleanMisses = results.length - hits.length - skipped.length - uncertain.length;
  const order = { high: 0, medium: 1, verify: 2 };
  hits.sort((a, b) => order[a.confidence] - order[b.confidence]);
  // Split trusted wins (own-domain / name-specific slug) from generic-slug matches
  // that carry namesake risk — the latter must be human-verified before they count.
  const trustedHits = hits.filter(h => h.confidence !== 'verify');
  const reviewHits = hits.filter(h => h.confidence === 'verify');
  const fmtHit = (h) => `  [${h.confidence.toUpperCase().padEnd(6)}] ${h.name.padEnd(28)} ${h.ats.padEnd(15)} ${h.where}  (${h.count} jobs${h.loc ? ', e.g. ' + h.loc : ''})`;
  const reasonAgg = [...uncertainReasons].sort((a, b) => b[1] - a[1]);
  if (JSON_OUT) {
    console.log(JSON.stringify({
      hits, trustedHits, reviewHits, uncertain,
      throttled: Object.fromEntries(throttleHosts),
      uncertainReasons: Object.fromEntries(reasonAgg),
      skippedCount: skipped.length, ledgerSkipped, cleanMisses, total: names.length,
      passes, waves: waveLog, scanVersion: SCAN_VERSION,
    }, null, 2));
  } else {
    console.log(`\n=== NEW HITS (${trustedHits.length}) — trusted, not already in studios.yml ===`);
    for (const h of trustedHits) console.log(fmtHit(h));
    if (reviewHits.length) {
      console.log(`\n⚠️  NEEDS REVIEW (${reviewHits.length}) — generic-slug matches, NAMESAKE RISK. A different company may own this slug; confirm before adding to studios.yml (these stay open and re-surface here until resolved):`);
      for (const h of reviewHits) console.log(fmtHit(h));
    }
    console.log(`\nSkipped ${skipped.length} already-tracked · ${ledgerSkipped} ledger-cleared (scan v${SCAN_VERSION}) · ${cleanMisses} confirmed no-feed (404/empty) · ${passes} wave(s).`);
    if (uncertain.length) {
      console.log(`\n⚠️  UNCERTAIN (${uncertain.length}) — could NOT confirm or deny after ${passes} adaptive wave(s) (throttle / 5xx / network / canary-distrusted 404 or 2xx). "No feed" is NOT proven here.`);
      console.log(`   Re-probe just these ATSes slower:  node probe-studios.mjs --backlog --ats <id> --concurrency 2`);
      for (const u of uncertain.slice(0, 40)) console.log(`     ? ${u.name.padEnd(30)} (${u.uncertain.join(', ')})`);
      if (uncertain.length > 40) console.log(`     … and ${uncertain.length - 40} more`);
    }
    if (reasonAgg.length) {
      console.log(`\n   Uncertainty by ATS:reason: ${reasonAgg.map(([r, n]) => `${r}=${n}`).join(', ')}`);
    }
    if (throttleHosts.size) {
      console.log(`   Throttle (403/429) by host: ${[...throttleHosts].map(([h, n]) => `${h}=${n}`).join(', ')}`);
    }
    console.log('\nHIGH = own-domain match (trust). MEDIUM = name-specific slug. VERIFY = generic slug (namesake risk — check the location).');
  }
}

const isMain = process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url;
if (isMain) await main();

// Exported for unit tests (importing this module does NOT run the probe).
export { classifyStatus as _classifyStatus, classifyError as _classifyError, runEndpoint, probe, checkCanaries, tierFor, nameSlugs, norm, SCAN_VERSION, withHostLimit as _withHostLimit };
// loadLedger / ledgerOpen / mergeLedger are exported at their definitions above.
