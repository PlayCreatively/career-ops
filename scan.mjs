#!/usr/bin/env node

/**
 * scan.mjs — Zero-token portal scanner with a plugin-based provider layer.
 *
 * Providers live in providers/*.mjs and are loaded at startup. Each provider
 * exports a default object with:
 *   - id: string — matched against `provider:` in portals.yml
 *   - detect(entry): {url}|null — optional auto-detection from careers_url
 *   - fetch(entry, ctx): [{title,url,company,location}] — required
 *
 * Files prefixed with _ are shared helpers (e.g. _http.mjs) and are never
 * loaded as providers. Adding a new HTTP/API source = drop a *.mjs into
 * providers/. Local executable parsers use `providers/local-parser.mjs` when
 * `parser.command` + `parser.script` are set in portals.yml.
 *
 * A tracked_companies entry can set `provider:` explicitly to bypass
 * URL-based auto-detection. The `transport:` field is reserved for future
 * transports — Phase A only ships the http transport.
 *
 * Zero Claude API tokens — pure HTTP + JSON.
 *
 * Usage:
 *   node scan.mjs                  # scan all enabled companies
 *   node scan.mjs --dry-run        # preview without writing files
 *   node scan.mjs --company Cohere # scan a single company
 *   node scan.mjs --verify         # Playwright-check each new URL; drop expired postings
 *   node scan.mjs --reset          # clear pending pool + dedup history, then scan fresh
 *   node scan.mjs --no-filter      # bypass all targeting; store every role/location (board snapshot)
 *   node scan.mjs --no-extra-fetch # skip PAID per-job detail fetches (keep only free inline detail)
 *   node scan.mjs --recheck        # curl-recheck the snapshot's aged tail; drop confirmed-expired (weekly)
 */

import { readFileSync, writeFileSync, appendFileSync, existsSync, mkdirSync, readdirSync } from 'fs';
import { pathToFileURL, fileURLToPath } from 'url';
import path from 'path';
import yaml from 'js-yaml';

import { makeHttpCtx, classifyFetchError } from './providers/_http.mjs';
import { mergeHealth } from './merge-health.mjs';
import { splitLocationMode, DETAIL } from './providers/_util.mjs';
import { classifyLiveness } from './liveness-core.mjs';
import { scoreCategory, matchGroup, isExcluded, buildFilterIndex } from './rank.mjs';

const parseYaml = yaml.load;

// ── Config ──────────────────────────────────────────────────────────

// Config is split across two files:
//   studios.yml  — the company list (tracked in git, shared with collaborators)
//   portals.yml  — your targeting/filters (gitignored, personal, NOT shared)
// scan reads companies from studios.yml and filters from portals.yml. A fresh
// clone that has studios.yml but no personal portals.yml falls back to the
// example targeting so it still scans. (For back-compat, if studios.yml is
// absent, companies are read from portals.yml's tracked_companies.)
const PORTALS_PATH = process.env.CAREER_OPS_PORTALS || 'portals.yml';
const STUDIOS_PATH = process.env.CAREER_OPS_STUDIOS || 'studios.yml';
const PORTALS_EXAMPLE_PATH = 'templates/portals.example.yml';
const SCAN_HISTORY_PATH = 'data/scan-history.tsv';
const PIPELINE_PATH = 'data/pipeline.md';
const APPLICATIONS_PATH = 'data/applications.md';
const PROVIDERS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'providers');
const ENRICHERS_DIR = path.join(PROVIDERS_DIR, 'enrichers');

// Ensure required directories exist (fresh setup)
mkdirSync('data', { recursive: true });

const CONCURRENCY = 10;
// Phase-2 detail defaults. A provider's detail pass fetches one posting per job
// to feed enrichers; cap how many per entry so a huge aggregator board can't
// storm a source, and how many run in parallel (throttle-prone sources drop it
// lower via detailConcurrency / a per-entry enrich_concurrency).
const DEFAULT_ENRICH_CAP = 500;
const DEFAULT_ENRICH_CONCURRENCY = 4;

// ── Provider loading ────────────────────────────────────────────────

async function loadProviders(dir) {
  const providers = new Map();
  if (!existsSync(dir)) return providers;
  // Alphabetical order so detect() priority is deterministic across machines.
  const entries = readdirSync(dir)
    .filter(f => f.endsWith('.mjs') && !f.startsWith('_'))
    .sort();
  for (const file of entries) {
    const full = path.join(dir, file);
    let mod;
    try {
      mod = await import(pathToFileURL(full).href);
    } catch (err) {
      console.error(`⚠️  ${file}: failed to load — ${err.message}`);
      continue;
    }
    const p = mod.default;
    if (!p || typeof p.fetch !== 'function' || !p.id) {
      console.error(`⚠️  ${file}: skipping — default export must be { id, fetch }`);
      continue;
    }
    if (providers.has(p.id)) {
      console.error(`⚠️  ${file}: duplicate provider id "${p.id}" — keeping first`);
      continue;
    }
    providers.set(p.id, p);
  }
  return providers;
}

// ── Enricher loading ────────────────────────────────────────────────
//
// Detail-phase enrichers live in providers/enrichers/*.mjs, each default-exporting
// { id, needs?, enrich }. They're cross-cutting (ATS-agnostic) — adding a new
// signal is one drop-in file, no fetch/provider edits. Loaded like providers so
// the registry stays convention-driven.
async function loadEnrichers(dir) {
  const enrichers = [];
  if (!existsSync(dir)) return enrichers;
  const files = readdirSync(dir).filter(f => f.endsWith('.mjs') && !f.startsWith('_')).sort();
  const seen = new Set();
  for (const file of files) {
    let mod;
    try {
      mod = await import(pathToFileURL(path.join(dir, file)).href);
    } catch (err) {
      console.error(`⚠️  enrichers/${file}: failed to load — ${err.message}`);
      continue;
    }
    const e = mod.default;
    if (!e || typeof e.enrich !== 'function' || !e.id) {
      console.error(`⚠️  enrichers/${file}: skipping — default export must be { id, enrich }`);
      continue;
    }
    if (seen.has(e.id)) {
      console.error(`⚠️  enrichers/${file}: duplicate enricher id "${e.id}" — keeping first`);
      continue;
    }
    seen.add(e.id);
    enrichers.push(e);
  }
  return enrichers;
}

// Apply ONE job's detail payload in place: merge the provider-authoritative CORE
// overlay (aggregators fill company/location/… the list page couldn't expose;
// only non-empty values overwrite), then run every cross-cutting enricher over
// the named detail fields (e.g. 'text'). An enricher must never break a scan, so
// each is guarded independently.
function applyDetail(job, detail, enrichers) {
  if (!detail || typeof detail !== 'object') return;
  if (detail.overlay && typeof detail.overlay === 'object') {
    for (const [k, v] of Object.entries(detail.overlay)) {
      if (v != null && v !== '') job[k] = v;
    }
  }
  for (const en of enrichers) {
    if (en.needs && (detail[en.needs] == null || detail[en.needs] === '')) continue;
    try {
      const patch = en.enrich(detail, job);
      if (patch && typeof patch === 'object') Object.assign(job, patch);
    } catch { /* skip this enricher for this job */ }
  }
}

// Detail/enrich pass for ONE entry's jobs. Each job's DetailPayload comes from
// EITHER source (see providers/_types.js DetailPayload):
//   - FREE tier: the provider hung it off `job[DETAIL]` during fetch() because
//     the list response already carried the description (greenhouse ?content=true,
//     lever, ashby, recruitee, teamtailor, personio XML). Costs no request, so
//     it's processed on EVERY scan regardless of the flag.
//   - PAID tier: provider.fetchDetail(job) — a real per-job request — run only
//     when --extra-fetch is on (the default; --no-extra-fetch disables it) and
//     the provider exposes fetchDetail (the aggregator boards, rippling).
// Per-job failure-isolated: a throttled/errored PAID detail keeps the job's
// Phase-1 fields and is simply not enriched — a posting is NEVER dropped for a
// detail miss. `enrich: false` on the entry opts out of BOTH tiers. Mutates jobs
// in place; returns { jobs, failures } (jobs may be re-shaped by postFetch, e.g.
// gamedevjobs' office merge). A provider is one tier or the other, never both.
export async function enrichJobs(jobs, provider, entry, ctx, enrichers, { extraFetch }) {
  if (jobs.length === 0 || entry.enrich === false) return { jobs, failures: 0 };

  // FREE tier — consume any inline detail the provider attached during fetch.
  for (const job of jobs) {
    const inline = job[DETAIL];
    if (inline) {
      applyDetail(job, inline, enrichers);
      delete job[DETAIL]; // never let it reach the JSON snapshot (symbol, but tidy)
    }
  }

  // PAID tier — a real per-job fetch, only when enabled and supported.
  let failures = 0;
  if (extraFetch && typeof provider.fetchDetail === 'function') {
    const cap = Number.isInteger(entry.max_enrich) && entry.max_enrich >= 0
      ? entry.max_enrich : DEFAULT_ENRICH_CAP;
    const targets = jobs.slice(0, cap); // references into jobs — mutated in place
    const concurrency = Number.isInteger(entry.enrich_concurrency) && entry.enrich_concurrency > 0
      ? entry.enrich_concurrency
      : Number.isInteger(provider.detailConcurrency) && provider.detailConcurrency > 0
        ? provider.detailConcurrency
        : DEFAULT_ENRICH_CONCURRENCY;

    let next = 0;
    const worker = async () => {
      while (next < targets.length) {
        const job = targets[next++];
        let detail;
        try {
          detail = await provider.fetchDetail(job, ctx);
        } catch { failures++; continue; } // keep the job; lose only its detail
        applyDetail(job, detail, enrichers);
      }
    };
    await Promise.all(Array.from({ length: Math.min(concurrency, targets.length) }, worker));
  }

  const out = typeof provider.postFetch === 'function' ? provider.postFetch(jobs, entry) : jobs;
  return { jobs: Array.isArray(out) ? out : jobs, failures };
}

// Resolve which provider handles a tracked_companies entry.
// 1. Explicit `provider:` field wins (skips detect()).
// 2. local-parser when parser.command + script are configured (before API detect).
// 3. Otherwise each provider's detect() runs in load order; first hit wins.
function resolveProvider(entry, providers, { skipIds = [] } = {}) {
  if (entry.provider) {
    const p = providers.get(entry.provider);
    if (!p) return { error: `unknown provider: ${entry.provider}` };
    return { provider: p };
  }

  const localParser = providers.get('local-parser');
  if (localParser && !skipIds.includes('local-parser')) {
    try {
      const hit = localParser.detect?.(entry);
      if (hit) return { provider: localParser };
    } catch (err) {
      console.error(`⚠️  local-parser: detect() threw for "${entry.name}" — ${err.message}`);
    }
  }

  for (const p of providers.values()) {
    if (skipIds.includes(p.id)) continue;
    let hit;
    try {
      hit = p.detect?.(entry);
    } catch (err) {
      console.error(`⚠️  ${p.id}: detect() threw for "${entry.name}" — ${err.message}`);
      continue;
    }
    if (hit) return { provider: p };
  }
  return null;
}

// ── Title filter ────────────────────────────────────────────────────

function buildTitleFilter(titleFilter) {
  const positive = (titleFilter?.positive || []).map(k => k.toLowerCase());
  const negative = (titleFilter?.negative || []).map(k => k.toLowerCase());

  return (title) => {
    const lower = title.toLowerCase();
    const hasPositive = positive.length === 0 || positive.some(k => lower.includes(k));
    const hasNegative = negative.some(k => lower.includes(k));
    return hasPositive && !hasNegative;
  };
}

// ── Unified targeting filter ────────────────────────────────────────
// The `targeting:` block (location/role/seniority weight maps) drives BOTH the
// scan gate and the rank order. A job is dropped if its role OR location
// dimension scores 0 — using the SAME scoring engine as rank.mjs (word-stem /
// regex matching + `combine`), so a single 0-weight ("excluded") keyword zeroes
// that dimension (combine: min). role.default: 0 makes role an allowlist;
// location.default > 0 keeps unknown locations (fail-safe, block-only).
// Seniority intentionally never gates (its default > 0 and it has no 0s).
//
// Returns the same { title, location } predicate pair as the legacy builders so
// the scan loop is unchanged. The dimension is "passed" when it has no keyword
// map at all (so an absent dimension never silently drops everything).
export function buildTargetingFilter(targeting) {
  const combine = targeting?.combine || 'min';
  const roleMap = targeting?.role;
  const locMap = targeting?.location;
  const companyMap = targeting?.company;
  return {
    title: (title) =>
      !roleMap || scoreCategory(title, roleMap, combine).score > 0,
    location: (location) =>
      !locMap || scoreCategory(location, locMap, combine).score > 0,
    // Gate on the job's company name — chiefly to exclude single studios from
    // aggregator feeds (Hitmarker / Work With Indies). default: 1 keeps unknown
    // companies (fail-safe); set a studio to 0 to block it.
    company: (company) =>
      !companyMap || scoreCategory(company, companyMap, combine).score > 0,
  };
}

// Source-level employer blocklist for aggregator leakage. Returns a predicate
// `(company) => true` when that company is blocked. Exact, case-insensitive name
// match (no stemming — a slot/casino "Aristocrat" must not also nuke a studio
// whose name merely starts the same). Fail-safe: an empty/invalid/absent list
// blocks nothing, and a job with no company name is never blocked. The caller
// gates this to aggregator hosts so it can't touch a curated single-studio feed.
export function buildCompanyBlocklist(excludeCompanies) {
  const blocked = new Set(
    (Array.isArray(excludeCompanies) ? excludeCompanies : [])
      .filter((s) => typeof s === 'string')
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean),
  );
  return (company) => {
    if (blocked.size === 0) return false;
    const key = (company || '').trim().toLowerCase();
    return key !== '' && blocked.has(key);
  };
}

// ── Group-model targeting filter ────────────────────────────────────
// The unified `targeting.groups` schema (same one the board uses) gates the scan
// by EXCLUDES: a job is dropped iff it matches an active filter weighted exactly
// 0 (via rank.mjs `isExcluded`). combine/`else` shape the rank order, not the
// gate, so the drop decision is independent of a group's combine mode.
//
// Returns which dimension caused the drop ('title'|'location'|'company') for the
// scan summary, or null to keep. The dimension is taken from the offending
// group's `field` so the per-field counters stay meaningful ('any' → title).
export function groupDropReason(job, groups) {
  if (!isExcluded(job, groups)) return null;
  // Share one index across the loop so `unless` references resolve the same way
  // isExcluded saw them (a guard-voided exclusion must not be re-detected here).
  const index = buildFilterIndex(groups);
  for (const g of groups) {
    if (matchGroup(job, g, index).some((f) => f.weight === 0)) {
      // `field` may be an array (multi-source group) — map it to one counter
      // bucket, preferring location > company > title.
      const fields = Array.isArray(g.field) ? g.field : [g.field];
      if (fields.includes('location')) return 'location';
      if (fields.includes('company')) return 'company';
      return 'title';
    }
  }
  return 'title';
}

// ── Location filter ─────────────────────────────────────────────────
// Optional. If `location_filter` is absent from portals.yml, all locations pass.
// Semantics (case-insensitive substring, in this order):
//   - Empty / whitespace-only / non-string location → pass (don't penalize
//     missing or malformed provider data)
//   - `always_allow` matches → pass (takes precedence over `block` — lets a
//     multi-location string like "Remote, Belgium or France" through because
//     the home region is an option, even though "france" is blocked)
//   - `block` matches → reject
//   - `allow` empty → pass (already cleared block)
//   - `allow` non-empty → must match at least one keyword

// Normalize a keyword list from portals.yml: tolerates a bare string
// (wrapped to a 1-item array), null/undefined (→ []), and non-string
// entries (filtered out). Survivors are lowercased, trimmed, and any
// resulting empty strings are dropped — an empty keyword would otherwise
// match every location via String.includes(''), silently bypassing the
// other tiers.
function normalizeKeywordList(value) {
  if (value == null) return [];
  const arr = Array.isArray(value) ? value : [value];
  return arr
    .filter(k => typeof k === 'string')
    .map(k => k.toLowerCase().trim())
    .filter(Boolean);
}

export function buildLocationFilter(locationFilter) {
  if (!locationFilter) return () => true;
  const alwaysAllow = normalizeKeywordList(locationFilter.always_allow);
  const allow = normalizeKeywordList(locationFilter.allow);
  const block = normalizeKeywordList(locationFilter.block);

  return (location) => {
    if (typeof location !== 'string' || location.trim() === '') return true;
    const lower = location.toLowerCase();
    if (alwaysAllow.length > 0 && alwaysAllow.some(k => lower.includes(k))) return true;
    if (block.length > 0 && block.some(k => lower.includes(k))) return false;
    if (allow.length === 0) return true;
    return allow.some(k => lower.includes(k));
  };
}

// Extract the ATS requisition ID from a posting URL — the identifier that stays
// stable when the same posting is mirrored across hosts (a studio's own domain +
// its ATS subdomain, or a label studio listed under its parent group). Returns
// `null` when no reliable numeric ID is present. Greenhouse exposes it as the
// `gh_jid` query param (survives on branded domains like riotgames.com); most
// path-based ATSs (Greenhouse, Teamtailor, Recruitee) lead the final `/jobs/<id>`
// segment with it.
export function postingId(url) {
  let u;
  try { u = new URL(url); } catch { return null; }
  const gh = u.searchParams.get('gh_jid');
  if (gh && /^\d{5,}$/.test(gh)) return gh;
  const segs = u.pathname.split('/').filter(Boolean);
  const last = segs[segs.length - 1] || '';
  const m = last.match(/^(\d{5,})/);
  return m ? m[1] : null;
}

// Aggregator boards: one tracked entry surfaces jobs across MANY studios (vs a
// per-company ATS feed). Two consequences, both keyed off this list: a direct
// first-party posting wins over an aggregator mirror in the snapshot dedup, and
// the employer blocklist / company-resolution steps are gated to these hosts so
// they can't touch a curated single-studio feed.
export const DEFAULT_AGGREGATORS = [
  'hitmarker.net', 'workwithindies.com', 'remotegamejobs.com',
  'gamesjobsdirect.com', 'ingamejob.com', 'gamejobs.co', 'gamedevjobs.com',
];

// Last-resort aggregators — a strict sub-tier of the above. These route the actual
// application behind a login wall / expose NO usable direct link to the source
// posting, so a duplicate from ANY other source (a direct ATS *or* a normal
// aggregator that does link out) wins over them. GameDevJobs.com gates /jobs/*/apply
// behind /login and its JSON-LD carries only the careers ROOT, never the posting;
// GameJobs.co, by contrast, embeds the real source URL (e.g. boards.greenhouse.io/…)
// so it stays a normal aggregator.
export const DEFAULT_LAST_RESORT = ['gamedevjobs.com'];

// Collapse duplicate postings in the board snapshot. The same role is sometimes
// discovered through two sources, producing two rows with different URLs. Two
// independent, conservative passes — neither ever merges two genuinely distinct
// direct postings:
//
//   1. Posting ID (high confidence). Rows with the SAME company AND the SAME ATS
//      requisition ID are the same posting even if their location strings differ
//      slightly; keep one. Scoping by company makes a cross-ATS ID collision
//      effectively impossible. Aggregators are excluded here — they reassign
//      their own IDs, so an aggregator ID would never legitimately match a real
//      req ID.
//   2. Title/company heuristic, AGGREGATOR-GATED, two tiers. Rows are grouped by
//      company + a punctuation-folded title (NOT location — aggregators serve the
//      same posting with an empty or reformatted location, so a raw-location key
//      would never group a mirror with its direct twin). Location is used instead
//      as a primary-city compatibility guard inside each group. Within a group:
//        a. if a direct (non-aggregator) row exists, each aggregator mirror
//           (Hitmarker / WorkWithIndies / GameJobs.co / GameDevJobs / …) whose
//           primary city is compatible with a direct row is dropped;
//        b. otherwise, among aggregator-only rows a LAST-RESORT one (GameDevJobs —
//           login wall, no direct link) is dropped when a location-compatible
//           normal aggregator (which links out to the source) covers the same role.
//      Direct rows are never merged with each other, so an Epic-style pair of
//      distinct same-title reqs is always preserved; an aggregator row in a
//      genuinely different city, and all-normal-aggregator / all-last-resort
//      groups, are left untouched.
//
// The aggregator + last-resort host lists are configurable (portals.yml →
// snapshot_dedup.aggregators / .last_resort).
export function dedupeSnapshot(jobs, { aggregators = DEFAULT_AGGREGATORS, lastResort = DEFAULT_LAST_RESORT } = {}) {
  const aggs = aggregators.map(a => String(a).toLowerCase());
  // Last-resort hosts are always treated as aggregators too (so a direct posting
  // still wins over them), even if the caller left them out of `aggregators`.
  const lasts = lastResort.map(a => String(a).toLowerCase());
  const hostOf = (u) => {
    try { return new URL(u).hostname.replace(/^www\./, '').toLowerCase(); }
    catch { return ''; }
  };
  const matchHost = (list, h) => list.some(a => h === a || h.endsWith('.' + a));
  const isAgg = (u) => { const h = hostOf(u); return matchHost(aggs, h) || matchHost(lasts, h); };
  const isLastResort = (u) => matchHost(lasts, hostOf(u));
  const norm = (s) => (s || '').toLowerCase();

  // ── Pass 1: company + posting ID. Aggregators get no ID (null) so they never
  //    participate here and fall through to the gated heuristic below. ────────
  const idCount = new Map();
  const idKey = (j) => {
    if (isAgg(j.url)) return null;
    const id = postingId(j.url);
    return id == null ? null : `${norm(j.company)}::${id}`;
  };
  for (const j of jobs) {
    const k = idKey(j);
    if (k) idCount.set(k, (idCount.get(k) || 0) + 1);
  }
  let collapsedById = 0;
  const idSeen = new Set();
  const stage1 = [];
  for (const j of jobs) {
    const k = idKey(j);
    if (k && idCount.get(k) > 1) {
      if (idSeen.has(k)) { collapsedById++; continue; } // keep first, drop later mirrors
      idSeen.add(k);
    }
    stage1.push(j);
  }

  // ── Pass 2: title/company + primary-city, aggregator-gated. ───────────────
  // The group key is company + a PUNCTUATION-STRIPPED title, deliberately NOT the
  // location: aggregators routinely serve an empty or reformatted location for the
  // same posting (GameJobs.co gives none; GameDevJobs expands "København, DK" to
  // "København, Capital Region of Denmark, DK"), so keying on the raw location
  // string would split real mirrors into separate groups and collapse nothing.
  // normTitle folds "(Core Tech)" / "iOS/Cross-Platform" punctuation so a mirror's
  // reformatted title still matches the direct one.
  const normTitle = (s) => (s || '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
  // Location is instead used as a COMPATIBILITY guard when deciding whether a
  // specific row is a mirror. We compare only the primary city (first comma
  // segment) so "København, DK" ~ "København, Capital Region of Denmark, DK", and
  // treat an empty location on EITHER side as a wildcard. Fail-safe by design: if
  // the primary cities genuinely differ (Aarhus vs København) the rows are kept
  // apart — we never silently drop a distinct-location posting.
  const primaryLoc = (s) => (s || '').toLowerCase().split(',')[0].replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
  const locCompatible = (a, b) => {
    const pa = primaryLoc(a), pb = primaryLoc(b);
    return !pa || !pb || pa === pb;
  };
  const keyOf = (j) => `${norm(j.company)}::${normTitle(j.title)}`;
  const groups = new Map();
  const order = [];
  for (const j of stage1) {
    const k = keyOf(j);
    if (!groups.has(k)) { groups.set(k, []); order.push(k); }
    groups.get(k).push(j);
  }
  const result = [];
  let collapsedByHeuristic = 0;
  for (const k of order) {
    const arr = groups.get(k);
    const directs = arr.filter(j => !isAgg(j.url));
    const keep = new Set(arr);
    if (directs.length) {
      // Tier 1: a direct (first-party) posting exists → drop each aggregator mirror
      // whose primary city is compatible with SOME direct. Directs are never merged
      // with each other (Epic guard); an aggregator row in a genuinely different
      // city is kept (it's a distinct posting, not a mirror).
      for (const j of arr) {
        if (!isAgg(j.url)) continue;
        if (directs.some(d => locCompatible(d.location, j.location))) {
          keep.delete(j);
          collapsedByHeuristic++;
        }
      }
    } else {
      // No direct posting. Tier 2: among aggregator-only rows, a normal aggregator
      // (which links out to the source) beats a last-resort one (login wall / no
      // direct link) → drop each last-resort mirror covered by a location-compatible
      // normal aggregator. All-normal or all-last-resort groups are left untouched.
      const normalAggs = arr.filter(j => !isLastResort(j.url));
      if (normalAggs.length) {
        for (const j of arr) {
          if (!isLastResort(j.url)) continue;
          if (normalAggs.some(n => locCompatible(n.location, j.location))) {
            keep.delete(j);
            collapsedByHeuristic++;
          }
        }
      }
    }
    result.push(...arr.filter(j => keep.has(j)));
  }
  return {
    jobs: result,
    collapsed: collapsedById + collapsedByHeuristic,
    collapsedById,
    collapsedByHeuristic,
  };
}

// ── Dedup ───────────────────────────────────────────────────────────

function loadSeenUrls() {
  const seen = new Set();

  // scan-history.tsv
  if (existsSync(SCAN_HISTORY_PATH)) {
    const lines = readFileSync(SCAN_HISTORY_PATH, 'utf-8').split('\n');
    for (const line of lines.slice(1)) { // skip header
      const cols = line.split('\t');
      const url = cols[0];
      if (!url) continue;
      // A URL recorded as expired is NOT a permanent tombstone. If the same URL
      // later goes live again (a reopened req reusing its slug), blocking it here
      // would silently drop a real posting — the exact failure we forbid for new
      // offers. So skip `skipped_expired` rows: the URL becomes eligible to
      // resurface, and if it's still dead the recheck just re-expires it (one
      // cheap GET). status lives in column 5 (see appendToScanHistory).
      if (cols[5] === 'skipped_expired') continue;
      seen.add(url);
    }
  }

  // pipeline.md — extract URLs from checkbox lines
  if (existsSync(PIPELINE_PATH)) {
    const text = readFileSync(PIPELINE_PATH, 'utf-8');
    for (const match of text.matchAll(/- \[[ x]\] (https?:\/\/\S+)/g)) {
      seen.add(match[1]);
    }
  }

  // applications.md — extract URLs from report links and any inline URLs
  if (existsSync(APPLICATIONS_PATH)) {
    const text = readFileSync(APPLICATIONS_PATH, 'utf-8');
    for (const match of text.matchAll(/https?:\/\/[^\s|)]+/g)) {
      seen.add(match[0]);
    }
  }

  return seen;
}

function loadSeenCompanyRoles() {
  const seen = new Set();
  if (existsSync(APPLICATIONS_PATH)) {
    const text = readFileSync(APPLICATIONS_PATH, 'utf-8');
    // Parse markdown table rows: | # | Date | Company | Role | ...
    for (const match of text.matchAll(/\|[^|]+\|[^|]+\|\s*([^|]+)\s*\|\s*([^|]+)\s*\|/g)) {
      const company = match[1].trim().toLowerCase();
      const role = match[2].trim().toLowerCase();
      if (company && role && company !== 'company') {
        seen.add(`${company}::${role}`);
      }
    }
  }
  return seen;
}

// ── Reset ───────────────────────────────────────────────────────────

// Clears state for a fresh rescan: drops pending (unchecked) entries from
// pipeline.md and wipes scan-history.tsv back to its header. Processed (`- [x]`)
// lines are kept so already-evaluated jobs stay deduped and aren't re-added.
function resetScanState() {
  if (existsSync(PIPELINE_PATH)) {
    const cleaned = readFileSync(PIPELINE_PATH, 'utf-8')
      .split('\n')
      .filter(line => !/^\s*- \[ \] https?:\/\//.test(line))
      .join('\n');
    writeFileSync(PIPELINE_PATH, cleaned, 'utf-8');
  }
  writeFileSync(SCAN_HISTORY_PATH, 'url\tfirst_seen\tportal\ttitle\tcompany\tstatus\tlocation\n', 'utf-8');
  console.log('🧹 Reset: cleared pending pipeline entries + scan history');
}

// ── Pipeline writer ─────────────────────────────────────────────────

function appendToPipeline(offers, { note = '' } = {}) {
  if (offers.length === 0) return;
  // Optional trailing flag appended to each checkbox line (e.g. an "unverified"
  // marker). Kept AFTER the title so loadSeenUrls' URL regex is unaffected.
  const suffix = note ? `  ${note}` : '';

  // Create the pipeline file on first use so a fresh clone (where data/ is
  // gitignored and pipeline.md doesn't exist yet) doesn't crash with ENOENT.
  if (!existsSync(PIPELINE_PATH)) {
    writeFileSync(PIPELINE_PATH, '# Pipeline\n\n## Pendientes\n\n## Procesadas\n', 'utf-8');
  }

  let text = readFileSync(PIPELINE_PATH, 'utf-8');

  // Find "## Pendientes" section and append after it
  const marker = '## Pendientes';
  const idx = text.indexOf(marker);
  if (idx === -1) {
    // No Pendientes section — append at end before Procesadas
    const procIdx = text.indexOf('## Procesadas');
    const insertAt = procIdx === -1 ? text.length : procIdx;
    const block = `\n${marker}\n\n` + offers.map(o =>
      `- [ ] ${o.url} | ${o.company} | ${o.title}${suffix}`
    ).join('\n') + '\n\n';
    text = text.slice(0, insertAt) + block + text.slice(insertAt);
  } else {
    // Find the end of existing Pendientes content (next ## or end)
    const afterMarker = idx + marker.length;
    const nextSection = text.indexOf('\n## ', afterMarker);
    const insertAt = nextSection === -1 ? text.length : nextSection;

    const block = '\n' + offers.map(o =>
      `- [ ] ${o.url} | ${o.company} | ${o.title}${suffix}`
    ).join('\n') + '\n';
    text = text.slice(0, insertAt) + block + text.slice(insertAt);
  }

  writeFileSync(PIPELINE_PATH, text, 'utf-8');
}

function appendToScanHistory(offers, date, status = 'added') {
  // Ensure file + header exist. Location appended as 7th column for non-breaking
  // backward compat — older scan-history.tsv files with 6 columns still parse fine
  // since loadSeenUrls only reads column 0. `status` is parameterized so callers
  // can record verify outcomes (`skipped_expired`, etc.) without the legacy
  // `(expired)` suffix in `source`.
  if (!existsSync(SCAN_HISTORY_PATH)) {
    writeFileSync(SCAN_HISTORY_PATH, 'url\tfirst_seen\tportal\ttitle\tcompany\tstatus\tlocation\n', 'utf-8');
  }

  const lines = offers.map(o =>
    `${o.url}\t${date}\t${o.source}\t${o.title}\t${o.company}\t${status}\t${o.location || ''}`
  ).join('\n') + '\n';

  appendFileSync(SCAN_HISTORY_PATH, lines, 'utf-8');
}

// ── Parallel fetch with concurrency limit ───────────────────────────

async function parallelFetch(tasks, limit) {
  const results = [];
  let i = 0;

  async function next() {
    while (i < tasks.length) {
      const task = tasks[i++];
      results.push(await task());
    }
  }

  const workers = Array.from({ length: Math.min(limit, tasks.length) }, () => next());
  await Promise.all(workers);
  return results;
}

// ── Main ────────────────────────────────────────────────────────────

async function verifyOffers(offers) {
  // Dynamic imports keep the default zero-token path free of Playwright startup
  let chromium;
  let checkUrlLiveness;
  try {
    ({ chromium } = await import('playwright'));
    ({ checkUrlLiveness } = await import('./liveness-browser.mjs'));
  } catch (err) {
    throw new Error(
      `--verify requires Playwright with Chromium (run "npx playwright install chromium"): ${err.message}`,
      { cause: err },
    );
  }

  let browser;
  try {
    browser = await chromium.launch({ headless: true });
  } catch (err) {
    throw new Error(
      `--verify could not launch Chromium (run "npx playwright install chromium" or re-run without --verify): ${err.message}`,
      { cause: err },
    );
  }

  // Buckets:
  //   verified  → active pages and transient nav errors (retry next scan)
  //   expired   → classifier-confirmed dead postings (HTTP 4xx, redirect markers,
  //               body patterns, listing pages, insufficient content). ONLY these
  //               are dropped — a positive dead signal.
  //   unverified→ page loaded with real content but no recognizable Apply control.
  //               NOT dropped: a live posting whose apply control we simply failed
  //               to detect must never silently vanish (new offers are the whole
  //               point of a scan). Surfaced to pipeline.md flagged instead, so the
  //               user decides rather than the classifier deleting it.
  //   invalid   → up-front URL guard rejections (malformed / non-http / private)
  const verified = [];
  const expired = [];
  const unverified = [];
  const invalid = [];

  try {
    const page = await browser.newPage();
    // Sequential — project rule: never Playwright in parallel
    for (const offer of offers) {
      const { result, code, reason } = await checkUrlLiveness(page, offer.url);
      if (result === 'expired') {
        expired.push({ ...offer, reason });
        console.log(`  ❌ expired   ${offer.company} | ${offer.title} (${reason})`);
      } else if (result === 'uncertain' && GUARD_CODES.has(code)) {
        // Guard failures are permanent (not transient like a timeout) — record them
        // separately so they don't end up in pipeline.md but DO appear in scan-history
        // with a precise status, dedup-blocking them on subsequent scans.
        invalid.push({ ...offer, code, reason });
        console.log(`  ⛔ invalid   ${offer.company} | ${offer.title} (${reason})`);
      } else if (result === 'uncertain' && code === 'no_apply_control') {
        // Page loaded with real content but no recognizable Apply control. We do
        // NOT drop it — that would silently discard a possibly-live posting. Surface
        // it to pipeline.md flagged so the user can eyeball it. It still gets a
        // scan-history row (as `added`, written by the caller with verifiedOffers)
        // so it's dedup-tracked normally on future scans.
        unverified.push({ ...offer, reason });
        console.log(`  ⚠️ unverified ${offer.company} | ${offer.title} (${reason})`);
      } else {
        // 'active' or 'uncertain' due to navigation_error (transient — retry next scan)
        verified.push(offer);
        const icon = result === 'active' ? '✅' : '⚠️';
        console.log(`  ${icon} ${result.padEnd(9)} ${offer.company} | ${offer.title}`);
      }
    }
  } finally {
    await browser.close();
  }

  return { verified, expired, unverified, invalid };
}

// ── Staleness recheck (cheap, curl-only, no Playwright) ──────────────
//
// Re-verify the AGED tail of an existing snapshot and drop only postings with a
// POSITIVE dead signal. Unlike --verify (which Playwright-renders new offers),
// this is a plain GET + classifyLiveness over the raw HTML: the "no longer
// available / position filled / applications closed" banner that kills a job is
// almost always server-rendered text (proven on apply.ioi.dk), so a browser
// isn't needed. This makes it safe to run in the browserless CI board pipeline.
//
// CONSERVATIVE BY DESIGN — the mirror of the new-offer rule: only `result:
// 'expired'` removes a job. `active`, `uncertain` (SPA whose banner needs JS, a
// timeout, a soft 200) and any fetch error all KEEP the posting. We never delete
// a live job just because a cheap GET couldn't confirm it; a truly-dead one gets
// re-checked (and removed) on the next weekly pass.

const RECHECK_DEFAULTS = { minAgeDays: 45, concurrency: 6, timeoutMs: 10_000 };

// Fetch a URL's status + raw body WITHOUT throwing on 4xx (a 404/410 is itself a
// dead signal we want to classify, not an exception to swallow). Returns null on
// a network/timeout failure so the caller keeps the posting (transient ≠ dead).
async function fetchRawForRecheck(url, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      headers: { 'user-agent': 'Mozilla/5.0 (compatible; career-ops/1.3)' },
      redirect: 'follow',
      signal: controller.signal,
    });
    const bodyText = await res.text().catch(() => '');
    return { status: res.status, finalUrl: res.url || url, bodyText };
  } catch {
    return null; // timeout / DNS / TLS — treat as "unknown", keep the job
  } finally {
    clearTimeout(timer);
  }
}

// Given the full snapshot, curl-recheck every job older than minAgeDays and
// return the subset confirmed expired (to be removed from the snapshot). Never
// throws; a per-URL failure just keeps that job.
async function recheckStaleSnapshot(jobs, opts = {}) {
  const { minAgeDays, concurrency, timeoutMs } = { ...RECHECK_DEFAULTS, ...opts };
  const cutoffMs = Date.now() - minAgeDays * 86_400_000;

  // Only the aged tail with a usable postedDate and http(s) URL is a candidate.
  const candidates = jobs.filter((j) => {
    if (!j || typeof j.url !== 'string' || !/^https?:\/\//i.test(j.url)) return false;
    const t = j.postedDate ? Date.parse(j.postedDate) : NaN;
    return Number.isFinite(t) && t < cutoffMs;
  });

  console.log(`Recheck: ${candidates.length} posting(s) older than ${minAgeDays}d (of ${jobs.length}) — curl-only, no Playwright.`);

  const expiredUrls = new Set();
  let checked = 0;
  const queue = candidates.slice();
  async function worker() {
    while (queue.length) {
      const job = queue.shift();
      const raw = await fetchRawForRecheck(job.url, timeoutMs);
      checked++;
      if (!raw) continue; // transient — keep
      const { result, reason } = classifyLiveness({
        status: raw.status,
        finalUrl: raw.finalUrl,
        bodyText: raw.bodyText,
        applyControls: [], // no JS render; rely on status/URL/body signals only
      });
      if (result === 'expired') {
        expiredUrls.add(job.url);
        console.log(`  ❌ expired   ${job.company} | ${job.title} (${reason})`);
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, candidates.length) }, worker));

  console.log(`Recheck: ${checked} checked, ${expiredUrls.size} confirmed expired (removed from snapshot).`);
  return expiredUrls;
}

// Stable codes from liveness-browser's up-front URL guard. Routing dispatches
// on these codes (not on regex over reason strings) so wording can change
// without breaking the pipeline.
const GUARD_CODES = new Set(['invalid_url', 'unsupported_protocol', 'blocked_host']);

// guardStatusFor maps a guard code to the canonical scan-history status string.
function guardStatusFor(code) {
  if (code === 'blocked_host') return 'skipped_blocked_host';
  // invalid_url and unsupported_protocol both surface as malformed input
  return 'skipped_invalid_url';
}

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const verify = args.includes('--verify');
  const reset = args.includes('--reset');
  const noFilter = args.includes('--no-filter');
  // --recheck: after building the snapshot, curl-recheck its AGED tail and drop
  // only confirmed-expired postings (positive dead signal). Cheap, browserless,
  // safe for CI. Intended for a WEEKLY staleness pass, separate from the daily
  // board refresh. Age cutoff comes from portals.yml `recheck.min_age_days`.
  const recheck = args.includes('--recheck');
  // The PAID detail pass (a real per-job fetch: the aggregator boards fill
  // company/location from each posting page, rippling reads sponsorship) is ON by
  // default. --no-extra-fetch turns it off — the scan then relies only on the
  // FREE inline detail that list-carrying ATSes attach at no request cost (so
  // greenhouse/lever/ashby/… still surface sponsorship, the aggregators fall back
  // to their slug-derived basics). Use it to keep a run minimal or dodge a
  // throttling source.
  const extraFetch = !args.includes('--no-extra-fetch');
  const jsonIdx = args.indexOf('--json');
  const jsonPath = jsonIdx !== -1 ? args[jsonIdx + 1] : null;
  const companyFlag = args.indexOf('--company');
  const filterCompany = companyFlag !== -1 ? args[companyFlag + 1]?.toLowerCase() : null;
  // By default the scan exits non-zero when a whole provider goes dark to
  // throttling/blocking, so a CI gate refuses to publish a snapshot that's
  // silently missing a source. --no-fail-on-degraded keeps the warning but
  // forces a clean exit (e.g. local runs where you don't care).
  const failOnDegraded = !args.includes('--no-fail-on-degraded');
  // Per-company failure tally (departed-ATS detection). --health-in seeds the
  // previous state (the last published health.json, fetched from the live site
  // by CI); --health-out writes the updated state into the snapshot dir so it
  // redeploys with the board. A company is flagged after N consecutive failed
  // scans (default 10) and the board shows an alert. Local runs omit these flags
  // so residential throttling never pollutes the tally — see merge-health.mjs.
  const healthInIdx = args.indexOf('--health-in');
  const healthIn = healthInIdx !== -1 ? args[healthInIdx + 1] : null;
  const healthOutIdx = args.indexOf('--health-out');
  const healthOut = healthOutIdx !== -1 ? args[healthOutIdx + 1] : null;
  const healthThreshIdx = args.indexOf('--health-threshold');
  const healthThreshold = healthThreshIdx !== -1 ? Number(args[healthThreshIdx + 1]) || 10 : 10;

  // Fresh rescan: wipe pending pool + dedup memory before discovering. Skipped
  // on --dry-run so a preview never mutates state.
  if (reset && !dryRun) resetScanState();

  // 1. Load providers
  const providers = await loadProviders(PROVIDERS_DIR);
  if (providers.size === 0) {
    console.error('Error: no providers loaded from providers/');
    process.exit(1);
  }
  // Detail-phase enrichers (providers/enrichers/*). Loaded unconditionally — they
  // run over FREE inline detail every scan and over PAID fetchDetail results when
  // --extra-fetch is on (the default).
  const enrichers = await loadEnrichers(ENRICHERS_DIR);

  // 2. Load config. Targeting/filters come from portals.yml (personal,
  //    gitignored); fall back to the example so a fresh clone without a personal
  //    portals.yml still scans rather than failing.
  const cfgPath = existsSync(PORTALS_PATH) ? PORTALS_PATH
    : existsSync(PORTALS_EXAMPLE_PATH) ? PORTALS_EXAMPLE_PATH
    : null;
  const config = cfgPath ? (parseYaml(readFileSync(cfgPath, 'utf-8')) || {}) : {};

  // Companies come from studios.yml (tracked, shared). Back-compat: if there's
  // no studios.yml, read tracked_companies from the targeting config instead.
  let companies;
  let excludeCompanies;
  if (existsSync(STUDIOS_PATH)) {
    const studios = parseYaml(readFileSync(STUDIOS_PATH, 'utf-8')) || {};
    companies = studios.tracked_companies || [];
    excludeCompanies = studios.exclude_companies;
  } else {
    companies = config.tracked_companies || [];
    excludeCompanies = config.exclude_companies;
  }
  // Source-level employer blocklist. The aggregator boards (Hitmarker, Work With
  // Indies, Games Jobs Direct, Remote Game Jobs) are whole-industry feeds, so a
  // handful of non-game employers (ByteDance, NVIDIA, Aristocrat…) leak through
  // with hundreds of non-game corporate roles that no title filter reliably
  // catches. `exclude_companies` (studios.yml) drops them at ingest — before the
  // snapshot, and independent of the personal targeting filter, so it holds even
  // under --no-filter (the board's mode). Tracked + shared so collaborators get
  // the same clean feed. Exact, case-insensitive name match only (fail-safe: a
  // mixed employer with some real game roles, e.g. Tencent, must NOT be listed —
  // let the title filter sort those). Gated to aggregator hosts so it can never
  // touch a curated single-studio feed.
  const isBlockedCompany = buildCompanyBlocklist(excludeCompanies);
  if (!companies.length) {
    console.error(`Error: no studios found. Add tracked_companies to ${STUDIOS_PATH} (or run onboarding).`);
    process.exit(1);
  }
  // Studio website map for the board: company name → careers_url. Lets each
  // studio label on the board link to its careers page. Keyed on normalized name
  // so it also resolves jobs surfaced via aggregators (whose `company` is the
  // real studio). Aggregator entries are skipped — their careers_url points at
  // the aggregator, not a studio.
  const AGG_HOSTS = DEFAULT_AGGREGATORS;
  // When an entry carries a job_url_template, its hosted ATS board is dead (that's
  // the whole reason for the template — see providers/ashby.mjs, Supercell). The
  // careers_url then 404s, so DON'T link the studio label to it. Derive the live
  // careers landing page from the template's literal prefix (everything before the
  // first {token}, cut back to the last path '/'): e.g.
  // "https://supercell.com/en/careers/{slug}/{id}/" → "https://supercell.com/en/careers/".
  const studioLandingUrl = (c) => {
    const tpl = typeof c.job_url_template === 'string' ? c.job_url_template.trim() : '';
    if (tpl) {
      const head = tpl.split('{')[0];
      const cut = head.slice(0, head.lastIndexOf('/') + 1) || head;
      try { new URL(cut); return cut; } catch { /* fall through to careers_url */ }
    }
    return c.careers_url;
  };
  const studioUrlByName = new Map();
  // Also register a parenthetical-stripped alias ("PlayStation (Sony Interactive)"
  // → "playstation") so a job whose company drops the suffix still resolves. Only
  // when the alias is unambiguous (no other studio strips to the same form).
  const aliasUrl = new Map();
  const aliasCount = new Map();
  for (const c of companies) {
    if (!c.name || !c.careers_url) continue;
    let host = '';
    try { host = new URL(c.careers_url).hostname.replace(/^www\./, '').toLowerCase(); } catch { continue; }
    if (AGG_HOSTS.some(a => host === a || host.endsWith('.' + a))) continue;
    const key = c.name.trim().toLowerCase();
    const landing = studioLandingUrl(c);
    if (!studioUrlByName.has(key)) studioUrlByName.set(key, landing);
    const alias = key.replace(/\s*\([^)]*\)\s*/g, ' ').trim();
    if (alias && alias !== key) {
      aliasCount.set(alias, (aliasCount.get(alias) || 0) + 1);
      if (!aliasUrl.has(alias)) aliasUrl.set(alias, landing);
    }
  }
  // Promote only unambiguous aliases that don't shadow an exact studio name.
  for (const [alias, n] of aliasCount) {
    if (n === 1 && !studioUrlByName.has(alias)) studioUrlByName.set(alias, aliasUrl.get(alias));
  }
  // Unified drop decision: dropTargeting(job) → 'title' | 'location' | 'company'
  // | null (keep). Supports three config shapes in priority order: the new
  // `targeting.groups` schema (shared with the board), the legacy flat
  // `targeting:` maps, and the oldest title_filter/location_filter blocks.
  let dropTargeting;
  if (noFilter) {
    // --no-filter: bypass ALL targeting. Stores the full superset of every
    // role/location/company. Used to feed the public static board, where
    // filtering + ranking happen client-side per visitor. Personal targeting
    // in portals.yml is ignored entirely for this run.
    dropTargeting = () => null;
  } else if (Array.isArray(config.targeting?.groups)) {
    const groups = config.targeting.groups;
    dropTargeting = (job) => groupDropReason(job, groups);
  } else if (config.targeting) {
    const tf = buildTargetingFilter(config.targeting);
    dropTargeting = (job) =>
      !tf.title(job.title) ? 'title'
      : !tf.location(job.location) ? 'location'
      : !tf.company(job.company) ? 'company'
      : null;
  } else {
    const titleFilter = buildTitleFilter(config.title_filter);
    const locationFilter = buildLocationFilter(config.location_filter);
    dropTargeting = (job) =>
      !titleFilter(job.title) ? 'title'
      : !locationFilter(job.location) ? 'location'
      : null; // legacy configs have no company filter
  }

  // 3. Resolve a provider for each enabled company
  const targets = [];
  let skippedCount = 0;
  const resolveErrors = [];
  for (const company of companies) {
    if (!company || typeof company !== 'object') continue;
    if (company.enabled === false) continue;
    if (typeof company.name !== 'string' || !company.name.trim()) {
      console.error(`⚠️  Skipping entry — missing or non-string 'name' field: ${JSON.stringify(company)}`);
      continue;
    }
    if (filterCompany && !company.name.toLowerCase().includes(filterCompany)) continue;
    const resolved = resolveProvider(company, providers);
    if (!resolved) { skippedCount++; continue; }
    if (resolved.error) { resolveErrors.push({ company: company.name, error: resolved.error }); continue; }
    targets.push({ ...company, _provider: resolved.provider });
  }

  const localParserCount = targets.filter(t => t._provider.id === 'local-parser').length;
  console.log(`Scanning ${targets.length} companies via providers (${localParserCount} local parser; ${skippedCount} skipped — no provider matched)`);
  if (dryRun) console.log('(dry run — no files will be written)\n');

  // 4. Load dedup sets
  const seenUrls = loadSeenUrls();
  const seenCompanyRoles = loadSeenCompanyRoles();

  // 5. Fetch from each target
  const date = new Date().toISOString().slice(0, 10);
  let totalFound = 0;
  let totalFilteredTitle = 0;
  let totalFilteredLocation = 0;
  let totalFilteredCompany = 0;
  let totalBlockedCompany = 0;
  let totalDupes = 0;
  let totalEnrichFailures = 0; // Phase-2 detail fetches that failed (detail lost, posting kept)
  const newOffers = [];
  // Full current snapshot for --json: every job that passes the filters,
  // deduped within this run only (independent of scan-history.tsv), so the
  // exported file is always the COMPLETE live set regardless of what prior
  // runs left in data/. Feeds the static board.
  const snapshot = [];
  const snapSeen = new Set();
  const errors = [...resolveErrors];
  // Per-provider health: how many companies we attempted vs how many returned
  // (a successful fetch, even with 0 jobs) vs how many we never saw because we
  // were throttled/blocked. A provider that goes fully dark to throttling is a
  // silent miss — the snapshot still looks "fine" on total count — so we track
  // it explicitly and shout about it in the summary (and exit non-zero so a CI
  // gate catches a whole source disappearing).
  const providerHealth = new Map();
  const health = (id) => {
    let h = providerHealth.get(id);
    if (!h) { h = { attempted: 0, ok: 0, throttled: 0, blocked: 0, other: 0 }; providerHealth.set(id, h); }
    return h;
  };

  // Per-company outcome for the failure tally: name -> { ok } | { ok:false, error, kind }.
  // ANY non-success counts as a failure (404 isn't guaranteed when a company
  // leaves an ATS); a reachable fetch (even 0 jobs) is a success that resets the
  // streak. Companies not attempted this run aren't recorded and carry forward.
  const companyOutcomes = new Map();

  const tasks = targets.map(company => async () => {
    let provider = company._provider;
    const ctx = makeHttpCtx();
    let sourceName = provider.id === 'local-parser' ? 'local-parser' : `${provider.id}-api`;
    try {
      let jobs;
      try {
        jobs = await provider.fetch(company, ctx);
      } catch (parserErr) {
        if (provider.id !== 'local-parser') throw parserErr;
        const fallback = resolveProvider(company, providers, { skipIds: ['local-parser'] });
        if (!fallback || fallback.error) throw parserErr;
        provider = fallback.provider;
        sourceName = `${provider.id}-api`;
        jobs = await provider.fetch(company, ctx);
        errors.push({
          company: company.name,
          error: `local parser failed, used API fallback: ${parserErr.message}`,
        });
      }
      if (!Array.isArray(jobs)) {
        throw new Error(`${provider.id}: fetch() did not return an array`);
      }

      // Phase 2 — optional per-job detail pass (enrichers + provider overlay/
      // postFetch). Failure-isolated: never drops a posting, only its detail.
      const enriched = await enrichJobs(jobs, provider, company, ctx, enrichers, { extraFetch });
      jobs = enriched.jobs;
      if (enriched.failures) totalEnrichFailures += enriched.failures;

      totalFound += jobs.length;

      for (const job of jobs) {
        // Source-level employer blocklist (aggregator leakage). Runs first, and
        // independent of the targeting filter, so it holds even under --no-filter.
        // Gated to aggregator hosts: a curated studio feed's company IS the studio,
        // so it can never be collateral here.
        if (isBlockedCompany(job.company)) {
          let host = '';
          try { host = new URL(job.url || '').hostname.replace(/^www\./, ''); } catch { /* keep '' */ }
          if (AGG_HOSTS.includes(host)) { totalBlockedCompany++; continue; }
        }
        const drop = dropTargeting(job);
        if (drop === 'title') { totalFilteredTitle++; continue; }
        if (drop === 'location') { totalFilteredLocation++; continue; }
        if (drop === 'company') { totalFilteredCompany++; continue; }
        // Normalise work mode baked into the location text ("Berlin, Hybrid",
        // "United States, Remote", "Remote (US)"…). Fill workMode when the
        // provider had no structured value, and strip the token so the board's
        // work-mode badge doesn't duplicate it. Runs AFTER the targeting gate so
        // location-keyed filters still see the original string; a structured
        // workMode from the provider normally wins over the location-derived one.
        // EXCEPTION: when the location was PURELY a location-agnostic token
        // ("Any", "Any Location", "Anywhere") nothing is left after stripping, so
        // the derived 'anywhere' is authoritative geography and OVERRIDES a
        // provider default like onsite — otherwise a studio that tags such roles
        // OnSite (e.g. Larian) shows an onsite badge over an empty location.
        {
          const { location: cleanLoc, workMode: locMode } = splitLocationMode(job.location);
          job.location = cleanLoc;
          if (locMode === 'anywhere' && !cleanLoc) job.workMode = 'anywhere';
          else if (!job.workMode && locMode) job.workMode = locMode;
        }
        // Snapshot collection happens BEFORE history dedup so jobs.json is the
        // full current set even when data/scan-history.tsv already lists these.
        if (jsonPath && job.url && !snapSeen.has(job.url)) {
          snapSeen.add(job.url);
          const companyUrl = studioUrlByName.get((job.company || '').trim().toLowerCase());
          snapshot.push({
            title: job.title,
            url: job.url,
            company: job.company,
            location: job.location || '',
            // Optional provider metadata — only set when known, so jobs.json
            // stays lean. postedDate is ISO-8601; workMode is the tri-state
            // remote/hybrid/onsite; department is a label; experienceLevel is a
            // source-taxonomy seniority label. See providers/_types.js.
            ...(companyUrl ? { companyUrl } : {}),
            ...(job.postedDate ? { postedDate: job.postedDate } : {}),
            ...(job.workMode ? { workMode: job.workMode } : {}),
            ...(job.department ? { department: job.department } : {}),
            ...(job.experienceLevel ? { experienceLevel: job.experienceLevel } : {}),
            // Visa-sponsorship stance from the detail-phase enricher (only when
            // the JD stated one): 'none' | 'offered'. See providers/enrichers/.
            ...(job.sponsorship ? { sponsorship: job.sponsorship } : {}),
          });
        }
        if (seenUrls.has(job.url)) {
          totalDupes++;
          continue;
        }
        const key = `${job.company.toLowerCase()}::${job.title.toLowerCase()}`;
        if (seenCompanyRoles.has(key)) {
          totalDupes++;
          continue;
        }
        // Mark as seen to avoid intra-scan dupes
        seenUrls.add(job.url);
        seenCompanyRoles.add(key);
        newOffers.push({ ...job, source: sourceName });
      }
      // A fetch that returned (even with 0 jobs) is a real signal, not a miss.
      const h = health(provider.id);
      h.attempted++; h.ok++;
      companyOutcomes.set(company.name, { ok: true });
    } catch (err) {
      const kind = classifyFetchError(err);
      const h = health(provider.id);
      h.attempted++;
      if (kind === 'throttled') h.throttled++;
      else if (kind === 'blocked') h.blocked++;
      else h.other++;
      errors.push({ company: company.name, error: err.message, kind, status: err.status });
      companyOutcomes.set(company.name, { ok: false, error: err.message, kind });
    }
  });

  await parallelFetch(tasks, CONCURRENCY);

  // 5.5. Optional liveness verification — drop only confirmed-expired postings.
  // A page that loads but whose Apply control we can't detect is NOT dropped;
  // it's surfaced to pipeline flagged (unverifiedOffers) so a live offer never
  // silently vanishes. Only `expired` (a positive dead signal) is removed.
  let verifiedOffers = newOffers;
  let expiredOffers = [];
  let unverifiedOffers = [];
  let invalidOffers = [];
  if (verify && newOffers.length > 0) {
    console.log(`\nVerifying liveness of ${newOffers.length} new offer(s) with Playwright (sequential)...`);
    const result = await verifyOffers(newOffers);
    verifiedOffers = result.verified;
    expiredOffers = result.expired;
    unverifiedOffers = result.unverified;
    invalidOffers = result.invalid;
  }

  // 6. Write results
  if (!dryRun && verifiedOffers.length > 0) {
    appendToPipeline(verifiedOffers);
    appendToScanHistory(verifiedOffers, date);
  }
  if (!dryRun && expiredOffers.length > 0) {
    appendToScanHistory(expiredOffers, date, 'skipped_expired');
  }
  // Pages that loaded but had no recognizable Apply control: surface to pipeline
  // flagged (never silently dropped — a live offer might just have unusual markup)
  // and record in scan-history as normal so they dedup-track on future scans.
  if (!dryRun && unverifiedOffers.length > 0) {
    appendToPipeline(unverifiedOffers, { note: '⚠️ unverified (no apply control found — check manually)' });
    appendToScanHistory(unverifiedOffers, date);
  }
  // Guard-rejected URLs (invalid / unsupported protocol / blocked host) are
  // recorded with a precise status so subsequent scans dedup-skip them via
  // loadSeenUrls, but they never reach pipeline.md.
  if (!dryRun && invalidOffers.length > 0) {
    // Group by code so the TSV reflects the actual reason category.
    const byStatus = new Map();
    for (const o of invalidOffers) {
      const status = guardStatusFor(o.code);
      if (!byStatus.has(status)) byStatus.set(status, []);
      byStatus.get(status).push(o);
    }
    for (const [status, group] of byStatus) {
      appendToScanHistory(group, date, status);
    }
  }

  // 6.5. Write the JSON snapshot (full current set) for the static board.
  // Independent of --dry-run: it never touches pipeline.md/scan-history.tsv,
  // so it's safe to generate a snapshot without mutating the personal pipeline.
  if (jsonPath) {
    // Collapse cross-source duplicates (same role mirrored across an aggregator
    // and a direct ATS). Config-driven and fail-safe: only multi-host groups are
    // touched, and it's disableable via `snapshot_dedup.enabled: false`.
    const dedupCfg = config.snapshot_dedup || {};
    let snapJobs = snapshot;
    if (dedupCfg.enabled !== false) {
      const { jobs: deduped, collapsed, collapsedById, collapsedByHeuristic } = dedupeSnapshot(snapshot, {
        aggregators: dedupCfg.aggregators || DEFAULT_AGGREGATORS,
        lastResort: dedupCfg.last_resort || dedupCfg.lastResort || DEFAULT_LAST_RESORT,
      });
      snapJobs = deduped;
      if (collapsed > 0) {
        console.log(`Dedup: collapsed ${collapsed} duplicate(s) — ${collapsedById} by posting ID, ${collapsedByHeuristic} aggregator mirror(s)`);
      }
    }
    // Optional weekly staleness recheck: curl-recheck the aged tail and drop only
    // confirmed-dead postings. Runs on the deduped snapshot so we never waste a
    // fetch on a row that dedup already collapsed.
    if (recheck) {
      const rc = config.recheck || {};
      const expiredUrls = await recheckStaleSnapshot(snapJobs, {
        ...(rc.min_age_days != null ? { minAgeDays: rc.min_age_days } : {}),
        ...(rc.concurrency != null ? { concurrency: rc.concurrency } : {}),
        ...(rc.timeout_ms != null ? { timeoutMs: rc.timeout_ms } : {}),
      });
      if (expiredUrls.size > 0) {
        snapJobs = snapJobs.filter((j) => !expiredUrls.has(j.url));
      }
    }
    const out = {
      generated: new Date().toISOString(),
      count: snapJobs.length,
      jobs: snapJobs,
    };
    mkdirSync(path.dirname(jsonPath) || '.', { recursive: true });
    writeFileSync(jsonPath, JSON.stringify(out));
    console.log(`Snapshot: ${snapJobs.length} jobs → ${jsonPath}`);

    // Project the group-schema targeting alongside the snapshot so the board
    // seeds its default filters from the SAME definition the scanner uses — no
    // second, hand-maintained copy. Only the new `groups:` schema is projected
    // (the board speaks groups); a legacy flat config emits nothing and the
    // board keeps its built-in fallback. Both jobs.json and targeting.json are
    // gitignored generated data, so this never clobbers anything committed; the
    // board's preferred personal seed (targeting.local.json) comes from
    // `npm run board:dev` and is left untouched here.
    if (Array.isArray(config.targeting?.groups)) {
      const targetingPath = path.join(path.dirname(jsonPath) || '.', 'targeting.json');
      writeFileSync(targetingPath, JSON.stringify({ groups: config.targeting.groups }));
      console.log(`Targeting: ${config.targeting.groups.length} groups → ${targetingPath}`);
    }
  }

  // 7. Print summary
  console.log(`\n${'━'.repeat(45)}`);
  console.log(`Portal Scan — ${date}`);
  console.log(`${'━'.repeat(45)}`);
  console.log(`Companies scanned:     ${targets.length}`);
  console.log(`Total jobs found:      ${totalFound}`);
  console.log(`Filtered by title:     ${totalFilteredTitle} removed`);
  console.log(`Filtered by location:  ${totalFilteredLocation} removed`);
  if (totalFilteredCompany > 0) {
    console.log(`Filtered by company:   ${totalFilteredCompany} removed`);
  }
  if (totalBlockedCompany > 0) {
    console.log(`Blocked (non-game):    ${totalBlockedCompany} removed`);
  }
  console.log(`Duplicates:            ${totalDupes} skipped`);
  if (totalEnrichFailures > 0) {
    console.log(`Detail enrich misses:  ${totalEnrichFailures} (posting kept, detail skipped)`);
  }
  if (verify) {
    console.log(`Expired (verified):    ${expiredOffers.length} dropped`);
    console.log(`Unverified (surfaced): ${unverifiedOffers.length} flagged in pipeline`);
    console.log(`Invalid (guarded):     ${invalidOffers.length} dropped`);
  }
  console.log(`New offers added:      ${verifiedOffers.length}`);

  // Partition failures: throttles/blocks are "misses" (we never saw the jobs);
  // everything else is a plain error. Surface them separately so a rate-limit
  // wave can't hide inside a generic error list.
  const throttledErrors = errors.filter(e => e.kind === 'throttled' || e.kind === 'blocked');
  const otherErrors = errors.filter(e => e.kind !== 'throttled' && e.kind !== 'blocked');

  if (throttledErrors.length > 0) {
    console.log(`\n⚠ Throttled / blocked (${throttledErrors.length}) — these companies were NOT scanned:`);
    for (const e of throttledErrors) {
      const tag = e.kind === 'blocked' ? 'blocked' : 'throttled';
      console.log(`  ⚠ ${e.company} [${tag}${e.status ? ' ' + e.status : ''}]: ${e.error}`);
    }
  }

  if (otherErrors.length > 0) {
    console.log(`\nErrors (${otherErrors.length}):`);
    for (const e of otherErrors) {
      console.log(`  ✗ ${e.company}: ${e.error}`);
    }
  }

  // Publish gate: halt ONLY on a provider blackout — a whole source where every
  // attempt failed to throttling/blocking and ZERO jobs came back. That's the
  // broad, transient signature of an IP-level ban; we'd rather skip the publish
  // and keep the last-good board than ship one silently missing a whole source.
  //
  // A SINGLE company failing (404/403/network/…) does NOT halt — it can't be
  // told apart from "this company left its ATS" in one run, and halting on it
  // would freeze the board forever. Those failures feed the per-company tally
  // below instead, which flags a departure after N straight misses without ever
  // stopping the publish.
  const blackouts = [];
  for (const [id, h] of providerHealth) {
    const dark = h.throttled + h.blocked;
    if (h.ok === 0 && h.attempted >= 2 && dark === h.attempted) {
      blackouts.push({ id, ...h });
    }
  }
  if (blackouts.length > 0) {
    console.log(`\n${'═'.repeat(45)}`);
    console.log(`🚨 PROVIDER BLACKOUT — a whole source returned nothing:`);
    for (const b of blackouts) {
      console.log(`   ${b.id}: 0/${b.attempted} companies returned (${b.throttled} throttled, ${b.blocked} blocked)`);
    }
    console.log(`   Likely an IP-level rate-limit/ban. The snapshot is INCOMPLETE.`);
    console.log(`${'═'.repeat(45)}`);
    if (failOnDegraded) {
      process.exitCode = 1;
      console.log(`   Exiting non-zero so the publish is skipped (use --no-fail-on-degraded to override).`);
    }
  }

  // Per-company failure tally — fold this run's outcomes into the prior state
  // and write it back so the board can flag companies that have likely left
  // their ATS. Only runs when --health-out is given (i.e. the CI board scan).
  if (healthOut) {
    let prevHealth = null;
    if (healthIn && existsSync(healthIn)) {
      try { prevHealth = JSON.parse(readFileSync(healthIn, 'utf-8')); }
      catch { console.log(`\n⚠ Could not parse --health-in ${healthIn}; starting tally fresh.`); }
    }
    const outcomes = [...companyOutcomes].map(([name, o]) => ({ name, ...o }));
    // Studios that currently have a resolvable feed (ignoring this run's filter).
    // Passed so mergeHealth drops the stale streak of any studio that's been
    // unwired/removed from studios.yml — otherwise a removed studio's 10+ failure
    // record would carry forward forever and keep firing the departed-ATS banner.
    const trackedNames = companies
      .filter((c) => c && typeof c.name === 'string' && c.enabled !== false && resolveProvider(c, providers))
      .map((c) => c.name);
    const newHealth = mergeHealth(prevHealth, outcomes, { threshold: healthThreshold, tracked: trackedNames });
    mkdirSync(path.dirname(healthOut) || '.', { recursive: true });
    writeFileSync(healthOut, JSON.stringify(newHealth));
    const flagged = Object.entries(newHealth.companies)
      .filter(([, r]) => r.fails > 0)
      .sort((a, b) => b[1].fails - a[1].fails);
    console.log(`\nHealth tally → ${healthOut} (${flagged.length} compan${flagged.length === 1 ? 'y' : 'ies'} on a failure streak, alert at ${healthThreshold})`);
    for (const [name, r] of flagged.slice(0, 10)) {
      const mark = r.fails >= healthThreshold ? '🔴' : '  ';
      console.log(`  ${mark} ${name}: ${r.fails} straight (since ${r.since})${r.lastError ? ` — ${r.lastError.slice(0, 80)}` : ''}`);
    }
    if (newHealth.alerts.length > 0) {
      console.log(`\n🔴 DEPARTED-ATS ALERT (${newHealth.alerts.length}) — ${healthThreshold}+ straight failures, check studios.yml:`);
      console.log(`   ${newHealth.alerts.join(', ')}`);
    }
  }

  if (verifiedOffers.length > 0) {
    console.log('\nNew offers:');
    for (const o of verifiedOffers) {
      console.log(`  + ${o.company} | ${o.title} | ${o.location || 'N/A'}`);
    }
    if (dryRun) {
      console.log('\n(dry run — run without --dry-run to save results)');
    } else {
      console.log(`\nResults saved to ${PIPELINE_PATH} and ${SCAN_HISTORY_PATH}`);
    }
  }

  console.log(`\n→ Run /career-ops pipeline to evaluate new offers.`);
  console.log('→ Share results and get help: https://discord.gg/8pRpHETxa4');
}

// Only run main() when invoked directly (`node scan.mjs`), not when imported by tests.
// `|| ''` guards the case where Node is invoked without a script arg (e.g. `node -e`).
if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  main().catch(err => {
    console.error('Fatal:', err.message);
    process.exit(1);
  });
}
