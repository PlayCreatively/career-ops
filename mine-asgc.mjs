#!/usr/bin/env node
// Mine the ASGC board (asgc-jobs.json) for company -> ATS slug pairs.
// Extracts provider+slug from each jobLink hostname/path, groups by slug,
// dedupes against studios.yml, and prints candidates ranked by job count.
// Tokenless. Does NOT validate live feeds (that's phase 2 -- see --validate).
// Flags: --validate (live-check candidate feeds) | --json [--all] (machine output)
//        --unknown [--json] (report links we could NOT mine, grouped by ATS platform
//                            and custom domain, with studio/job counts -> what to build next)
//        --add (live-validate, then AUTO-APPEND high-confidence games studios whose
//               provider already exists in providers/ to studios.yml; prints an
//               added/not-added report with a reason for every skip. --dry-run shows
//               the report without writing.)
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { makeHttpCtx, classifyFetchError } from './providers/_http.mjs';

const ROOT = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const JOBS = path.join(ROOT, 'asgc-jobs.json');
const STUDIOS = path.join(ROOT, 'studios.yml');

// --- studios.yml dedupe sets -------------------------------------------------
function loadTracked() {
  const names = new Set();
  const hosts = new Set();
  const slugs = new Set();
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
        // record the leading path segment as a slug candidate too
        const seg = u.pathname.split('/').filter(Boolean)[0];
        if (seg) slugs.add(seg.toLowerCase());
        // subdomain slug (foo.teamtailor.com -> foo)
        const sub = u.hostname.split('.')[0];
        if (sub && sub !== 'www') slugs.add(sub.toLowerCase());
        // jobylon identity is the numeric company id in the path, not the slug seg
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

// Companies scan.mjs drops at ingest (off-theme: gambling hardware, non-game
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
    // pass 1: strip corporate noise on word boundaries (spaced names)
    .replace(/\b(ab|inc|ltd|llc|gmbh|studios?|games?|interactive|entertainment|group|the|co)\b/g, '')
    .replace(/[^a-z0-9]/g, '')
    // pass 2: the SAME noise, but glued. A name sometimes arrives as the bare
    // concatenated slug ("Companiongroupltd", "High5games") with no separators, so
    // pass 1's \b boundaries never fire and it fails to collapse onto its spaced
    // twin ("Companion Group", "High 5 Games") — a false "ambiguous board" split.
    // Strip only the long, unambiguous tokens; NEVER the short ones (co/the/ab/inc/
    // and) that occur inside real words and would cause false merges.
    .replace(/(ltd|llc|gmbh|studios?|interactive|entertainment|group|games?)/g, '');
}

// --- provider + slug extraction from a jobLink -------------------------------
// Fully DELEGATED to the providers: each ATS provider owns its URL→identity logic
// via an optional mineUrl(link) method (the inverse of its `probe`). We try every
// loaded provider and take the first that claims the link, carrying back the
// canonical { slug, careers_url } it derived. No per-ATS branch lives here — adding
// or parsing an ATS is one self-contained provider file. (ats-logic-single-source:
// ATS logic belongs in providers/, never duplicated in a parallel ladder.)
// MINERS is defined just below loadTracked(); detect() is only called after it.
function detect(link) {
  for (const p of MINERS) {
    let hit;
    try { hit = p.mineUrl(link); } catch { hit = null; }
    if (hit && hit.slug && hit.careers_url) {
      return {
        p: p.id,
        slug: hit.slug,
        careers_url: hit.careers_url,
        host: hostOf(link),
        ...(hit.label ? { label: hit.label } : {}),
      };
    }
  }
  return null;
}

// -----------------------------------------------------------------------------
const ASGC_URL = 'https://games-jobs-workbook.replit.app/api/job-listings?grouped=1';
if (!fs.existsSync(JOBS)) {
  console.error(`asgc-jobs.json not found — fetching ${ASGC_URL} …`);
  const r = await fetch(ASGC_URL, { headers: { 'user-agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(60000) });
  if (!r.ok) { console.error('fetch failed:', r.status); process.exit(1); }
  fs.writeFileSync(JOBS, await r.text());
  console.error('cached to', JOBS);
}
const jobs = JSON.parse(fs.readFileSync(JOBS, 'utf8'));
const tracked = loadTracked();

// --- provider registry (shared) ----------------------------------------------
// Load every provider in providers/ exactly like scan.mjs does. The miner is a
// pure CONSUMER of providers: it never re-implements an ATS's URL parsing, feed
// fetching, or careers_url shape — it asks the providers (mineUrl for URL→identity,
// fetch for live validation). Adding/changing an ATS is one provider file.
const HTTP_CTX = makeHttpCtx();
let _providerRegistry = null;
async function providerRegistry() {
  if (_providerRegistry) return _providerRegistry;
  const reg = new Map();
  const dir = path.join(ROOT, 'providers');
  for (const f of fs.readdirSync(dir).filter(f => f.endsWith('.mjs') && !f.startsWith('_')).sort()) {
    try {
      const mod = await import(pathToFileURL(path.join(dir, f)).href);
      const p = mod.default;
      if (p && p.id && typeof p.fetch === 'function') reg.set(p.id, p);
    } catch { /* unloadable provider — skip, mirrors scan.mjs's loader */ }
  }
  _providerRegistry = reg;
  return reg;
}
// Providers that can turn a raw job URL into a studios.yml identity (expose
// mineUrl), and the set of ATS ids we can therefore parse — both DERIVED from the
// registry, never hand-maintained. detect() delegates to MINERS; the --unknown
// report uses MINED_IDS to mark which unparsed links belong to an ATS we cover.
const MINERS = [...(await providerRegistry()).values()].filter(p => typeof p.mineUrl === 'function');
const MINED_IDS = new Set(MINERS.map(p => p.id));

// games signal, split by confidence.
// STRONG = titles that are near-exclusive to game studios; a single one is decisive.
// WEAK = supportive but also common at non-games employers; needs a share or gaming-cat backup.
const STRONG_GAMES = /\b(game ?play|gameplay|game ?designer|game ?design|game ?director|game ?artist|game ?economy|game ?producer|game ?writer|narrative designer|level designer|combat designer|encounter designer|systems designer|world builder|technical artist|character artist|environment artist|concept artist|vfx artist|3d artist|rigging|rigger|animator|unreal|unity|game engine|gameplay (engineer|programmer)|engine (engineer|programmer))\b/i;
const WEAK_GAMES = /\b(live ?ops|monetization|player support|community manager|qa tester|game qa|build engineer|tools (engineer|programmer)|graphics (engineer|programmer))\b/i;

// A likely games studio's board: a strong title present, OR a meaningful share of any
// games titles, OR a small board that's mostly tagged Gaming Company. Permissive on
// purpose -- the output is reviewed before anything is added, and a missed studio is
// gone forever while a false positive is a one-second reject.
function isGamesCandidate(g) {
  if (g.gamesHits < 1) return false;
  const frac = g.gamesHits / g.count;
  return g.strongHits >= 1
      || frac >= 0.34
      || (g.count <= 30 && g.gamingCat / g.count >= 0.5);
}

// --- unrecognized-link classification (discovery: which ATS to build next) ---------
// Known ATS platforms by host suffix — used only to LABEL links no provider claimed
// (which ATS to build next). Whether we already cover one is derived at report time
// from the provider registry (MINED_IDS), not hand-flagged here.
const ATS_PLATFORMS = [
  { re: /(^|\.)greenhouse\.io$/, label: 'greenhouse' },
  { re: /(^|\.)lever\.co$/, label: 'lever' },
  { re: /(^|\.)ashbyhq\.com$/, label: 'ashby' },
  { re: /(^|\.)teamtailor\.com$/, label: 'teamtailor' },
  { re: /(^|\.)recruitee\.com$/, label: 'recruitee' },
  { re: /(^|\.)smartrecruiters\.com$/, label: 'smartrecruiters' },
  { re: /(^|\.)workable\.com$/, label: 'workable' },
  { re: /(^|\.)jobylon\.com$/, label: 'jobylon' },
  { re: /(^|\.)myworkdayjobs\.com$/, label: 'workday' },
  { re: /(^|\.)icims\.com$/, label: 'icims' },
  { re: /(^|\.)jobvite\.com$/, label: 'jobvite' },
  { re: /(^|\.)bamboohr\.com$/, label: 'bamboohr' },
  { re: /(^|\.)breezy\.hr$/, label: 'breezy' },
  { re: /(^|\.)personio\.(de|com)$/, label: 'personio' },
  { re: /(^|\.)haileyhr\.app$/, label: 'hailey' },
  { re: /(^|\.)50skills\.(com|app)$/, label: '50skills' },
  { re: /(^|\.)pinpointhq\.com$/, label: 'pinpoint' },
  { re: /(^|\.)avature\.net$/, label: 'avature' },
  { re: /(^|\.)myworkdaysite\.com$/, label: 'workday-site' },
  { re: /(^|\.)successfactors\.(com|eu)$/, label: 'sap-successfactors' },
  { re: /(^|\.)taleo\.net$/, label: 'taleo' },
  { re: /(^|\.)oraclecloud\.com$/, label: 'oracle-cloud' },
  { re: /(^|\.)applytojob\.com$/, label: 'jazzhr' },
  { re: /(^|\.)comeet\.com$/, label: 'comeet' },
  { re: /(^|\.)join\.com$/, label: 'join' },
  { re: /(^|\.)workforcenow\.adp\.com$/, label: 'adp' },
  { re: /(^|\.)eightfold\.ai$/, label: 'eightfold' },
  { re: /(^|\.)gem\.com$/, label: 'gem' },
  { re: /(^|\.)zohorecruit\.(com|eu)$/, label: 'zoho-recruit' },
  { re: /(^|\.)freshteam\.com$/, label: 'freshteam' },
  { re: /(^|\.)factorialhr\.com$/, label: 'factorial' },
  { re: /(^|\.)rippling\.com$/, label: 'rippling' },
  { re: /(^|\.)paylocity\.com$/, label: 'paylocity' },
  { re: /(^|\.)ukg\.(com|net)$/, label: 'ukg' },
  { re: /(^|\.)hibob\.com$/, label: 'hibob' },
  { re: /(^|\.)pinpoint\.dev$/, label: 'pinpoint' },
  { re: /(^|\.)workday\.com$/, label: 'workday' },
  { re: /(^|\.)careerpuck\.com$/, label: 'careerpuck' },   // Pinpoint-hosted public boards
  { re: /(^|\.)hrmos\.co$/, label: 'hrmos' },              // BizReach / Japanese ATS
  { re: /(^|\.)huntflow\.(io|ru)$/, label: 'huntflow' },   // CIS ATS
];
// Aggregators / job boards: not a company's own ATS, so not a provider target.
const AGGREGATORS = [
  /(^|\.)linkedin\.com$/, /(^|\.)indeed\.com$/, /(^|\.)glassdoor\./,
  /(^|\.)ziprecruiter\.com$/, /(^|\.)hitmarker\.net$/, /(^|\.)workwithindies\.com$/,
  /(^|\.)remotegamejobs\.com$/, /(^|\.)builtin\.com$/, /(^|\.)wellfound\.com$/,
  /(^|\.)angel\.co$/, /(^|\.)otta\.com$/, /(^|\.)dice\.com$/, /(^|\.)monster\.com$/,
  /(^|\.)themuse\.com$/, /(^|\.)remotive\.com$/, /(^|\.)gracklehq\.com$/,
  /(^|\.)gamesjobsdirect\.com$/, /(^|\.)wayup\.com$/, /(^|\.)remoterocketship\.com$/,
  /(^|\.)gamejobs\.co$/, /(^|\.)ingamejob\.com$/, /(^|\.)remoteok\.com$/,
  /(^|\.)skillshot\.pl$/,
];
function hostOf(link) { try { return new URL(link).hostname.replace(/^www\./, ''); } catch { return null; } }
function regDomain(host) {
  const p = host.split('.');
  if (p.length <= 2) return host;
  const twoLevel = /^(co|com|org|net|gov|ac|edu|or)\.[a-z]{2}$/;
  return (twoLevel.test(p.slice(-2).join('.')) ? p.slice(-3) : p.slice(-2)).join('.');
}
// tallies for links detect() couldn't turn into a (provider, slug)
const unknownAts = new Map();   // platform label -> { companies:Set, jobs }
const customSites = new Map();  // registrable domain -> { companies:Set, jobs, sampleHost }
const aggregators = new Map();  // aggregator domain -> { companies:Set, jobs }
function bump(map, key, company, extra) {
  const m = map.get(key) || { companies: new Set(), jobs: 0, ...extra };
  m.companies.add(company); m.jobs++; map.set(key, m); return m;
}
function tallyUnknown(r) {
  const host = hostOf(r.jobLink);
  if (!host) { bump(customSites, '(unparseable)', r.companyName, { sampleHost: r.jobLink }); return; }
  if (AGGREGATORS.some(re => re.test(host))) { bump(aggregators, regDomain(host), r.companyName); return; }
  const plat = ATS_PLATFORMS.find(a => a.re.test(host));
  // `parsed` = we ship a provider for this ATS (derived from the registry, not a
  // hand-set flag). A parsed-platform link that still landed here is a parse miss.
  if (plat) { bump(unknownAts, plat.label, r.companyName, { parsed: MINED_IDS.has(plat.label) }); return; }
  bump(customSites, regDomain(host), r.companyName, { sampleHost: host });
}
function printUnknownReport(asJson) {
  const ats = [...unknownAts.entries()].map(([label, v]) => ({ platform: label, parsed: !!v.parsed, studios: v.companies.size, jobs: v.jobs })).sort((a, b) => b.studios - a.studios);
  const custom = [...customSites.entries()].map(([dom, v]) => ({ domain: dom, studios: v.companies.size, jobs: v.jobs, sampleHost: v.sampleHost })).sort((a, b) => b.jobs - a.jobs);
  const aggs = [...aggregators.entries()].map(([dom, v]) => ({ platform: dom, studios: v.companies.size, jobs: v.jobs })).sort((a, b) => b.jobs - a.jobs);
  if (asJson) { console.log(JSON.stringify({ unrecognizedAts: ats, customSites: custom, aggregators: aggs }, null, 1)); return; }
  console.log('\n=== Unrecognized ATS platforms (links we did NOT mine — provider candidates) ===');
  console.log('  studios = distinct companies seen on that platform | (mined) = a provider already covers it\n');
  for (const a of ats) console.log(`${String(a.studios).padStart(4)} studios  ${String(a.jobs).padStart(5)}j  ${a.platform}${a.parsed ? '  (mined — these are parse misses)' : ''}`);
  // Discovery heuristic: a true own-domain career site has exactly ONE company.
  // A "custom" domain shared by 2+ studios is almost certainly an unnamed shared
  // ATS or aggregator -> promote it to ATS_PLATFORMS/AGGREGATORS once confirmed.
  const suspectShared = custom.filter(c => c.studios >= 2 && c.domain !== '(unparseable)');
  if (suspectShared.length) {
    console.log('\n=== ⚑ Likely UNNAMED shared ATS / aggregator (custom domain w/ 2+ studios) ===');
    console.log('  investigate, then add to ATS_PLATFORMS or AGGREGATORS so it self-classifies next run\n');
    for (const c of suspectShared.sort((a, b) => b.studios - a.studios).slice(0, 25))
      console.log(`${String(c.studios).padStart(3)} studios  ${String(c.jobs).padStart(4)}j  ${c.domain}`);
  }
  console.log('\n=== Custom / own-domain career sites (top 40 by jobs; one provider each, low ROI) ===');
  for (const c of custom.slice(0, 40)) console.log(`${String(c.studios).padStart(3)}co  ${String(c.jobs).padStart(4)}j  ${c.domain}`);
  if (custom.length > 40) console.log(`(+${custom.length - 40} more custom domains)`);
  const aggTot = aggs.reduce((s, a) => s + a.jobs, 0);
  console.log(`\n=== Aggregators / job boards (ignored): ${aggs.length} hosts, ${aggTot} jobs ===`);
  for (const a of aggs.slice(0, 15)) console.log(`${String(a.jobs).padStart(5)}j  ${a.platform}`);
}

// group by provider+slug; links we can't parse get tallied for ATS discovery
const groups = new Map(); // key -> {p, slug, host, companies:Set, count, strongHits, weakHits, gamesHits, gamingCat, sampleTitle}
for (const r of jobs) {
  const d = detect(r.jobLink);
  if (!d) { tallyUnknown(r); continue; }
  const key = d.p + ':' + d.slug.toLowerCase();
  let g = groups.get(key);
  if (!g) { g = { p: d.p, slug: d.slug, host: d.host, label: d.label, careers_url: d.careers_url, companies: new Set(), count: 0, strongHits: 0, weakHits: 0, gamesHits: 0, gamingCat: 0, sampleTitle: r.title, sampleLink: r.jobLink }; groups.set(key, g); }
  g.companies.add(r.companyName);
  g.count++;
  const t = r.title || '';
  const strong = STRONG_GAMES.test(t);
  const weak = !strong && WEAK_GAMES.test(t);
  if (strong) g.strongHits++;
  if (weak) g.weakHits++;
  if (strong || weak) g.gamesHits++;
  if (r.companyCategory === 'Gaming Company') g.gamingCat++;
}

// --unknown: report the links detect() couldn't mine, then exit
if (process.argv.includes('--unknown')) { printUnknownReport(process.argv.includes('--json')); process.exit(0); }

// dedupe against tracked
const fresh = [];
let skipped = 0;
for (const g of groups.values()) {
  const slugL = g.slug.toLowerCase();
  const nameMatch = [...g.companies].some(c => tracked.names.has(norm(c)));
  if (tracked.slugs.has(slugL) || nameMatch) { skipped++; continue; }
  fresh.push(g);
}
// games signal score per group
for (const g of fresh) g.gamesFrac = g.gamesHits / g.count;

// --- phase 2: live feed validation -------------------------------------------
// Validation runs the SAME provider code scan.mjs uses: feed the mined careers_url
// (which the provider's own mineUrl produced) back into provider.fetch() and count
// the rows. Every per-ATS quirk — which JSON key holds the openings, how an empty
// board reads, pagination, the careers_url shape — therefore lives in exactly ONE
// place (providers/), never a parallel switch here that silently drifts out of sync.

// Live job count for a candidate group, or a short status string on failure
// (HTTP status number-as-string, or 'ERR <class>'). Returns a number on success
// so callers can keep testing `typeof n === 'number' && n > 0`.
async function validateLive(g) {
  if (!g.careers_url) return '?';                // provider didn't yield a careers_url
  const provider = (await providerRegistry()).get(g.p);
  if (!provider) return 'no-provider';
  // careers_url fully encodes the target (e.g. workday's {host}/{site}); the
  // provider re-derives anything else it needs from it — no per-ATS pinning here.
  const entry = { name: bestCompanyName(g), provider: g.p, careers_url: g.careers_url };
  try {
    const jobs = await provider.fetch(entry, HTTP_CTX);
    return Array.isArray(jobs) ? jobs.length : 0;
  } catch (err) {
    return err && err.status != null ? err.status : 'ERR ' + classifyFetchError(err);
  }
}

// --- auto-add: append high-confidence games studios to studios.yml -----------
// Both the careers_url and the dedup slug are carried on the group straight from
// the provider's mineUrl (no recipe table here). availableProviders is the set of
// provider ids that loaded+run, so the auto-add gate can't pass an unloadable one.
async function availableProviders() {
  return new Set((await providerRegistry()).keys());
}
// Off-theme employers ASGC still tags "Gaming Company" but this fork excludes:
// VFX/film/animation outsourcers (share titles like Technical Artist/Animator with
// games) and iGaming/gambling. Matched on company name; demotes to NOT-ADDED with a
// visible reason (fail-safe — never silently dropped). Tune as new namesakes appear.
const OFF_THEME = /\b(vfx|fx\b|visual ?effects|imageworks|cinesite|framestore|feature animation|animation studios?|casino|gambling|i-?gaming|sportsbook|betting|lottery|slots?|poker|wager)\b/i;

// High confidence = a strong games title on the board, or games titles are a
// majority. Identity is genuine by construction (the slug came from the company's
// OWN posting URL), so no namesake gate is needed here.
function isHighConfidence(g) {
  return g.strongHits >= 1 || (g.gamesHits / g.count) >= 0.5;
}
// Distinct studio identities on a slug. >1 = a shared/ambiguous board we won't
// auto-name (variant spellings of ONE company collapse to a single norm()).
function distinctIdentities(g) {
  return new Set([...g.companies].map(norm)).size;
}
function bestCompanyName(g) {
  // Prefer a human, multi-word spelling ("Companion Group") over the bare
  // concatenated slug-form ("Companiongroupltd"); among equals, longest wins
  // (most specific: "Amber Studio" over "Amber").
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
// Display slug for the report. A provider's mineUrl may supply a richer `label`
// (workday uses tenant/site); otherwise show the bare slug.
function dispSlug(g) {
  return g.label || decodeURIComponent(g.slug);
}

if (process.argv.includes('--add')) {
  const dry = process.argv.includes('--dry-run');
  const games = fresh.filter(isGamesCandidate);
  games.sort((a, b) => (b.gamesFrac - a.gamesFrac) || (b.count - a.count));
  const providers = await availableProviders();
  const excludes = loadExcludes();
  console.log('Auto-add: live-validating', games.length, 'games candidates against feeds...\n');
  const results = [];
  const CONC = 8;
  for (let i = 0; i < games.length; i += CONC) {
    const batch = games.slice(i, i + CONC);
    const res = await Promise.all(batch.map(g => validateLive(g)));
    batch.forEach((g, k) => results.push([g, res[k]]));
  }
  const today = new Date().toISOString().slice(0, 10);
  const added = [], skipped = [], entries = [], addedNorms = new Set();
  for (const [g, n] of results) {
    const co = bestCompanyName(g);
    const pid = g.p;
    const live = typeof n === 'number' && n > 0;
    let reason = null;
    const gamingShare = g.gamingCat / g.count;
    if (!g.careers_url) reason = `no careers_url mined for '${g.p}'`;
    else if (!providers.has(pid)) reason = `provider '${pid}' not in providers/`;
    else if (!live) reason = `feed not live (${n})`;
    else if (excludes.has(co.toLowerCase())) reason = 'in exclude_companies blocklist';
    else if (OFF_THEME.test(co)) reason = 'off-theme (VFX/film/iGaming)';
    else if (gamingShare < 0.5) reason = `not a tagged games studio (${Math.round(gamingShare * 100)}% gaming)`;
    else if (!isHighConfidence(g)) reason = `low confidence (s${g.strongHits}, frac ${g.gamesFrac.toFixed(2)})`;
    else if (distinctIdentities(g) > 1) reason = `ambiguous board (${distinctIdentities(g)} companies)`;
    else if (addedNorms.has(norm(co))) reason = 'duplicate within this run';
    if (reason) { skipped.push({ g, co, n, reason }); continue; }
    addedNorms.add(norm(co));
    const url = g.careers_url;
    entries.push(
      `  - name: ${yamlName(co)}\n` +
      `    provider: ${pid}\n` +
      `    careers_url: ${url}\n` +
      `    status: resolved\n` +
      `    notes: "ASGC-mined; ${pid}-confirmed live (${n} jobs, ${today}). Auto-added (high-confidence)."`
    );
    added.push({ g, co, n, url, pid });
  }
  console.log(`=== ADDED (${added.length}) ===`);
  for (const a of added)
    console.log(`+ ${a.pid.padEnd(15)} ${dispSlug(a.g).padEnd(24)} ${String(a.n).padStart(3)}j  ${a.co}`);
  console.log(`\n=== NOT ADDED (${skipped.length}) ===`);
  for (const s of skipped.sort((a, b) => a.reason.localeCompare(b.reason)))
    console.log(`- ${s.g.p.padEnd(15)} ${dispSlug(s.g).padEnd(24)} ${String(s.n).padStart(4)}  ${s.co}  — ${s.reason}`);
  if (!added.length) { console.log('\nNothing to add.'); process.exit(0); }
  if (dry) { console.log(`\n[dry-run] would append ${added.length} entries to studios.yml`); process.exit(0); }
  fs.appendFileSync(STUDIOS, `\n  # --- ASGC auto-added (${today}, high-confidence, live-validated) ---\n` + entries.join('\n') + '\n');
  console.log(`\nAppended ${added.length} entries to studios.yml`);
  process.exit(0);
}

if (process.argv.includes('--validate')) {
  for (const g of fresh) g.gamesFrac = g.gamesHits / g.count;
  const games = fresh.filter(isGamesCandidate);
  games.sort((a, b) => (b.gamesFrac - a.gamesFrac) || (b.count - a.count));
  console.log('Validating', games.length, 'games candidates against live feeds...\n');
  const live = [];
  const CONC = 8;
  for (let i = 0; i < games.length; i += CONC) {
    const batch = games.slice(i, i + CONC);
    const res = await Promise.all(batch.map(g => validateLive(g)));
    batch.forEach((g, k) => {
      const n = res[k];
      const ok = typeof n === 'number' && n > 0;
      const co = [...g.companies][0];
      console.log(`${ok ? 'LIVE' : 'dead'}  ${String(n).padStart(4)}  ${g.p.padEnd(15)} ${decodeURIComponent(g.slug).padEnd(26)} ${co}`);
      if (ok) live.push({ ...g, live: n, company: co });
    });
  }
  console.log('\n=== LIVE games studios (add these):', live.length, '===');
  for (const g of live) console.log(`${g.p}\t${decodeURIComponent(g.slug)}\t${g.live}\t${g.company}`);
  process.exit(0);
}

const games = fresh.filter(isGamesCandidate);
games.sort((a, b) => (b.gamesFrac - a.gamesFrac) || (b.count - a.count));

if (process.argv.includes('--json')) {
  const out = (process.argv.includes('--all') ? fresh : games);
  console.log(JSON.stringify(out.map(g => ({ provider: g.p, slug: g.slug, host: g.host, jobs: g.count, gamesFrac: +g.gamesFrac.toFixed(2), company: [...g.companies][0] })), null, 1));
} else {
  const byProv = {};
  for (const g of games) byProv[g.p] = (byProv[g.p] || 0) + 1;
  console.log('=== ASGC mining: GAMES-studio ATS slug candidates ===');
  console.log('total slug-groups:', groups.size, '| already-tracked:', skipped, '| fresh:', fresh.length, '| games-filtered:', games.length);
  console.log('games by provider:', byProv);
  console.log('\n--- games candidates (frac = games-title share; s/w = strong/weak title hits) ---');
  for (const g of games) {
    const co = [...g.companies][0];
    console.log(`${(g.gamesFrac).toFixed(2)}  ${String(g.count).padStart(3)}j  s${g.strongHits}/w${g.weakHits}  ${g.p.padEnd(15)} ${g.slug.padEnd(26)} ${co}`);
  }
  printUnknownReport(false);
}
