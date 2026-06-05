#!/usr/bin/env node
// Mine the ASGC board (asgc-jobs.json) for company -> ATS slug pairs.
// Extracts provider+slug from each jobLink hostname/path, groups by slug,
// dedupes against studios.yml, and prints candidates ranked by job count.
// Tokenless. Does NOT validate live feeds (that's phase 2 -- see --validate).
import fs from 'node:fs';
import path from 'node:path';

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
      } catch {}
    }
    m = line.match(/(?:slug|company_id|ashby_slug|gh_slug):\s*["']?(\S+?)["']?\s*$/);
    if (m) slugs.add(m[1].toLowerCase());
  }
  return { names, hosts, slugs };
}

function norm(s) {
  return String(s).toLowerCase()
    .replace(/\b(ab|inc|ltd|llc|gmbh|studios?|games?|interactive|entertainment|group|the|co)\b/g, '')
    .replace(/[^a-z0-9]/g, '');
}

// --- provider + slug extraction from a jobLink -------------------------------
function detect(link) {
  let u;
  try { u = new URL(link); } catch { return null; }
  const h = u.hostname.replace(/^www\./, '');
  const seg = u.pathname.split('/').filter(Boolean);

  // greenhouse: boards.greenhouse.io/{slug}, job-boards.greenhouse.io/{slug}, {slug}.greenhouse.io
  if (/(^|\.)greenhouse\.io$/.test(h)) {
    if (/^(boards|job-boards|boards-api)\.greenhouse\.io$/.test(h)) return seg[0] && { p: 'greenhouse', slug: seg[0] };
    const sub = h.replace(/\.greenhouse\.io$/, '');
    return sub && { p: 'greenhouse', slug: sub };
  }
  // lever US + EU
  if (/(^|\.)lever\.co$/.test(h)) {
    const eu = /(^|\.)eu\.lever\.co$/.test(h);
    return seg[0] && { p: eu ? 'lever-eu' : 'lever', slug: seg[0] };
  }
  // ashby
  if (/(^|\.)ashbyhq\.com$/.test(h)) return seg[0] && { p: 'ashby', slug: seg[0] };
  // teamtailor (subdomain only; custom domains unknowable from host)
  if (/(^|\.)teamtailor\.com$/.test(h)) {
    const sub = h.replace(/\.teamtailor\.com$/, '');
    return sub && sub !== 'teamtailor' && { p: 'teamtailor', slug: sub };
  }
  // recruitee
  if (/(^|\.)recruitee\.com$/.test(h)) {
    const sub = h.replace(/\.recruitee\.com$/, '');
    return sub && { p: 'recruitee', slug: sub };
  }
  // smartrecruiters: jobs.smartrecruiters.com/{slug}, careers.smartrecruiters.com/{slug}
  if (/(^|\.)smartrecruiters\.com$/.test(h)) return seg[0] && { p: 'smartrecruiters', slug: seg[0] };
  // workable: apply.workable.com/{slug}, {slug}.workable.com
  if (/(^|\.)workable\.com$/.test(h)) {
    if (/^apply\.workable\.com$/.test(h)) return seg[0] && { p: 'workable', slug: seg[0] };
    const sub = h.replace(/\.workable\.com$/, '');
    return sub && sub !== 'apply' && { p: 'workable', slug: sub };
  }
  // jobylon: emp.jobylon.com/companies/{id}-{slug} or /jobs/...
  if (/(^|\.)jobylon\.com$/.test(h)) {
    const ci = seg.indexOf('companies');
    if (ci >= 0 && seg[ci + 1]) {
      const id = seg[ci + 1].match(/^(\d+)/);
      if (id) return { p: 'jobylon', slug: id[1] };
    }
    return null;
  }
  // workday: {tenant}.{dc}.myworkdayjobs.com/...  (tenant = company)
  if (/(^|\.)myworkdayjobs\.com$/.test(h)) {
    const tenant = h.split('.')[0];
    return tenant && { p: 'workday', slug: tenant, host: h };
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

// games signal: title keywords that non-games employers almost never use
const GAMES_TITLE = /\b(game ?play|game ?designer|game ?director|game ?artist|game ?economy|level designer|technical artist|character artist|environment artist|vfx artist|3d artist|concept artist|animator|rigging|unreal|unity|game engine|gameplay|narrative designer|game ?writer|combat designer|systems designer|encounter designer|world builder|game producer|live ?ops|monetization|player support|community manager|qa tester|game qa|build engineer|tools (engineer|programmer)|graphics (engineer|programmer)|engine (engineer|programmer)|gameplay (engineer|programmer))\b/i;

// group by provider+slug
const groups = new Map(); // key -> {p, slug, host, companies:Set, count, gamesHits, gamingCat, sampleTitle}
for (const r of jobs) {
  const d = detect(r.jobLink);
  if (!d) continue;
  const key = d.p + ':' + d.slug.toLowerCase();
  let g = groups.get(key);
  if (!g) { g = { p: d.p, slug: d.slug, host: d.host, companies: new Set(), count: 0, gamesHits: 0, gamingCat: 0, sampleTitle: r.title, sampleLink: r.jobLink }; groups.set(key, g); }
  g.companies.add(r.companyName);
  g.count++;
  if (GAMES_TITLE.test(r.title || '')) g.gamesHits++;
  if (r.companyCategory === 'Gaming Company') g.gamingCat++;
}

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
async function fetchJson(url, opts = {}) {
  try {
    const r = await fetch(url, { headers: { 'user-agent': 'Mozilla/5.0', accept: 'application/json' }, signal: AbortSignal.timeout(12000), ...opts });
    if (!r.ok) return { ok: false, status: r.status };
    return { ok: true, json: await r.json() };
  } catch (e) { return { ok: false, status: 'ERR ' + (e.code || e.name || '') }; }
}
async function validateLive(g) {
  const slug = decodeURIComponent(g.slug);
  switch (g.p) {
    case 'greenhouse': {
      const r = await fetchJson(`https://boards-api.greenhouse.io/v1/boards/${slug}/jobs`);
      return r.ok ? (r.json.jobs?.length || 0) : r.status;
    }
    case 'lever': case 'lever-eu': {
      const host = g.p === 'lever-eu' ? 'api.eu.lever.co' : 'api.lever.co';
      const r = await fetchJson(`https://${host}/v0/postings/${slug}?mode=json`);
      return r.ok ? (Array.isArray(r.json) ? r.json.length : 0) : r.status;
    }
    case 'ashby': {
      const r = await fetchJson(`https://api.ashbyhq.com/posting-api/job-board/${slug}`);
      return r.ok ? (r.json.jobs?.length || 0) : r.status;
    }
    case 'teamtailor': {
      const r = await fetchJson(`https://${slug}.teamtailor.com/jobs.json`);
      return r.ok ? (r.json.data?.length ?? (Array.isArray(r.json) ? r.json.length : 0)) : r.status;
    }
    case 'recruitee': {
      const r = await fetchJson(`https://${slug}.recruitee.com/api/offers/`);
      return r.ok ? (r.json.offers?.length || 0) : r.status;
    }
    case 'smartrecruiters': {
      const r = await fetchJson(`https://api.smartrecruiters.com/v1/companies/${slug}/postings`);
      return r.ok ? (typeof r.json.totalFound === 'number' ? r.json.totalFound : 0) : r.status;
    }
    case 'workable': {
      const r = await fetchJson(`https://apply.workable.com/api/v1/widget/accounts/${slug}?details=true`);
      return r.ok ? (r.json.jobs?.length || 0) : r.status;
    }
    case 'workday': return 'manual';
    default: return '?';
  }
}

if (process.argv.includes('--validate')) {
  for (const g of fresh) g.gamesFrac = g.gamesHits / g.count;
  const games = fresh.filter(g => g.gamesHits >= 1 && (g.gamesFrac >= 0.34 || (g.gamingCat === g.count && g.count <= 30)));
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

// A likely games studio: real game-dev job titles present and a meaningful share,
// OR small board fully tagged Gaming Company with at least one game-dev title.
const games = fresh.filter(g => g.gamesHits >= 1 && (g.gamesFrac >= 0.34 || (g.gamingCat === g.count && g.count <= 30)));
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
  console.log('\n--- games candidates (frac = games-title share) ---');
  for (const g of games) {
    const co = [...g.companies][0];
    console.log(`${(g.gamesFrac).toFixed(2)}  ${String(g.count).padStart(3)}j  ${g.p.padEnd(15)} ${g.slug.padEnd(26)} ${co}`);
  }
}
