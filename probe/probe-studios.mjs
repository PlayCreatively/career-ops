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
//   node probe-studios.mjs --backlog             # probe studios.yml's own backlog (appends to probe-backlog.out)
//                                                #   (status: unresolved + recipe kind browser/unresolved)
//   node probe-studios.mjs --backlog --include-blocked  # also re-probe kind: blocked
//   node probe-studios.mjs --wikipedia-sweden     # pull the Wikipedia SE list
//   node probe-studios.mjs --names f.txt --json   # machine-readable
//   node probe-studios.mjs --backlog --ats breezy,bamboohr --no-timeout  # slow drain known-throttle ATSes
//                                                 #   (auto-applies concurrency 1 + 300ms delay)
//   ... --append-results file.txt                 # accumulate results to file (default: probe-backlog.out)
//   ... --request-delay 500                       # ms delay between consecutive requests to same host
//                                                 #   (auto-enabled for known-throttle ATSes)
//   ... --status-file path.json                   # write a live JSON progress/throttle snapshot
//                                                 #   every wave (for probe-dashboard.mjs)
//   ... --ledger path.tsv                         # use this probe-state ledger instead of the
//                                                 #   default data/probe-state.tsv. Lets the
//                                                 #   dashboard run one instance PER ATS into its
//                                                 #   own shard (no concurrent-writer clobber),
//                                                 #   then merge the shards back into the main one.
//   ... --quick                                   # slug-only ATS (skip custom-domain sweep).
//                                                 #   Won't close domain-capable providers
//                                                 #   (teamtailor/recruitee) in the ledger, so a
//                                                 #   later full run still sweeps their domains.
//   ... --ats breezy[,lever]                      # probe only these provider id(s)
//                                                 #   (auto-detects throttle-prone ATSes: bamboohr,
//                                                 #   breezy, workable, workday; applies concurrency 1
//                                                 #   + 300ms request-delay unless overridden)
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
//   ... --reject "Bloom=lever"                    # mark a reviewed false positive (repeatable): that
//                                                 #   namesake slug never re-probes/re-surfaces, but the
//                                                 #   studio stays open on every other ATS. Ledger-only.
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

// Path anchoring: this script lives in probe/, so the repo root is its parent.
// All config/data paths anchor to REPO_ROOT (not cwd) so the tool runs correctly
// no matter where it's invoked from; run logs default into the probe/ folder.
const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, '..');
const STUDIOS_PATH = path.join(REPO_ROOT, 'studios.yml');

const TIMEOUT_MS = 7000;
// Known throttle-prone ATSes (observed rate-limiting behavior)
const KNOWN_THROTTLE_ATES = new Set(['bamboohr', 'breezy', 'workable', 'workday']);

// Numeric CLI flag reader (returns the default when absent or non-positive).
function numFlag(name, dflt) {
  const i = process.argv.indexOf(name);
  return i !== -1 && Number(process.argv[i + 1]) > 0 ? Number(process.argv[i + 1]) : dflt;
}

// Detect if we're targeting known-throttle ATSes; auto-apply protective defaults
function getProbeAtses() {
  const aIdxA = process.argv.indexOf('--ats');
  const aIdxS = process.argv.indexOf('--skip-ats');
  if (aIdxA === -1 && aIdxS === -1) return null; // No restriction: probe all
  if (aIdxA !== -1) {
    // --ats specified: only these
    const listed = process.argv[aIdxA + 1].split(',').map(s => s.trim());
    return new Set(listed);
  }
  // --skip-ats: all except these
  return null;
}

// Auto-apply throttle defense to known-problem ATSes
const probeTargets = getProbeAtses();
const probingThrottleAtes = probeTargets && [...probeTargets].some(id => KNOWN_THROTTLE_ATES.has(id));
const DEFAULT_CONCURRENCY = probingThrottleAtes ? 1 : 16;
const DEFAULT_REQUEST_DELAY = probingThrottleAtes ? 300 : 0;

// Starting concurrency; auto-halves each wave once a host throttles.
const CONCURRENCY = numFlag('--concurrency', DEFAULT_CONCURRENCY);
// --no-timeout: run until the backlog is EXHAUSTIVELY resolved (no pass/patience
// cap). Safe because the ledger is flushed every wave, so an interrupted run loses
// nothing. Use for the final slow drain passes once a throttler's IP block clears.
const NO_TIMEOUT = process.argv.includes('--no-timeout');
const MAX_PASSES = NO_TIMEOUT ? Infinity : numFlag('--max-passes', 6);     // adaptive wave cap
const BASE_COOLDOWN_S = numFlag('--cooldown', 60); // base seconds between throttled waves
// Mid-wave auto-stop: once EVERY in-play ATS has thrown this many 403/429s, the
// current pool bails instead of grinding the rest of the backlog against a
// throttling host (wave 1 drains the whole backlog in one pool, so without this a
// rate-limited single-ATS instance would 403 its way through thousands of studios
// before the wave-boundary auto-disable ever fires). Unprobed studios stay OPEN
// for the next run. --no-abort disables it (e.g. a deliberate slow --no-timeout drain).
const THROTTLE_ABORT_HITS = numFlag('--abort-after', 8);
const NO_ABORT = process.argv.includes('--no-abort');
const PATIENCE_MS = NO_TIMEOUT ? Infinity : numFlag('--patience', 20) * 60_000; // hard wall-clock cap
const QUICK = process.argv.includes('--quick');
const JSON_OUT = process.argv.includes('--json');
const REPROBE_ALL = process.argv.includes('--reprobe-all'); // ignore the ledger, fresh full probe

// Default result accumulation file (use --append-results <file> to override)
const resultsAppendFile = (() => {
  const idx = process.argv.indexOf('--append-results');
  if (idx !== -1) return process.argv[idx + 1];
  // Default: append to probe-backlog.out (in the probe/ folder)
  return path.join(SCRIPT_DIR, 'probe-backlog.out');
})();

// Optional live-status sidecar (used by probe-dashboard.mjs). When --status-file
// <path> is given, a JSON snapshot of the run is (over)written every wave and once
// at the end, so a UI can poll progress + per-ATS throttle/Retry-After without
// parsing stderr. Absent flag = no file written (zero overhead, default behavior).
const STATUS_FILE = (() => {
  const idx = process.argv.indexOf('--status-file');
  return idx !== -1 ? process.argv[idx + 1] : null;
})();

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
  if (!existsSync(STUDIOS_PATH)) return { names, hosts };
  const doc = yaml.load(readFileSync(STUDIOS_PATH, 'utf8'));
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
  if (!existsSync(STUDIOS_PATH)) return [];
  const includeBlocked = process.argv.includes('--include-blocked');
  const doc = yaml.load(readFileSync(STUDIOS_PATH, 'utf8'));
  const out = [];
  for (const c of doc.tracked_companies || []) {
    if (!c.name || isScannable(c)) continue;
    if (c.recipe?.kind === 'blocked' && !includeBlocked) continue;
    const domain = typeof c.careers_url === 'string' ? registrableDomain(c.careers_url) : '';
    out.push({ name: c.name, domains: domain ? [domain] : [], country: typeof c.country === 'string' ? c.country : '' });
  }
  return out;
}

// ── probe-state ledger (data/probe-state.tsv) ───────────────────────
// Per-studio record of which ATSes were definitively CLEARED (cleanly missed) or
// HIT, plus the scan version. Lets re-runs skip fully-resolved studios and probe
// only each studio's still-OPEN ATSes — the mechanism that drains a throttled
// backlog progressively. Sidecar TSV (mirrors scan-history.tsv) so studios.yml's
// hand-curated comments/order are never touched.
// --ledger <path> overrides the default ledger file. The dashboard's per-ATS
// parallel mode points each instance at its own shard (data/.probe-ledger-<ats>.tsv)
// so concurrent processes never clobber one shared file; it merges them back after.
const LEDGER_OVERRIDE = (() => { const i = process.argv.indexOf('--ledger'); return i !== -1 ? process.argv[i + 1] : null; })();
const LEDGER_PATH = LEDGER_OVERRIDE || path.join(REPO_ROOT, 'data', 'probe-state.tsv');
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
    const [key, name, version, hit, missed, last, conf, rejected] = t.split('\t');
    if (!key) continue;
    m.set(key, { name: name || '', version: Number(version) || 0, hit: hit || '', hitConf: conf || '', missed: new Set((missed || '').split(',').filter(Boolean)), last: last || '', rejected: new Set((rejected || '').split(',').filter(Boolean)) });
  }
  return m;
}
function writeLedger(m, file = LEDGER_PATH) {
  const rows = [
    '# probe-state ledger — per-studio ATS coverage so re-runs skip already-cleared work.',
    '# Written by probe-studios.mjs. name_norm, missed_ats and rejected_ats use provider ids.',
    '# hit_confidence: high|medium = trusted win, verify = namesake risk (needs review), empty = legacy.',
    '# rejected_ats: ATSes whose hit a human reviewed and rejected as a namesake/false positive.',
    '#   Never re-probed and never re-surfaced, but the studio stays OPEN on every other ATS.',
    '#   Durable — a scan-version bump wipes missed_ats but PRESERVES rejected_ats.',
    '# name_norm\tname\tscan_version\thit_ats\tmissed_ats(csv)\tlast_probe\thit_confidence\trejected_ats(csv)',
  ];
  for (const [key, v] of [...m.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    rows.push([key, v.name, v.version, v.hit, [...v.missed].sort().join(','), v.last, v.hitConf || '', [...(v.rejected || [])].sort().join(',')].join('\t'));
  }
  writeFileSync(file, rows.join('\n') + '\n');
}
// Which ATS ids are still OPEN for a studio? null = probe EVERYTHING (no ledger
// entry, or it predates the current SCAN_VERSION → its misses are invalidated).
// An empty Set = nothing open (fully cleared / already hit) → caller skips it.
export function ledgerOpen(led, key, providerIds) {
  const e = led.get(key);
  if (!e) return null;                                  // never probed → all open
  const rejected = e.rejected || new Set();
  // A scan-version bump invalidates stale misses (re-probe everything → null) — but
  // a human-reviewed rejection is a durable fact, so if any exist, return the
  // probe-all set minus those; with none, keep the plain null "probe-all" signal.
  if (e.version < SCAN_VERSION) return rejected.size ? new Set(providerIds.filter(id => !rejected.has(id))) : null;
  if (e.hit && TRUSTED_TIERS.has(e.hitConf)) return new Set(); // trusted hit → resolved, skip
  // A verify/legacy-tier hit is NOT a confirmed win (namesake risk): keep the
  // studio OPEN so it stays in the needs-review bucket on every run until a human
  // resolves it (adds the real careers_url to studios.yml, or rejects it as junk).
  return new Set(providerIds.filter(id => !e.missed.has(id) && !rejected.has(id)));
}
// Fold one studio's result into the ledger: union the newly-cleared ATSes onto
// what we already knew (reset first if the prior record predates SCAN_VERSION).
// A hit also records the confidence tier the probe computed so re-runs and
// downstream readers can tell a trusted win from a namesake-risk match.
export function mergeLedger(led, key, name, result) {
  const prev = led.get(key) || { version: 0, hit: '', hitConf: '', missed: new Set(), rejected: new Set() };
  const base = prev.version >= SCAN_VERSION ? prev.missed : new Set(); // version bump wipes stale misses
  const missed = new Set(base);
  for (const id of (result.missedAts || [])) missed.add(id);
  const hit = result.ats || prev.hit || '';
  // On a fresh hit, store its tier; otherwise carry the prior tier alongside the
  // prior hit (a no-hit pass must not blank an earlier hit's confidence).
  const hitConf = result.ats ? (result.confidence || '') : (prev.hitConf || '');
  led.set(key, { name, version: SCAN_VERSION, hit, hitConf, missed, last: today(), rejected: prev.rejected || new Set() });
}
// Record a human-reviewed false positive: the studio is NOT the company on this
// ATS's board (a namesake). Drops the hit (so it leaves the needs-review bucket)
// and files the ATS under rejected_ats so it never re-probes or re-surfaces —
// while every OTHER ATS stays open, so a real board can still be found later.
// Version is stamped current so a stale row's rejection takes effect immediately.
export function rejectHit(led, name, ats) {
  const key = norm(name);
  const prev = led.get(key) || { name, version: 0, hit: '', hitConf: '', missed: new Set(), rejected: new Set() };
  const missed = prev.version >= SCAN_VERSION ? new Set(prev.missed) : new Set();
  const rejected = new Set(prev.rejected || []);
  rejected.add(ats);
  // Clearing the hit only when it WAS this ATS keeps a genuine hit on another ATS.
  const clearHit = prev.hit === ats;
  led.set(key, {
    name: prev.name || name,
    version: SCAN_VERSION,
    hit: clearHit ? '' : prev.hit,
    hitConf: clearHit ? '' : prev.hitConf,
    missed, rejected, last: today(),
  });
  return { key, name: prev.name || name, ats, clearedHit: clearHit };
}
// Load → reject → persist against `file`, in one call. The single entry point the
// dashboard and any other tool use so all reject logic stays in this module.
export function recordReject(name, ats, file = LEDGER_PATH) {
  const led = loadLedger(file);
  const r = rejectHit(led, name, ats);
  writeLedger(led, file);
  return r;
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
const throttleHosts = new Map();       // host -> 403/429 count (live throttle signal — drives auto-disable)
const throttledDomains = new Set();    // registrable ATS domains that have thrown 403/429 (tightens the per-ATS gate)
const retryAfterHosts = new Map();     // host -> max Retry-After seconds seen (how long the ATS asked us to wait)
const EMPTY_SET = new Set();           // shared immutable default for the `disabled` option
const uncertainReasons = new Map();    // reason string -> count (aggregate, FINAL uncertain only)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function hostOf(u) { try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return u; } }
function regDomainOf(h) { return String(h).split('.').slice(-2).join('.'); }  // last two labels (breezy.hr, greenhouse.io)
function bump(map, k) { map.set(k, (map.get(k) || 0) + 1); }
function sumMap(map) { let n = 0; for (const v of map.values()) n += v; return n; }
// Retry-After is OPTIONAL (workable hands back ~4h on a 429; breezy's 403s carry
// nothing) — so it can't be the throttle trigger, only enrichment. Accepts the two
// HTTP forms: delta-seconds ("120") or an HTTP-date. Returns seconds, or null.
function parseRetryAfter(v) {
  if (!v) return null;
  const s = String(v).trim();
  if (/^\d+$/.test(s)) return parseInt(s, 10);
  const d = Date.parse(s);
  return Number.isNaN(d) ? null : Math.max(0, Math.round((d - Date.now()) / 1000));
}
// The stable ATS base domain a provider's SLUG endpoints live on (greenhouse.io,
// breezy.hr, lever.co, …). Domain endpoints hit the studio's own host, not the ATS,
// so they're excluded. Lets us tell "this whole ATS is throttling us" apart from
// "one guessed custom domain 403'd" — even for per-tenant-subdomain ATSes where the
// host varies per studio ({slug}.breezy.hr).
function atsDomainOf(p) {
  for (const e of p.endpoints || []) {
    if (e.kind !== 'slug') continue;
    try { return hostOf(e.url('canary-probe')).split('.').slice(-2).join('.'); } catch { /* next */ }
  }
  return null;
}
// Has this provider's ATS thrown a 403/429 at us this run? PRIMARY, rot-proof
// throttle signal (no canary needed): returns a sample throttled host, or null.
function providerThrottled(p) {
  const dom = atsDomainOf(p);
  if (!dom) return null;
  for (const h of throttleHosts.keys()) if (h.split('.').slice(-2).join('.') === dom) return h;
  return null;
}
// How many 403/429s this provider's ATS has thrown this run (summed across its
// tenant hosts). Drives the mid-wave auto-stop: one stray 403 is noise, but a
// sustained count means the ATS is rate-limiting us and grinding the rest of the
// backlog at it is pointless (every request just 403s).
function providerThrottleCount(p) {
  const dom = atsDomainOf(p);
  if (!dom) return 0;
  let n = 0;
  for (const [h, c] of throttleHosts) if (h.split('.').slice(-2).join('.') === dom) n += c;
  return n;
}

// Write a live JSON snapshot of the current run for the dashboard to poll. No-op
// unless --status-file was passed. Per-provider it reports the live throttle host
// (if any) and the longest Retry-After that host handed back, so a UI can show
// "how long a wait this ATS gave" and count down "time since check".
function writeStatusSnapshot(probeProviders, disabled, progress, phase) {
  if (!STATUS_FILE) return;
  const providers = {};
  for (const p of probeProviders) {
    const host = providerThrottled(p);
    providers[p.id] = {
      domain: atsDomainOf(p),
      disabled: disabled.has(p.id),
      throttled: !!host,
      sampleHost: host || null,
      retryAfterSec: host && retryAfterHosts.has(host) ? retryAfterHosts.get(host) : null,
    };
  }
  const snap = { ts: new Date().toISOString(), phase, progress, providers };
  try { writeFileSync(STATUS_FILE, JSON.stringify(snap, null, 2)); } catch { /* best-effort */ }
}

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
const REQUEST_DELAY_MS = numFlag('--request-delay', DEFAULT_REQUEST_DELAY); // ms delay between requests to same host (throttle defense)
const hostGates = new Map();           // gate key -> { active, queue:[], lastRequest }
// A gate tightens if its exact key throttled OR its registrable ATS domain did —
// so one tenant of an ATS throwing 403 squeezes the WHOLE ATS's shared budget.
function hostCap(key) { return (throttleHosts.has(key) || throttledDomains.has(regDomainOf(key))) ? PER_HOST_THROTTLED : PER_HOST_MAX; }
// Run fn() while holding a slot for `host`; waiters re-check the (possibly
// tightened) cap on wake, so a host that throttles mid-run squeezes immediately.
// Optional inter-request delay (REQUEST_DELAY_MS) enforces minimum time between
// successive requests to the same host as throttle defense.
async function withHostLimit(host, fn) {
  let g = hostGates.get(host);
  if (!g) { g = { active: 0, queue: [], lastRequest: 0 }; hostGates.set(host, g); }
  while (g.active >= hostCap(host)) await new Promise((r) => g.queue.push(r));

  // Apply inter-request delay if configured, with random jitter so the cadence
  // isn't a metronome — a perfectly even 300ms beat is itself a bot fingerprint a
  // WAF can rate-shape on. Each gap is the base delay ±40% (0.6×–1.4×), so the
  // stream looks organic while preserving the same average pacing.
  if (REQUEST_DELAY_MS > 0) {
    const target = Math.round(REQUEST_DELAY_MS * (0.6 + Math.random() * 0.8));
    const elapsed = Date.now() - g.lastRequest;
    if (elapsed < target) {
      await sleep(target - elapsed);
    }
  }

  g.active++;
  g.lastRequest = Date.now();
  try { return await fn(); }
  finally {
    g.active--;
    const q = g.queue; g.queue = []; // wake all; each re-checks the cap in the while loop
    for (const r of q) r();
  }
}

// Pure: map one fetch outcome to a kind. Exported for testing/reasoning.
//   { kind: 'notfound' }                    → certain miss (distrusted only while the ATS is actively throttling)
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
    // Manual redirect handling (NOT redirect:'follow'). A live tenant feed is
    // served at the tenant's OWN host with a 200. A DEAD tenant typically 302s to
    // the ATS marketing root (e.g. a missing {slug}.breezy.hr → https://breezy.hr/),
    // which then 403s our bot User-Agent. Following that blindly mis-reads the
    // marketing 403 as a *tenant rate-limit* and latches a phantom throttle across
    // the WHOLE ATS off the very first dead slug — poisoning every later probe into
    // "uncertain". The tell is a redirect OFF the tenant's own host (e.g. the
    // subdomain {slug}.breezy.hr → the bare apex breezy.hr): the feed lives at the
    // tenant host, so a cross-HOST bounce = "no tenant here" = clean miss. A
    // same-host redirect (trailing slash / scheme bump) is followed (bounded).
    // hostOf() strips a leading `www.`, so a legit apex↔www redirect still follows.
    const originHost = hostOf(url);
    let current = url;
    let res;
    for (let hop = 0; ; hop++) {
      res = await fetch(current, { signal: ctrl.signal, redirect: 'manual', headers: { 'User-Agent': 'Mozilla/5.0', Accept: json ? 'application/json' : '*/*' } });
      if (res.status < 300 || res.status >= 400) break;        // not a redirect → classify below
      const loc = res.headers.get('location');
      let next = null;
      try { next = loc ? new URL(loc, current).href : null; } catch { next = null; }
      // No target, a bounce to a DIFFERENT host (marketing/app root), or too many
      // hops → this host has no tenant feed for us. Clean miss, NOT a throttle.
      if (!next || hop >= 3 || hostOf(next) !== originHost) return { kind: 'notfound' };
      current = next;                                          // same-host redirect: follow once more
    }
    if (res.status === 403 || res.status === 429) { const h = hostOf(url); bump(throttleHosts, h); throttledDomains.add(regDomainOf(h)); } // clear rate-limit → disable + per-ATS gate trigger
    if (res.status === 403 || res.status === 429 || res.status === 503) {           // capture the wait time when offered (any status)
      const ra = parseRetryAfter(res.headers.get('retry-after'));
      if (ra != null) { const h = hostOf(url); retryAfterHosts.set(h, Math.max(retryAfterHosts.get(h) || 0, ra)); }
    }
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
async function get(url, json = true, gateKey = null) {
  const host = gateKey || hostOf(url);   // gateKey lets slug probes share ONE per-ATS budget (see runEndpoint)
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
// Common-word REVIEW GATE (not a filter): a lone slug that's an everyday English
// word is high namesake risk — a different company likely owns it on the same ATS.
// Matching here downgrades a slug hit from MEDIUM to VERIFY, so it surfaces in
// "NEEDS REVIEW" and stays open instead of being auto-trusted. Fail-safe: a real
// studio is still shown (one click to confirm), never silently dropped. Extend
// freely — over-inclusion only adds a review step, it never hides a hit.
const GENERIC = /^(the|game|games|studio|play|fun|echo|grin|ghost|mirage|upside|overflow|pathos|brimstone|foxglove|carbon|merge|linear|render|sun|moon|core|solid|focus|frontier|niantic|vanilla|vector|parity|radiant|walrus|spherical|evermore|breaker|architect|tiger|bloom|miso|foley|jumpgate|dutch|prism|vertex|nexus|apex|summit|pixel|atlas|orbit|forge|anvil|ember|nova|comet|matrix|cipher|phoenix|titan|aurora|zenith|horizon|catalyst|momentum|velocity|quantum|fusion|element|origin|legacy|vista|spark|pulse|flux|drift|haven|nomad|wander|odyssey|saga|legend|myth|oracle|sage|relic|prime|vital|lucid|prism)$/;

// Rough country inference from a free-text job location. Returns an ISO-2 code or
// '' when undeterminable (e.g. bare "Remote"). Conservative — fires only on clear
// place signals — so it can DISPROVE a namesake (hit located in the wrong country)
// but never falsely confirm one. Used to vet slug hits against the studio's known
// country (see finalize): a "Vector Interactive" (NL) hit whose only role is in
// Palo Alto is almost certainly a US namesake on the same ATS.
const LOC_SIGNALS = [
  ['US', /\b(usa|united states|u\.s\.|us[- ]?(only|based|remote)|remote\s*[-–,]\s*us|california|\bca\b|new york|\bny\b|texas|\btx\b|washington|seattle|san francisco|bay area|palo alto|oakland|san jose|los angeles|austin|boston|chicago|des moines|atlanta|denver|miami|portland|raleigh|nashville)\b/],
  ['CA', /\b(canada|toronto|vancouver|montreal|ontario|quebec|alberta)\b/],
  ['GB', /\b(united kingdom|\buk\b|england|scotland|london|manchester|brighton|guildford|edinburgh|leamington)\b/],
  ['KR', /\b(korea|seoul)\b/],
  ['JP', /\b(japan|tokyo|osaka|kyoto)\b/],
  ['AU', /\b(australia|sydney|melbourne|brisbane)\b/],
  ['IN', /\b(india|bangalore|bengaluru|mumbai|delhi|rohini|hyderabad|pune|gurgaon|noida)\b/],
  ['SG', /\b(singapore)\b/],
  ['BR', /\b(brazil|brasil|s[ãa]o paulo|rio de janeiro)\b/],
  ['NL', /\b(netherlands|nederland|amsterdam|rotterdam|eindhoven|utrecht|the hague|den haag|hilversum|breda)\b/],
  ['SE', /\b(sweden|sverige|stockholm|gothenburg|g[öo]teborg|malm[öo]|sk[öo]vde|ume[åa]|link[öo]ping|karlshamn)\b/],
  ['CH', /\b(switzerland|schweiz|suisse|svizzera|z[üu]rich|geneva|gen[èe]ve|lausanne|bern|basel|lugano|zug)\b/],
  ['IS', /\b(iceland|[íi]sland|reykjav[íi]k|kópavogur|akureyri)\b/],
  ['DE', /\b(germany|deutschland|berlin|munich|m[üu]nchen|hamburg|cologne|k[öo]ln|frankfurt)\b/],
  ['FR', /\b(france|paris|lyon|bordeaux|montpellier|toulouse)\b/],
  ['FI', /\b(finland|helsinki|tampere|espoo)\b/],
  ['NO', /\b(norway|norge|oslo|bergen)\b/],
  ['DK', /\b(denmark|danmark|copenhagen|k[øo]benhavn|aarhus)\b/],
  ['PL', /\b(poland|polska|warsaw|warszawa|krak[óo]w|wroc[łl]aw)\b/],
];
function inferCountry(loc) {
  const l = String(loc || '').toLowerCase();
  for (const [code, re] of LOC_SIGNALS) if (re.test(l)) return code;
  return '';
}
// Does a hit's location CONTRADICT the studio's known country? Only true when both
// are determinable and differ — "Remote"/unknown never contradicts (can't disprove).
function locContradicts(country, loc) {
  if (!country || !loc) return false;
  const hitC = inferCountry(loc);
  return !!hitC && hitC !== country.toUpperCase();
}

// Game-industry content signal — a fail-safe REVIEW gate, twin of GENERIC and
// locContradicts. A subdomain/board slug can be a NAMESAKE: a pharma, construction
// or insurance company squatting the same single word on the same ATS (the class
// that produced ~35 false "trusted" hits in the namesake audit — acino=pharma,
// triumph=construction, etc.). The length/GENERIC heuristic in tierFor can't catch
// a 6+ char non-generic word like "acino" or "triumph". The decisive disproof is
// the board itself: a real game studio posts game-shaped roles. So a MEDIUM slug
// hit whose visible job titles are ALL non-game is almost certainly a namesake —
// downgrade to VERIFY (surfaced in NEEDS REVIEW, one click to confirm, never
// dropped). Keep tokens game-SPECIFIC so generic cross-industry titles (a bare QA /
// Producer / Designer / Artist, which pharma & construction also post) don't
// falsely CONFIRM a namesake. Extend freely: over-inclusion only keeps a borderline
// hit trusted, it never hides one.
const GAME_SIGNAL = /\b(game(s|play|dev)?|unity|unreal|godot|cryengine|game ?engine|engine (programmer|developer|engineer)|level design(er)?|technical artist|character artist|environment artist|concept artist|3d artist|vfx artist|gameplay (programmer|engineer|designer)|graphics (programmer|engineer)|tools (programmer|engineer)|narrative design(er)?|game (design(er)?|artist|producer|writer|programmer|developer)|animator|esports|playtest)\b/i;

// Extract a flat list of job titles from any probed ATS payload (jobs/result/
// content/items arrays, or a bare array) across each ATS's title field. Used ONLY
// to vet game-relevance at hit time — never persisted.
function probeTitles(data) {
  const arr = Array.isArray(data) ? data
    : Array.isArray(data?.jobs) ? data.jobs
    : Array.isArray(data?.result) ? data.result
    : Array.isArray(data?.content) ? data.content
    : Array.isArray(data?.items) ? data.items
    : [];
  return arr.map(j => String(
    j?.title || j?.name || j?.text || j?.jobOpeningName || j?.jobTitle || j?.attributes?.title || ''
  ).trim()).filter(Boolean);
}

// True ONLY when there are titles to judge AND none carries a game signal — i.e.
// positive contrary evidence this tenant isn't a game studio. No titles → false
// (no evidence can't disprove — mirrors how bare "Remote" never contradicts a
// country in locContradicts).
function gameContentContradicts(titles) {
  if (!titles || titles.length === 0) return false;
  return !titles.some(t => GAME_SIGNAL.test(t));
}

// ── Provider-driven probe descriptors ───────────────────────────────
// The set of ATSes to probe is NOT hardcoded here — it is auto-loaded from
// providers/*.mjs. Any provider that exports a `probe` descriptor (see the Probe
// typedef in providers/_types.js) is picked up; aggregators and recipe/parser
// providers omit it and are skipped. Adding a discoverable ATS = drop in one
// provider file, no edit here. Mirrors how scan.mjs auto-loads providers.
const PROVIDERS_DIR = path.join(REPO_ROOT, 'providers');

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

// Canary preflight (NON-fatal early-warning, not a kill switch). For each provider
// that declares a `canary` (a known-live slug), hit it on the slug endpoint:
//   • throttle/error status (403/429/5xx/timeout/network)  → DISABLE this ATS for
//     the run. A live company still errors when the ATS rate-limits us, so this is
//     a real throttle, never canary-rot.
//   • valid 2xx (parseable body)                           → healthy ('ok').
//   • clean 404, or a 2xx whose body won't parse (disguised) → the canary may be
//     STALE: the company likely left this ATS. We do NOT disable on this — disabling
//     is driven by the live 403/429 signal — we only WARN so the slug can be
//     refreshed. This keeps a discontinued canary from silently killing a working ATS.
// `data != null` (not parse()) is the liveness test, so a real tenant with 0 open
// roles still reads as healthy (an empty board ≠ a stale canary).
// Returns { disabled:Set<id>, stale:Map<id,reason>, checked:[[id,state]] }.
//
// Pure classifier (exported for testing) — the rot-safety lives HERE: only a
// throttle/error disables; a clean 404 or unparseable 2xx is merely 'stale-*'.
//   'ok'        live 2xx with a parseable body
//   'stale-404' the canary slug 404'd — the company likely left this ATS → WARN only
//   'stale-2xx' a 2xx whose body won't parse (disguised) → WARN only
//   'disabled'  throttle/5xx/timeout/network/dnsfail → drop the ATS for the run
export function classifyCanary(r) {
  if (r.kind === 'data') return r.data != null ? 'ok' : 'stale-2xx';
  if (r.kind === 'notfound') return 'stale-404';
  return 'disabled';
}
async function checkCanaries(providers) {
  const disabled = new Set();
  const stale = new Map();
  const checked = [];
  for (const p of providers) {
    if (!p.canary) continue;
    const ep = p.endpoints.find(e => e.kind === 'slug');
    if (!ep) continue;
    const verdict = classifyCanary(await get(ep.url(p.canary)));
    if (verdict === 'ok') checked.push([p.id, 'ok']);
    else if (verdict === 'disabled') { disabled.add(p.id); checked.push([p.id, verdict]); }
    else { stale.set(p.id, verdict); checked.push([p.id, verdict]); }   // stale-404 / stale-2xx → warn only
  }
  return { disabled, stale, checked };
}

// Returns one of:
//   {type:'hit', ...}                  — confirmed feed
//   {type:'miss'}                      — CERTAIN miss (404/410 or parse-rejected 2xx;
//                                        also a non-resolving guessed custom domain)
//   {type:'uncertain', reason}         — couldn't confirm OR deny (throttle/5xx/network/
//                                        or a distrusted 404 while THIS ATS is actively throttling)
async function runEndpoint(p, endpoint, key) {
  // Per-ATS concurrency gate: slug endpoints on per-tenant subdomains
  // ({slug}.breezy.hr) would otherwise each get their OWN per-host budget, so an
  // ATS with N tenants gets hit N-wide at once and trips its account-level WAF.
  // Gate slug probes by the ATS's registrable domain (breezy.hr) so ALL of one
  // ATS's tenant requests share a single budget — throttle-control is genuinely
  // per-ATS. Fixed-host ATSes (greenhouse.io) are unaffected (one host already).
  // Domain-sweep guesses hit the studio's OWN host, so they stay per-host (null).
  const gateKey = endpoint.kind === 'slug' ? (atsDomainOf(p) || null) : null;
  const r = await get(endpoint.url(key), true, gateKey);
  // Disguised-throttle defense, tied to the LIVE signal (not a canary): a 404 or a
  // parse-rejected 2xx can't be trusted as a real "no tenant" while THIS ATS is
  // actively throwing 403/429 at us — it may be a WAF challenge masquerading as a
  // clean answer. Slug endpoints only; domain-sweep guesses stay a miss.
  const distrust = endpoint.kind !== 'domain' && !!providerThrottled(p);
  if (r.kind === 'data') {
    const hit = endpoint.parse(r.data);
    if (!hit) {
      if (distrust) return { type: 'uncertain', reason: 'maybe_throttled_2xx' };
      return { type: 'miss' };                    // 2xx the ATS served but no match → certain
    }
    return {
      type: 'hit',
      ats: endpoint.label || p.id,
      provider: p.id,                                       // real provider id (label-agnostic) for studios.yml `provider:`
      where: endpoint.where(key),
      careersUrl: endpoint.careersUrl ? endpoint.careersUrl(key) : null, // canonical scan-ready URL (one-click add)
      count: hit.count,
      loc: hit.loc || '',
      confidence: tierFor(p, endpoint, key),
      sampleTitles: probeTitles(r.data), // vetting-only (game-relevance); stripped in finalize, never persisted
    };
  }
  if (r.kind === 'notfound') {
    if (distrust) return { type: 'uncertain', reason: 'maybe_throttled_404' };
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
// so the well-behaved ATSes resolved in wave 1 are never re-hit. `disabled`
// (Set<providerId>) lists ATSes dropped for the whole run (throttling us): we make
// NO network call for them and leave their ledger cell OPEN (uncertain, never a
// false miss) so the next run retries them — they're not re-probed this run.
async function probe(entry, tracked, probeProviders, { restrict = null, disabled = EMPTY_SET } = {}) {
  if (tracked.names.has(norm(entry.name))) return { name: entry.name, skipped: 'already in studios.yml' };
  const selected = restrict ? probeProviders.filter(p => restrict.has(p.id)) : probeProviders;
  // Probe throttle-prone ATSes LAST. A studio that hits on a reliable fixed-host
  // ATS (greenhouse/lever/ashby/…) short-circuits and returns before we ever touch
  // a rate-limited one — so the per-ATS gate's bounded slow lanes (breezy/bamboohr)
  // never hold up the common path. Stable sort: same-class order is preserved.
  const providers = [...selected].sort((a, b) =>
    (KNOWN_THROTTLE_ATES.has(a.id) ? 1 : 0) - (KNOWN_THROTTLE_ATES.has(b.id) ? 1 : 0));
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
    // ATS disabled for this run (throttling us) → leave it OPEN, don't touch the
    // network. Marked uncertain (so the studio is honestly "unconfirmed") but NOT
    // added to retryAts, so the wave loop won't re-probe it this run.
    if (disabled.has(p.id)) { uncertainAts.add(`${p.id}:disabled_throttle`); continue; }
    const slugEndpoints = p.endpoints.filter(e => e.kind === 'slug');
    if (!slugEndpoints.length) continue;
    const slugs = p.slugs ? p.slugs(entry.name) : nameSlugs(entry.name);
    let pUncertain = false;
    for (const slug of slugs) {
      for (const endpoint of slugEndpoints) {
        const r = await runEndpoint(p, endpoint, slug);
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
    const domainProbes = providers.filter(p => !disabled.has(p.id)).flatMap(p => p.endpoints.filter(e => e.kind === 'domain').map(e => [p, e]));
    if (domainProbes.length) {
      for (const domain of domainGuesses(entry.name, entry.domains)) {
        for (const prefix of PREFIXES) {
          const host = `${prefix}.${domain}`;
          for (const [p, endpoint] of domainProbes) {
            const r = await runEndpoint(p, endpoint, host);
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
  // Namesake vetting: a MEDIUM (name-slug) hit whose only role sits in a country
  // OTHER than the studio's known country is almost certainly a different company
  // on the same ATS — downgrade to VERIFY so it lands in NEEDS REVIEW (still shown,
  // never dropped). Own-domain HIGH hits are exempt (a real studio can post remote
  // roles abroad); VERIFY stays VERIFY.
  if (rest.confidence === 'medium' && locContradicts(entry.country, rest.loc)) {
    rest.confidence = 'verify';
    rest.namesakeFlag = `loc '${rest.loc}' ≠ ${entry.country}`;
  }
  // Game-content vetting (twin of the loc check above): a MEDIUM slug hit whose
  // visible job titles are ALL non-game is almost certainly a namesake squatting the
  // slug (the acino-pharma / triumph-construction false-positive class) — downgrade
  // to VERIFY so it lands in NEEDS REVIEW. Own-domain HIGH hits never reach here as
  // medium, so they're exempt; an empty/untitled board isn't judged (can't disprove).
  if (rest.confidence === 'medium' && gameContentContradicts(rest.sampleTitles)) {
    rest.confidence = 'verify';
    const reason = `no game signal in ${rest.sampleTitles.length} title(s)`;
    rest.namesakeFlag = rest.namesakeFlag ? `${rest.namesakeFlag}; ${reason}` : reason;
  }
  delete rest.sampleTitles; // vetting-only — never persisted to ledger / studios.yml
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
  const disabled = new Set();       // provider ids dropped for THIS run (throttling/blocking us)
  const staleCanaries = new Map();  // provider id -> reason (warned once; never disables)
  // Disable a provider for the rest of the run, logging it once. Its open ledger
  // cells are left untouched, so the NEXT run retries them — no `blocked_until`
  // file needed (probing is infrequent; the limit has lifted by next time).
  const disableProvider = (id, why) => {
    if (disabled.has(id)) return;
    disabled.add(id);
    process.stderr.write(`  ⏭️  ${id}: ${why} — disabled for THIS run; its cells stay OPEN (next run retries them).\n`);
  };
  let conc = CONCURRENCY;
  let pass = 0;
  while (pending.length) {
    pass++;
    // Canary preflight on the providers still in play: a throttling canary disables
    // its ATS early (cheap); a stale (404) canary only warns — it never disables, so
    // a discontinued canary company can't silently kill a working ATS.
    const inPlay = probeProviders.filter(p => !disabled.has(p.id) && pending.some(x => !x.restrict || x.restrict.has(p.id)));
    const { disabled: canaryDown, stale, checked } = await checkCanaries(inPlay);
    for (const id of canaryDown) disableProvider(id, `canary signals throttle/block (${checked.find(c => c[0] === id)?.[1]})`);
    for (const [id, why] of stale) if (!staleCanaries.has(id)) {
      staleCanaries.set(id, why);
      const slug = probeProviders.find(p => p.id === id)?.canary;
      process.stderr.write(`  ⚠️  ${id}: canary '${slug}' returned ${why} — may be discontinued. NOT disabling (live 403/429 still guards it); refresh its canary slug.\n`);
    }
    const throttleBefore = sumMap(throttleHosts);
    // Live within-wave progress: wave 1 drains the whole backlog in one pool, so
    // without this the dashboard's numbers sit frozen until the wave ends. Emit a
    // snapshot as each studio resolves (throttled to ~1/s so we don't thrash the
    // status file), counting resolved/hits against what prior waves already banked.
    const baseResolved = terminal.length;
    const baseHits = terminal.filter(t => t.ats).length;
    const waveTotal = pending.length;
    let hitsThisWave = 0, lastTick = 0;
    const onDone = (doneCount, r) => {
      if (r && r.ats) hitsThisWave++;
      // Fold EVERY completed studio into the ledger as it resolves (mergeLedger
      // unions, so the end-of-wave merge below stays a safe no-op). Wave 1 drains
      // the whole backlog in one pool, so without this the ledger — and the
      // dashboard's per-ATS coverage bars that read it — wouldn't move until the
      // wave ended, and an interrupt mid-wave-1 would lose ALL the cleared work.
      if (led && r && !r.skipped) mergeLedger(led, norm(r.name), r.name, r);
      const now = Date.now();
      if (now - lastTick < 1000 && doneCount < waveTotal) return;
      lastTick = now;
      if (led) writeLedger(led);   // throttled (~1/s) flush so coverage bars climb live + interrupts keep progress
      writeStatusSnapshot(probeProviders, disabled,
        { pass, concurrency: conc, pending: waveTotal - doneCount, resolved: baseResolved + doneCount, hits: baseHits + hitsThisWave, elapsedMs: Date.now() - startedAt },
        'running');
    };
    // Mid-wave auto-stop: bail the pool once EVERY ATS still in play is throttling
    // us (for a single-ATS dashboard instance that's just "this ATS is throttling").
    // The tail of `pending` is left unprobed — its cells stay OPEN for next run.
    const throttledOut = () => {
      if (NO_ABORT) return false;
      const live = probeProviders.filter(p => !disabled.has(p.id));
      return live.length > 0 && live.every(p => providerThrottleCount(p) >= THROTTLE_ABORT_HITS);
    };
    const passResults = await runPool(pending,
      x => probe(x.entry, tracked, probeProviders, { restrict: x.restrict, disabled }), conc, onDone, throttledOut);
    const aborted = throttledOut();
    const throttleDelta = sumMap(throttleHosts) - throttleBefore;
    // PRIMARY, rot-proof auto-disable: any provider whose ATS host threw 403/429 this
    // run is rate-limiting us → drop it for the remaining waves (no canary needed).
    for (const p of probeProviders) {
      if (disabled.has(p.id)) continue;
      const h = providerThrottled(p);
      if (h) { const ra = retryAfterHosts.get(h); disableProvider(p.id, `${h} returned 403/429${ra != null ? ` (Retry-After ~${ra}s)` : ''}`); }
    }
    const next = [];
    for (let k = 0; k < passResults.length; k++) {
      const r = passResults[k];
      if (!r) continue;   // unprobed (pool aborted on throttle) — leave OPEN for next run
      if (r.ats || r.skipped) { terminal.push(r); continue; }   // hit / skip = terminal
      // ATSes worth retrying = those uncertain this pass MINUS any now disabled. If
      // nothing probeable is left, the studio is terminal: uncertain if anything was
      // unconfirmed (incl. a disabled ATS), else a clean miss.
      const retry = r.retryAts ? new Set(r.retryAts.filter(id => !disabled.has(id))) : new Set();
      if (retry.size === 0) terminal.push(r);
      else next.push({ entry: pending[k].entry, restrict: retry, lastUncertain: r.uncertain });
    }
    // Persist progress EVERY wave (not just at the end) so a long / no-timeout run
    // that's interrupted still keeps the ATSes it cleared. mergeLedger unions, so
    // folding a still-uncertain studio's partial misses repeatedly is idempotent.
    if (led) {
      for (const r of passResults) {
        if (!r || r.skipped) continue;
        mergeLedger(led, norm(r.name), r.name, r);
      }
      writeLedger(led);
    }
    const prevRemaining = pending.length;
    waveLog.push({ pass, conc, in: prevRemaining, resolved: prevRemaining - next.length, remaining: next.length, throttleDelta, disabled: [...disabled], canaries: checked });
    const resolvedTotal = terminal.length;
    writeStatusSnapshot(probeProviders, disabled,
      { pass, concurrency: conc, pending: next.length, resolved: resolvedTotal, hits: terminal.filter(t => t.ats).length, elapsedMs: Date.now() - startedAt },
      'running');
    pending = next;
    // Auto-stopped mid-wave: every in-play ATS is throttling. Bail now (the
    // unprobed tail stays OPEN) instead of grinding the backlog against a 403 wall.
    if (aborted) {
      const who = probeProviders.filter(p => providerThrottleCount(p) >= THROTTLE_ABORT_HITS).map(p => p.id).join(', ');
      process.stderr.write(`  ⛔ auto-stopped: ${who || 'all in-play ATSes'} throttling (≥${THROTTLE_ABORT_HITS} × 403/429) — left ${next.length} studio(s) OPEN for next run.\n`);
      break;
    }
    if (!pending.length) break; // EXHAUSTIVELY finished — every studio reached a terminal state

    const elapsed = Date.now() - startedAt;
    const stillStruggling = throttleDelta > 0;
    const noProgress = pending.length >= prevRemaining;
    // Stop conditions: pass/patience cap, OR genuinely stuck with no throttle in
    // sight (persistent network failure — retrying won't help). A throttling ATS is
    // now auto-disabled (above), so it no longer keeps us looping — the remaining
    // uncertain are transient 5xx/network worth a cooldown.
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
    // Inter-wave cooldown: base cooldown + extra delay if request-delay is set
    let cool = BASE_COOLDOWN_S * (stillStruggling ? pass : 1);
    if (REQUEST_DELAY_MS > 0 && stillStruggling) {
      cool += REQUEST_DELAY_MS / 1000; // add request-delay to wave cooldown when throttle active
    }
    process.stderr.write(`  wave ${pass}: ${next.length} uncertain remain${stillStruggling ? ` (throttle active)` : ''} — cooling ${cool}s, re-probing at concurrency ${conc}...\n`);
    await sleep(cool * 1000);
  }
  writeStatusSnapshot(probeProviders, disabled,
    { pass, concurrency: conc, pending: 0, resolved: terminal.length, hits: terminal.filter(t => t.ats).length, elapsedMs: Date.now() - startedAt },
    'done');
  return { results: terminal, passes: pass, waveLog, disabled, staleCanaries };
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

// shouldAbort (optional): polled before each pull — when it returns true the pool
// stops dispatching new work (in-flight workers finish), leaving the tail of
// `items` unprobed (their `out[idx]` stays undefined). Callers must treat holes as
// "not probed" (left OPEN), never as a miss.
async function runPool(items, worker, limit, onDone, shouldAbort) {
  const out = []; let i = 0; let done = 0;
  async function next() {
    while (i < items.length) {
      if (shouldAbort && shouldAbort()) { i = items.length; break; }
      const idx = i++; out[idx] = await worker(items[idx]); done++; if (onDone) onDone(done, out[idx]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, next));
  return out;
}

// ── main (only when run as a script; importing for tests is side-effect-free) ──
async function main() {
  const tracked = loadTracked();
  let probeProviders = await loadProbeProviders(PROVIDERS_DIR);

  // --reject "Studio Name=ats"  (repeatable) — record a human-reviewed false
  // positive so future runs skip that one namesake slug. Ledger-only, no probing.
  const rejectArgs = process.argv.reduce((acc, a, i) => (a === '--reject' && process.argv[i + 1] ? [...acc, process.argv[i + 1]] : acc), []);
  if (rejectArgs.length) {
    const validIds = new Set(probeProviders.map(p => p.id));
    const led = loadLedger();
    let n = 0;
    for (const spec of rejectArgs) {
      const eq = spec.lastIndexOf('=');
      if (eq < 1) { process.stderr.write(`reject: bad spec "${spec}" (want "Name=ats")\n`); continue; }
      const name = spec.slice(0, eq).trim();
      const ats = spec.slice(eq + 1).trim().toLowerCase();
      if (!validIds.has(ats)) { process.stderr.write(`reject: unknown ATS "${ats}" (known: ${[...validIds].sort().join(', ')})\n`); continue; }
      const r = rejectHit(led, name, ats);
      process.stderr.write(`reject: ${r.name} — ${ats} filed as false positive${r.clearedHit ? ' (cleared its hit)' : ''}. Other ATSes stay open.\n`);
      n++;
    }
    if (n) writeLedger(led);
    process.stderr.write(`reject: ${n} recorded.\n`);
    return;
  }
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

  const { results, passes, waveLog, disabled, staleCanaries } = await runWaves(pending, tracked, probeProviders, led);

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
  const fmtHit = (h) => `  [${h.confidence.toUpperCase().padEnd(6)}] ${h.name.padEnd(28)} ${h.ats.padEnd(15)} ${h.where}  (${h.count} jobs${h.loc ? ', e.g. ' + h.loc : ''})${h.namesakeFlag ? `  ⚑ ${h.namesakeFlag}` : ''}`;
  const reasonAgg = [...uncertainReasons].sort((a, b) => b[1] - a[1]);
  if (JSON_OUT) {
    console.log(JSON.stringify({
      hits, trustedHits, reviewHits, uncertain,
      throttled: Object.fromEntries(throttleHosts),
      retryAfter: Object.fromEntries(retryAfterHosts),
      disabledProviders: [...disabled],
      staleCanaries: Object.fromEntries(staleCanaries),
      uncertainReasons: Object.fromEntries(reasonAgg),
      skippedCount: skipped.length, ledgerSkipped, cleanMisses, total: names.length,
      passes, waves: waveLog, scanVersion: SCAN_VERSION,
    }, null, 2));
  } else {
    const lines = [];
    lines.push(`\n=== NEW HITS (${trustedHits.length}) — trusted, not already in studios.yml ===`);
    for (const h of trustedHits) lines.push(fmtHit(h));
    if (reviewHits.length) {
      lines.push(`\n⚠️  NEEDS REVIEW (${reviewHits.length}) — generic-slug matches, NAMESAKE RISK. A different company may own this slug; confirm before adding to studios.yml (these stay open and re-surface here until resolved):`);
      for (const h of reviewHits) lines.push(fmtHit(h));
    }
    lines.push(`\nSkipped ${skipped.length} already-tracked · ${ledgerSkipped} ledger-cleared (scan v${SCAN_VERSION}) · ${cleanMisses} confirmed no-feed (404/empty) · ${passes} wave(s).`);
    if (uncertain.length) {
      lines.push(`\n⚠️  UNCERTAIN (${uncertain.length}) — could NOT confirm or deny after ${passes} adaptive wave(s) (throttle / 5xx / network / disabled ATS). "No feed" is NOT proven here.`);
      lines.push(`   Re-probe just these ATSes slower:  node probe-studios.mjs --backlog --ats <id> --concurrency 2`);
      for (const u of uncertain.slice(0, 40)) lines.push(`     ? ${u.name.padEnd(30)} (${u.uncertain.join(', ')})`);
      if (uncertain.length > 40) lines.push(`     … and ${uncertain.length - 40} more`);
    }
    if (reasonAgg.length) {
      lines.push(`\n   Uncertainty by ATS:reason: ${reasonAgg.map(([r, n]) => `${r}=${n}`).join(', ')}`);
    }
    if (disabled.size) {
      lines.push(`\n⏭️  ATSes auto-disabled this run (throttling/blocking us): ${[...disabled].join(', ')}. Their cells were left OPEN — re-run later (no flag needed) and they'll be retried.`);
    }
    if (staleCanaries.size) {
      lines.push(`   ⚠️  Stale canaries (refresh the slug in providers/<id>.mjs): ${[...staleCanaries].map(([id, why]) => `${id} (${why})`).join(', ')}`);
    }
    if (throttleHosts.size) {
      lines.push(`   Throttle (403/429) by host: ${[...throttleHosts].map(([h, n]) => `${h}=${n}${retryAfterHosts.has(h) ? ` ~${retryAfterHosts.get(h)}s` : ''}`).join(', ')}`);
    }
    lines.push('\nHIGH = own-domain match (trust). MEDIUM = name-specific slug. VERIFY = generic slug (namesake risk — check the location).');

    const output = lines.join('\n');

    // Append to file if requested, or print to console
    if (resultsAppendFile) {
      const timestamp = new Date().toISOString();
      const separator = `\n${'='.repeat(80)}\n[${timestamp}]\n`;
      const existing = existsSync(resultsAppendFile) ? readFileSync(resultsAppendFile, 'utf-8') : '';
      writeFileSync(resultsAppendFile, existing + separator + output);
      console.log(`✅ Results appended to ${resultsAppendFile}`);
    } else {
      console.log(output);
    }
  }
}

const isMain = process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url;
if (isMain) await main();

// Exported for unit tests (importing this module does NOT run the probe).
export { classifyStatus as _classifyStatus, classifyError as _classifyError, runEndpoint, probe, checkCanaries, tierFor, nameSlugs, norm, SCAN_VERSION, withHostLimit as _withHostLimit, inferCountry, locContradicts };
// loadLedger / ledgerOpen / mergeLedger are exported at their definitions above.
