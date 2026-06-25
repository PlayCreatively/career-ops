#!/usr/bin/env node
// Mine the alexanderrehm.com games-jobs board (jobs.json) for company -> ATS slug
// pairs. The feed is a curated games-industry aggregator: every record carries
// `source_ats` + `source_studio` (the ATS tenant slug) + `source_url`. We turn
// each posting into a studios.yml identity, dedupe against studios.yml, gate on a
// games-title signal + the exclude_companies blocklist, live-validate the feed,
// and (with --add) append high-confidence studios. Tokenless.
//
// Identity is DELEGATED to the providers (ats-logic-single-source): we first try
// every provider's mineUrl(source_url); for custom-domain postings that no
// provider claims (e.g. greenhouse on a vanity domain, teamtailor on a custom
// host), we fall back to the provider's OWN probe.careersUrl(slug) builder, keyed
// by source_ats. No per-ATS URL string is hardcoded here. Wrong guesses simply
// fail live validation and are dropped (fail-safe).
//
// Flags:
//   (none)      report games-studio candidates grouped by provider:slug
//   --json      machine output of candidates
//   --validate  live-check candidate feeds, print LIVE/dead
//   --add       live-validate, then AUTO-APPEND high-confidence games studios
//               whose provider already exists in providers/ to studios.yml.
//               --dry-run shows the add/skip report without writing.
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { makeHttpCtx } from './providers/_http.mjs';

const ROOT = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const JOBS = path.join(ROOT, 'rehm-jobs.json');
const STUDIOS = path.join(ROOT, 'studios.yml');
const REHM_URL = 'https://www.alexanderrehm.com/jobs.json';
// The site 403s a bare fetch; a browser UA is required (same as scan providers).
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36';

// --- studios.yml dedupe sets -------------------------------------------------
function loadTracked() {
  const names = new Set(), hosts = new Set(), slugs = new Set();
  let txt = '';
  try { txt = fs.readFileSync(STUDIOS, 'utf8'); } catch { return { names, hosts, slugs }; }
  for (const line of txt.split('\n')) {
    let m = line.match(/name:\s*["']?(.+?)["']?\s*$/);
    if (m) names.add(norm(m[1]));
    m = line.match(/careers_url:\s*["']?(\S+?)["']?\s*$/);
    if (m) {
      try {
        const u = new URL(m[1]);
        hosts.add(u.hostname.replace(/^www\./, ''));
        const seg = u.pathname.split('/').filter(Boolean)[0];
        if (seg) slugs.add(seg.toLowerCase());
        const sub = u.hostname.split('.')[0];
        if (sub && sub !== 'www') slugs.add(sub.toLowerCase());
        if (/jobylon\.com$/.test(u.hostname)) {
          const jm = u.pathname.match(/\/companies\/(\d+)/);
          if (jm) slugs.add(jm[1]);
        }
      } catch {}
    }
    m = line.match(/(?:slug|company_id|ashby_slug|gh_slug):\s*["']?(\S+?)["']?\s*$/);
    if (m) slugs.add(m[1].toLowerCase());
  }
  return { names, hosts, slugs };
}

// Companies scan.mjs drops at ingest (off-theme: gambling, hardware, non-game
// corps). Auto-add honors the same list — EXACT, case-insensitive, like scan.mjs.
function loadExcludes() {
  const out = new Set();
  let txt = '';
  try { txt = fs.readFileSync(STUDIOS, 'utf8'); } catch { return out; }
  const m = txt.match(/^exclude_companies:\s*\n([\s\S]*?)^\S/m);
  const block = m ? m[1] : '';
  for (const line of block.split('\n')) {
    const e = line.match(/^\s*-\s*(.+?)\s*$/);
    if (e) out.add(e[1].replace(/\s+#.*$/, '').replace(/^["']|["']$/g, '').trim().toLowerCase());
  }
  return out;
}

function norm(s) {
  return String(s).toLowerCase()
    .replace(/\b(ab|inc|ltd|llc|gmbh|studios?|games?|interactive|entertainment|group|the|co)\b/g, '')
    .replace(/[^a-z0-9]/g, '')
    .replace(/(ltd|llc|gmbh|studios?|interactive|entertainment|group|games?)/g, '');
}

// --- provider registry (shared with scan.mjs) --------------------------------
// Pure CONSUMER of providers: never re-implements an ATS's URL parsing, feed
// fetching, or careers_url shape. mineUrl = URL->identity; probe.careersUrl =
// slug->careers_url fallback; fetch = live validation.
const HTTP_CTX = makeHttpCtx();
const REGISTRY = new Map();
{
  const dir = path.join(ROOT, 'providers');
  for (const f of fs.readdirSync(dir).filter(f => f.endsWith('.mjs') && !f.startsWith('_')).sort()) {
    try {
      const mod = await import(pathToFileURL(path.join(dir, f)).href);
      const p = mod.default;
      if (p && p.id && typeof p.fetch === 'function') REGISTRY.set(p.id, p);
    } catch { /* unloadable provider — skip, mirrors scan.mjs's loader */ }
  }
}
const MINERS = [...REGISTRY.values()].filter(p => typeof p.mineUrl === 'function');

// A provider's own slug->careers_url builder, or null. Lets the fallback reuse
// provider logic instead of hardcoding ATS URL shapes here.
function probeCareersUrl(provider, slug) {
  const e = provider && provider.probe && (provider.probe.endpoints || [])[0];
  if (e && typeof e.careersUrl === 'function') {
    try { return e.careersUrl(slug); } catch { return null; }
  }
  return null;
}

// rehm record -> { p, slug, careers_url } or null.
// 1. mineUrl(source_url): the canonical, casing-correct path (handles ATS-hosted
//    posting URLs).
// 2. fallback: if source_ats names a provider we ship, build careers_url from its
//    OWN probe builder using source_studio (recovers custom-domain greenhouse /
//    teamtailor / recruitee etc.). Validation drops any wrong guess.
function detect(rec) {
  for (const p of MINERS) {
    let hit;
    try { hit = p.mineUrl(rec.source_url); } catch { hit = null; }
    if (hit && hit.slug && hit.careers_url) {
      return { p: p.id, slug: hit.slug, careers_url: hit.careers_url, ...(hit.label ? { label: hit.label } : {}) };
    }
  }
  const prov = REGISTRY.get(rec.source_ats);
  if (prov && rec.source_studio) {
    const url = probeCareersUrl(prov, rec.source_studio);
    if (url) return { p: prov.id, slug: rec.source_studio, careers_url: url };
  }
  return null;
}

// --- load the feed -----------------------------------------------------------
if (!fs.existsSync(JOBS) || process.argv.includes('--refresh')) {
  console.error(`fetching ${REHM_URL} …`);
  const r = await fetch(REHM_URL, { headers: { 'user-agent': UA }, signal: AbortSignal.timeout(60000) });
  if (!r.ok) { console.error('fetch failed:', r.status); process.exit(1); }
  fs.writeFileSync(JOBS, await r.text());
  console.error('cached to', JOBS);
}
const feed = JSON.parse(fs.readFileSync(JOBS, 'utf8'));
const records = Array.isArray(feed) ? feed : (feed.records || []);
const tracked = loadTracked();

// games-title signal, split by confidence (same taxonomy as mine-asgc.mjs).
const STRONG_GAMES = /\b(game ?play|gameplay|game ?designer|game ?design|game ?director|game ?artist|game ?economy|game ?producer|game ?writer|narrative designer|level designer|combat designer|encounter designer|systems designer|world builder|technical artist|character artist|environment artist|concept artist|vfx artist|3d artist|rigging|rigger|animator|unreal|unity|game engine|gameplay (engineer|programmer)|engine (engineer|programmer))\b/i;
const WEAK_GAMES = /\b(live ?ops|monetization|player support|community manager|qa tester|game qa|build engineer|tools (engineer|programmer)|graphics (engineer|programmer))\b/i;

// group by provider:slug; records on an ATS we don't ship are tallied for the
// aggregator-provider decision and otherwise ignored here.
const groups = new Map();
const unsupported = new Map(); // source_ats -> {studios:Set, jobs}
for (const r of records) {
  const d = detect(r);
  if (!d) {
    const u = unsupported.get(r.source_ats) || { studios: new Set(), jobs: 0 };
    u.studios.add(r.source_studio); u.jobs++; unsupported.set(r.source_ats, u);
    continue;
  }
  const key = d.p + ':' + d.slug.toLowerCase();
  let g = groups.get(key);
  if (!g) { g = { p: d.p, slug: d.slug, label: d.label, careers_url: d.careers_url, companies: new Set(), count: 0, strongHits: 0, weakHits: 0, gamesHits: 0, sampleTitle: r.title }; groups.set(key, g); }
  g.companies.add(r.company);
  g.count++;
  const t = r.title || '';
  const strong = STRONG_GAMES.test(t);
  const weak = !strong && WEAK_GAMES.test(t);
  if (strong) g.strongHits++;
  if (weak) g.weakHits++;
  if (strong || weak) g.gamesHits++;
}

// dedupe against studios.yml (slug identity OR normalized company name)
const fresh = [];
let skipped = 0;
for (const g of groups.values()) {
  const nameMatch = [...g.companies].some(c => tracked.names.has(norm(c)));
  if (tracked.slugs.has(g.slug.toLowerCase()) || nameMatch) { skipped++; continue; }
  fresh.push(g);
}
for (const g of fresh) g.gamesFrac = g.gamesHits / g.count;

// The whole rehm feed is a curated games board, so a board with ANY games-title
// signal is a candidate (the output is reviewed before anything is added).
function isGamesCandidate(g) {
  if (g.gamesHits < 1) return false;
  return g.strongHits >= 1 || g.gamesFrac >= 0.25;
}
// High confidence = a strong games title present, or games titles are a majority.
function isHighConfidence(g) {
  return g.strongHits >= 1 || g.gamesFrac >= 0.5;
}
// Off-theme employers a games board still lists but this fork excludes.
const OFF_THEME = /\b(vfx|fx\b|visual ?effects|imageworks|cinesite|framestore|feature animation|animation studios?|casino|gambling|i-?gaming|sportsbook|betting|lottery|slots?|poker|wager)\b/i;
// Concatenated-name fallback: feed names often arrive glued ("barnstormvfx"), so
// the \b word boundaries above never fire. Catch the unambiguous off-theme tokens
// on the despaced name too.
const OFF_THEME_GLUED = /(vfx|visualeffects|imageworks|cinesite|framestore)/;
const blockNorm = (s) => String(s).toLowerCase().replace(/[^a-z0-9]/g, '');
function isOffTheme(co) { return OFF_THEME.test(co) || OFF_THEME_GLUED.test(blockNorm(co)); }
// Blocklist match: exact (like scan.mjs) OR a specific (>=6 char) blocklist token
// appearing inside the despaced company name, so slug/variant spellings like
// "yggdrasilsandbox" still resolve to "Yggdrasil". Short tokens (intel/amd) stay
// exact-only to avoid matching inside unrelated words.
function isBlocked(co, excludes) {
  if (excludes.has(co.toLowerCase())) return true;
  const cn = blockNorm(co);
  for (const e of excludes) { const en = blockNorm(e); if (en.length >= 6 && cn.includes(en)) return true; }
  return false;
}
function distinctIdentities(g) { return new Set([...g.companies].map(norm)).size; }
function bestCompanyName(g) {
  return [...g.companies].sort((a, b) => {
    const sa = /\s/.test(a), sb = /\s/.test(b);
    if (sa !== sb) return sa ? -1 : 1;
    return b.length - a.length;
  })[0];
}
function yamlName(s) {
  return /^[A-Za-z0-9][\w .,'&()/+-]*$/.test(s)
    ? s : '"' + String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
}
function dispSlug(g) { return g.label || decodeURIComponent(g.slug); }

// --- live validation (runs the SAME provider code scan.mjs uses) -------------
async function validateLive(g) {
  if (!g.careers_url) return '?';
  const provider = REGISTRY.get(g.p);
  if (!provider) return 'no-provider';
  const entry = { name: bestCompanyName(g), provider: g.p, careers_url: g.careers_url };
  try {
    const jobs = await provider.fetch(entry, HTTP_CTX);
    return Array.isArray(jobs) ? jobs.length : 0;
  } catch (err) {
    return err && err.status != null ? err.status : 'ERR ' + (err && err.code ? err.code : (err && err.message ? err.message.slice(0, 40) : 'unknown'));
  }
}
async function validateAll(list) {
  const out = [];
  const CONC = 8;
  for (let i = 0; i < list.length; i += CONC) {
    const batch = list.slice(i, i + CONC);
    const res = await Promise.all(batch.map(g => validateLive(g)));
    batch.forEach((g, k) => out.push([g, res[k]]));
  }
  return out;
}

const games = fresh.filter(isGamesCandidate).sort((a, b) => (b.gamesFrac - a.gamesFrac) || (b.count - a.count));

function printUnsupported() {
  const rows = [...unsupported.entries()].map(([ats, v]) => ({ ats, studios: v.studios.size, jobs: v.jobs })).sort((a, b) => b.jobs - a.jobs);
  const totS = rows.reduce((s, r) => s + r.studios, 0), totJ = rows.reduce((s, r) => s + r.jobs, 0);
  console.log(`\n=== On an ATS with NO provider (aggregator-provider territory): ${totS} studios, ${totJ} jobs ===`);
  for (const r of rows) console.log(`${String(r.studios).padStart(4)} studios  ${String(r.jobs).padStart(5)}j  ${r.ats}`);
}

if (process.argv.includes('--add')) {
  const dry = process.argv.includes('--dry-run');
  const excludes = loadExcludes();
  console.log('Auto-add: live-validating', games.length, 'games candidates against feeds...\n');
  const results = await validateAll(games);
  const today = new Date().toISOString().slice(0, 10);
  const added = [], notAdded = [], entries = [], addedNorms = new Set();
  for (const [g, n] of results) {
    const co = bestCompanyName(g);
    const live = typeof n === 'number' && n > 0;
    let reason = null;
    if (!g.careers_url) reason = `no careers_url for '${g.p}'`;
    else if (!REGISTRY.has(g.p)) reason = `provider '${g.p}' not in providers/`;
    else if (!live) reason = `feed not live (${n})`;
      else if (isBlocked(co, excludes)) reason = 'in exclude_companies blocklist';
    else if (isOffTheme(co)) reason = 'off-theme (VFX/film/iGaming)';
    else if (!isHighConfidence(g)) reason = `low confidence (s${g.strongHits}, frac ${g.gamesFrac.toFixed(2)})`;
    else if (distinctIdentities(g) > 1) reason = `ambiguous board (${distinctIdentities(g)} companies)`;
    else if (addedNorms.has(norm(co))) reason = 'duplicate within this run';
    if (reason) { notAdded.push({ g, co, n, reason }); continue; }
    addedNorms.add(norm(co));
    entries.push(
      `  - name: ${yamlName(co)}\n` +
      `    provider: ${g.p}\n` +
      `    careers_url: ${g.careers_url}\n` +
      `    status: resolved\n` +
      `    notes: "rehm-mined; ${g.p}-confirmed live (${n} jobs, ${today}). Auto-added (high-confidence)."`
    );
    added.push({ g, co, n });
  }
  console.log(`=== ADDED (${added.length}) ===`);
  for (const a of added) console.log(`+ ${a.g.p.padEnd(15)} ${dispSlug(a.g).padEnd(26)} ${String(a.n).padStart(3)}j  ${a.co}`);
  console.log(`\n=== NOT ADDED (${notAdded.length}) ===`);
  for (const s of notAdded.sort((a, b) => a.reason.localeCompare(b.reason)))
    console.log(`- ${s.g.p.padEnd(15)} ${dispSlug(s.g).padEnd(26)} ${String(s.n).padStart(4)}  ${s.co}  — ${s.reason}`);
  if (!added.length) { console.log('\nNothing to add.'); process.exit(0); }
  if (dry) { console.log(`\n[dry-run] would append ${added.length} entries to studios.yml`); process.exit(0); }
  fs.appendFileSync(STUDIOS, `\n  # --- rehm-mined (${today}, high-confidence, live-validated) ---\n` + entries.join('\n') + '\n');
  console.log(`\nAppended ${added.length} entries to studios.yml`);
  process.exit(0);
}

if (process.argv.includes('--validate')) {
  console.log('Validating', games.length, 'games candidates against live feeds...\n');
  const results = await validateAll(games);
  let liveN = 0;
  for (const [g, n] of results) {
    const ok = typeof n === 'number' && n > 0;
    if (ok) liveN++;
    console.log(`${ok ? 'LIVE' : 'dead'}  ${String(n).padStart(4)}  ${g.p.padEnd(15)} ${dispSlug(g).padEnd(26)} ${bestCompanyName(g)}`);
  }
  console.log(`\nLIVE: ${liveN} / ${games.length}`);
  process.exit(0);
}

if (process.argv.includes('--json')) {
  const out = process.argv.includes('--all') ? fresh : games;
  console.log(JSON.stringify(out.map(g => ({ provider: g.p, slug: g.slug, jobs: g.count, gamesFrac: +g.gamesFrac.toFixed(2), company: bestCompanyName(g) })), null, 1));
} else {
  const byProv = {};
  for (const g of games) byProv[g.p] = (byProv[g.p] || 0) + 1;
  console.log('=== rehm mining: GAMES-studio ATS slug candidates ===');
  console.log('records:', records.length, '| slug-groups:', groups.size, '| already-tracked:', skipped, '| fresh:', fresh.length, '| games-filtered:', games.length);
  console.log('games by provider:', byProv);
  console.log('\n--- games candidates (frac = games-title share; s/w = strong/weak title hits) ---');
  for (const g of games) {
    console.log(`${(g.gamesFrac).toFixed(2)}  ${String(g.count).padStart(3)}j  s${g.strongHits}/w${g.weakHits}  ${g.p.padEnd(15)} ${dispSlug(g).padEnd(26)} ${bestCompanyName(g)}`);
  }
  printUnsupported();
}
