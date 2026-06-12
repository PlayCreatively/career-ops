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
 */

import { readFileSync, writeFileSync, appendFileSync, existsSync, mkdirSync, readdirSync } from 'fs';
import { pathToFileURL, fileURLToPath } from 'url';
import path from 'path';
import yaml from 'js-yaml';

import { makeHttpCtx } from './providers/_http.mjs';
import { splitLocationMode } from './providers/_util.mjs';
import { scoreCategory, matchGroup, isExcluded } from './rank.mjs';

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

// Ensure required directories exist (fresh setup)
mkdirSync('data', { recursive: true });

const CONCURRENCY = 10;

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
  for (const g of groups) {
    if (matchGroup(job, g).some((f) => f.weight === 0)) {
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
//   2. Title/company/location heuristic, AGGREGATOR-GATED. Within a group of rows
//      sharing company + title + location, an aggregator row (Hitmarker /
//      WorkWithIndies) is dropped ONLY when a direct (non-aggregator) row for the
//      same role also exists. Direct rows are never merged with each other, so an
//      Epic-style pair of distinct same-title reqs is always preserved.
//
// The aggregator host list is configurable (portals.yml → snapshot_dedup).
export function dedupeSnapshot(jobs, { aggregators = ['hitmarker.net', 'workwithindies.com'] } = {}) {
  const aggs = aggregators.map(a => String(a).toLowerCase());
  const hostOf = (u) => {
    try { return new URL(u).hostname.replace(/^www\./, '').toLowerCase(); }
    catch { return ''; }
  };
  const isAgg = (u) => { const h = hostOf(u); return aggs.some(a => h === a || h.endsWith('.' + a)); };
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

  // ── Pass 2: title/company/location, aggregator-gated. ─────────────────────
  const keyOf = (j) => `${norm(j.company)}::${norm(j.title)}::${norm(j.location)}`;
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
    const aggsIn = arr.filter(j => isAgg(j.url));
    // Drop aggregator mirror(s) only when the same role exists as a direct posting.
    // All-direct or all-aggregator groups are left untouched.
    if (aggsIn.length && directs.length) {
      result.push(...directs);
      collapsedByHeuristic += aggsIn.length;
    } else {
      result.push(...arr);
    }
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
      const url = line.split('\t')[0];
      if (url) seen.add(url);
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

function appendToPipeline(offers) {
  if (offers.length === 0) return;

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
      `- [ ] ${o.url} | ${o.company} | ${o.title}`
    ).join('\n') + '\n\n';
    text = text.slice(0, insertAt) + block + text.slice(insertAt);
  } else {
    // Find the end of existing Pendientes content (next ## or end)
    const afterMarker = idx + marker.length;
    const nextSection = text.indexOf('\n## ', afterMarker);
    const insertAt = nextSection === -1 ? text.length : nextSection;

    const block = '\n' + offers.map(o =>
      `- [ ] ${o.url} | ${o.company} | ${o.title}`
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

  // Three permanent buckets + one transient passthrough:
  //   verified  → active pages and transient nav errors (retry next scan)
  //   expired   → classifier-confirmed dead postings (HTTP 4xx, redirect markers,
  //               body patterns, listing pages, insufficient content)
  //   dropped   → page loaded but classifier saw no Apply control. --verify is an
  //               opt-in stricter filter; keeping these defeats the purpose.
  //   invalid   → up-front URL guard rejections (malformed / non-http / private)
  const verified = [];
  const expired = [];
  const dropped = [];
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
        // Page loaded but classifier could not find an Apply control. Treat like
        // expired for routing — drop from pipeline AND record in scan-history so
        // we don't burn a verify cycle on the same URL next scan.
        dropped.push({ ...offer, reason });
        console.log(`  ⚠️ no-apply  ${offer.company} | ${offer.title} (${reason})`);
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

  return { verified, expired, dropped, invalid };
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
  const jsonIdx = args.indexOf('--json');
  const jsonPath = jsonIdx !== -1 ? args[jsonIdx + 1] : null;
  const companyFlag = args.indexOf('--company');
  const filterCompany = companyFlag !== -1 ? args[companyFlag + 1]?.toLowerCase() : null;

  // Fresh rescan: wipe pending pool + dedup memory before discovering. Skipped
  // on --dry-run so a preview never mutates state.
  if (reset && !dryRun) resetScanState();

  // 1. Load providers
  const providers = await loadProviders(PROVIDERS_DIR);
  if (providers.size === 0) {
    console.error('Error: no providers loaded from providers/');
    process.exit(1);
  }

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
  if (existsSync(STUDIOS_PATH)) {
    const studios = parseYaml(readFileSync(STUDIOS_PATH, 'utf-8')) || {};
    companies = studios.tracked_companies || [];
  } else {
    companies = config.tracked_companies || [];
  }
  if (!companies.length) {
    console.error(`Error: no studios found. Add tracked_companies to ${STUDIOS_PATH} (or run onboarding).`);
    process.exit(1);
  }
  // Studio website map for the board: company name → careers_url. Lets each
  // studio label on the board link to its careers page. Keyed on normalized name
  // so it also resolves jobs surfaced via aggregators (whose `company` is the
  // real studio). Aggregator entries are skipped — their careers_url points at
  // the aggregator, not a studio.
  const AGG_HOSTS = ['hitmarker.net', 'workwithindies.com'];
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
    if (!studioUrlByName.has(key)) studioUrlByName.set(key, c.careers_url);
    const alias = key.replace(/\s*\([^)]*\)\s*/g, ' ').trim();
    if (alias && alias !== key) {
      aliasCount.set(alias, (aliasCount.get(alias) || 0) + 1);
      if (!aliasUrl.has(alias)) aliasUrl.set(alias, c.careers_url);
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
  let totalDupes = 0;
  const newOffers = [];
  // Full current snapshot for --json: every job that passes the filters,
  // deduped within this run only (independent of scan-history.tsv), so the
  // exported file is always the COMPLETE live set regardless of what prior
  // runs left in data/. Feeds the static board.
  const snapshot = [];
  const snapSeen = new Set();
  const errors = [...resolveErrors];

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
      totalFound += jobs.length;

      for (const job of jobs) {
        const drop = dropTargeting(job);
        if (drop === 'title') { totalFilteredTitle++; continue; }
        if (drop === 'location') { totalFilteredLocation++; continue; }
        if (drop === 'company') { totalFilteredCompany++; continue; }
        // Normalise work mode baked into the location text ("Berlin, Hybrid",
        // "United States, Remote", "Remote (US)"…). Fill workMode when the
        // provider had no structured value, and strip the token so the board's
        // work-mode badge doesn't duplicate it. Runs AFTER the targeting gate so
        // location-keyed filters still see the original string; a structured
        // workMode from the provider always wins over the location-derived one.
        {
          const { location: cleanLoc, workMode: locMode } = splitLocationMode(job.location);
          job.location = cleanLoc;
          if (!job.workMode && locMode) job.workMode = locMode;
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
            // remote/hybrid/onsite; department is a label. See providers/_types.js.
            ...(companyUrl ? { companyUrl } : {}),
            ...(job.postedDate ? { postedDate: job.postedDate } : {}),
            ...(job.workMode ? { workMode: job.workMode } : {}),
            ...(job.department ? { department: job.department } : {}),
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
    } catch (err) {
      errors.push({ company: company.name, error: err.message });
    }
  });

  await parallelFetch(tasks, CONCURRENCY);

  // 5.5. Optional liveness verification — drop expired and guard-rejected postings
  let verifiedOffers = newOffers;
  let expiredOffers = [];
  let droppedOffers = [];
  let invalidOffers = [];
  if (verify && newOffers.length > 0) {
    console.log(`\nVerifying liveness of ${newOffers.length} new offer(s) with Playwright (sequential)...`);
    const result = await verifyOffers(newOffers);
    verifiedOffers = result.verified;
    expiredOffers = result.expired;
    droppedOffers = result.dropped;
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
  // Pages that loaded but had no Apply control: record so we don't re-verify
  // them next scan, but never let them reach pipeline.md.
  if (!dryRun && droppedOffers.length > 0) {
    appendToScanHistory(droppedOffers, date, 'skipped_no_apply_control');
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
        aggregators: dedupCfg.aggregators || ['hitmarker.net', 'workwithindies.com'],
      });
      snapJobs = deduped;
      if (collapsed > 0) {
        console.log(`Dedup: collapsed ${collapsed} duplicate(s) — ${collapsedById} by posting ID, ${collapsedByHeuristic} aggregator mirror(s)`);
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
  console.log(`Duplicates:            ${totalDupes} skipped`);
  if (verify) {
    console.log(`Expired (verified):    ${expiredOffers.length} dropped`);
    console.log(`No apply control:      ${droppedOffers.length} dropped`);
    console.log(`Invalid (guarded):     ${invalidOffers.length} dropped`);
  }
  console.log(`New offers added:      ${verifiedOffers.length}`);

  if (errors.length > 0) {
    console.log(`\nErrors (${errors.length}):`);
    for (const e of errors) {
      console.log(`  ✗ ${e.company}: ${e.error}`);
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
