#!/usr/bin/env node
// Comprehensive ATS discovery probe. Unlike probe-ats.mjs (greenhouse/lever/
// ashby/teamtailor-subdomain only) this probes EVERY ATS we have a provider for,
// including custom-domain Teamtailor/Recruitee, Lever EU, SmartRecruiters and
// Workable. It also DEDUPES against studios.yml (skips already-tracked studios)
// and tags each hit with a confidence so namesake-prone single-word slug hits
// (greenhouse/lever/ashby) are flagged rather than trusted blindly.
//
// Usage:
//   node probe-studios.mjs --names file.txt      # one "Name" or "Name|domain.com" per line
//   node probe-studios.mjs --backlog             # probe studios.yml's own backlog
//                                                #   (status: unresolved + recipe kind browser/unresolved)
//   node probe-studios.mjs --backlog --include-blocked  # also re-probe kind: blocked
//   node probe-studios.mjs --wikipedia-sweden     # pull the Wikipedia SE list
//   node probe-studios.mjs --names f.txt --json   # machine-readable
//   ... --quick                                   # slug-only ATS (skip custom-domain sweep)
//
// Tag-aware dedup: only studios that are actually SCANNABLE (real provider /
// recipe json|html / parser / api / careers_url ATS) count as "already tracked"
// and are skipped. Backlog entries (status: unresolved, recipe kind
// blocked|browser|unresolved) are NOT skipped — they're the whole point of
// re-probing, and live IN studios.yml. Mirrors track-check.mjs's classification.

import { readFileSync, existsSync } from 'node:fs';
import yaml from 'js-yaml';

const TIMEOUT_MS = 7000;
const CONCURRENCY = 16;
const QUICK = process.argv.includes('--quick');
const JSON_OUT = process.argv.includes('--json');
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

// ── slug + domain generation ────────────────────────────────────────
function nameSlugs(name) {
  const base = name.toLowerCase().replace(/\(.*?\)/g, '').trim();
  const alnum = base.replace(/[^a-z0-9]+/g, '');
  const hyphen = base.replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  const noSuffix = base.replace(/\b(studios?|games?|interactive|entertainment|the|group)\b/g, '').trim().replace(/[^a-z0-9]+/g, '');
  return [...new Set([alnum, hyphen, noSuffix].filter(s => s && s.length >= 4))];
}
function srSlugs(name) { // SmartRecruiters slugs are case-sensitive
  const a = name.replace(/[^A-Za-z0-9]+/g, '');
  return [...new Set([a, a.toUpperCase(), name.replace(/[^A-Za-z0-9]+/g, '')])];
}
function domainGuesses(name, domains) {
  if (domains && domains.length) return domains;
  const a = name.toLowerCase().replace(/\(.*?\)/g, '').replace(/[^a-z0-9]+/g, '');
  const ns = name.toLowerCase().replace(/\b(studios?|games?|interactive|entertainment|the|group)\b/g, '').replace(/[^a-z0-9]+/g, '');
  const stems = [...new Set([a, ns].filter(s => s && s.length >= 3))];
  return stems.flatMap(s => TLDS.map(t => `${s}.${t}`));
}

// ── HTTP ────────────────────────────────────────────────────────────
async function get(url, json = true) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: ctrl.signal, redirect: 'follow', headers: { 'User-Agent': 'Mozilla/5.0', Accept: json ? 'application/json' : '*/*' } });
    if (!res.ok) return null;
    const text = await res.text();
    if (!json) return text;
    try { return JSON.parse(text); } catch { return null; }
  } catch { return null; } finally { clearTimeout(t); }
}
const GENERIC = /^(the|game|games|studio|play|fun|echo|grin|ghost|mirage|upside|overflow|pathos|brimstone|foxglove|carbon|merge|linear|render|sun|moon|core|solid|focus|frontier|niantic)$/;

// ── ATS probes (return {ats, where, count, confidence, loc}) ─────────
async function pSlugATS(slug) {
  // greenhouse / lever US+EU / ashby — generic single-word slug → namesake risk
  const conf = (slug.length >= 6 && !GENERIC.test(slug)) ? 'medium' : 'verify';
  let d = await get(`https://boards-api.greenhouse.io/v1/boards/${slug}/jobs`);
  if (d && Array.isArray(d.jobs)) return { ats: 'greenhouse', where: slug, count: d.jobs.length, confidence: conf, loc: d.jobs[0]?.location?.name || '' };
  for (const [host, id] of [['api.lever.co', 'lever'], ['api.eu.lever.co', 'lever-eu']]) {
    d = await get(`https://${host}/v0/postings/${slug}?mode=json`);
    if (Array.isArray(d)) return { ats: id, where: slug, count: d.length, confidence: conf, loc: d[0]?.categories?.location || '' };
  }
  d = await get(`https://api.ashbyhq.com/posting-api/job-board/${slug}`);
  if (d && Array.isArray(d.jobs)) return { ats: 'ashby', where: slug, count: d.jobs.length, confidence: conf, loc: d.jobs[0]?.location || '' };
  return null;
}
async function pTeamtailorSub(slug) {
  const d = await get(`https://${slug}.teamtailor.com/jobs.json`);
  const items = Array.isArray(d?.items) ? d.items : null;
  if (items && typeof d.version === 'string' && d.version.includes('jsonfeed')) return { ats: 'teamtailor', where: `${slug}.teamtailor.com`, count: items.length, confidence: 'medium', loc: '' };
  return null;
}
async function pRecruiteeSub(slug) {
  const d = await get(`https://${slug}.recruitee.com/api/offers/`);
  if (d && Array.isArray(d.offers)) return { ats: 'recruitee', where: `${slug}.recruitee.com`, count: d.offers.length, confidence: 'medium', loc: d.offers[0]?.location || '' };
  return null;
}
async function pWorkable(slug) {
  const d = await get(`https://apply.workable.com/api/v1/widget/accounts/${slug}?details=true`);
  if (d && Array.isArray(d.jobs)) return { ats: 'workable', where: `apply.workable.com/${slug}`, count: d.jobs.length, confidence: 'medium', loc: d.jobs[0]?.location?.location_str || '' };
  return null;
}
async function pSmartRecruiters(slug) {
  // SmartRecruiters' /postings returns 200 {totalFound:0, content:[]} for ANY
  // slug (no 404), so a 0-job result is indistinguishable from a fake. Only a
  // count>0 result proves the company exists. (Real-but-empty SR boards can't be
  // confirmed by slug-guessing and are intentionally missed here.)
  const d = await get(`https://api.smartrecruiters.com/v1/companies/${slug}/postings?limit=10`);
  const n = typeof d?.totalFound === 'number' ? d.totalFound : (Array.isArray(d?.content) ? d.content.length : 0);
  if (n > 0) return { ats: 'smartrecruiters', where: slug, count: n, confidence: 'medium', loc: d.content[0]?.location?.city || '' };
  return null;
}
async function pCustomDomain(domain) { // Teamtailor / Recruitee on the studio's OWN domain → HIGH confidence
  for (const prefix of PREFIXES) {
    const host = `${prefix}.${domain}`;
    const tt = await get(`https://${host}/jobs.json`);
    if (Array.isArray(tt?.items) && typeof tt.version === 'string' && tt.version.includes('jsonfeed'))
      return { ats: 'teamtailor', where: host, count: tt.items.length, confidence: 'high', loc: '' };
    const rc = await get(`https://${host}/api/offers/`);
    if (rc && Array.isArray(rc.offers))
      return { ats: 'recruitee', where: host, count: rc.offers.length, confidence: 'high', loc: rc.offers[0]?.location || '' };
  }
  return null;
}

async function probe(entry, tracked) {
  if (tracked.names.has(norm(entry.name))) return { name: entry.name, skipped: 'already in studios.yml' };
  // 1) cheap slug-based ATS first
  for (const slug of nameSlugs(entry.name)) {
    for (const fn of [pSlugATS, pTeamtailorSub, pRecruiteeSub, pWorkable]) {
      const hit = await fn(slug);
      if (hit) return finalize(entry, hit, tracked);
    }
  }
  for (const s of srSlugs(entry.name)) { const hit = await pSmartRecruiters(s); if (hit) return finalize(entry, hit, tracked); }
  // 2) custom-domain sweep (skipped in --quick)
  if (!QUICK) {
    for (const domain of domainGuesses(entry.name, entry.domains)) {
      const hit = await pCustomDomain(domain);
      if (hit) return finalize(entry, hit, tracked);
    }
  }
  return { name: entry.name, ats: null };
}
function finalize(entry, hit, tracked) {
  if (tracked.hosts.has(hit.where.replace(/^www\./, '').split('/')[0])) return { name: entry.name, skipped: `host ${hit.where} already tracked` };
  return { name: entry.name, ...hit };
}

// ── input loading ───────────────────────────────────────────────────
async function loadNames() {
  const out = [];
  if (process.argv.includes('--wikipedia-sweden')) {
    const r = await get('https://en.wikipedia.org/w/api.php?action=parse&page=List_of_video_game_companies_of_Sweden&format=json&prop=wikitext');
    const wt = r?.parse?.wikitext?.['*'] || '';
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

const tracked = loadTracked();
const names = await loadNames();
process.stderr.write(`Probing ${names.length} studios (${QUICK ? 'quick' : 'full'}); ${tracked.names.size} scannable, skipped...\n`);
const results = await runPool(names, e => probe(e, tracked), CONCURRENCY);
const hits = results.filter(r => r.ats);
const skipped = results.filter(r => r.skipped);
const order = { high: 0, medium: 1, verify: 2 };
hits.sort((a, b) => order[a.confidence] - order[b.confidence]);
if (JSON_OUT) { console.log(JSON.stringify({ hits, skippedCount: skipped.length, total: names.length }, null, 2)); }
else {
  console.log(`\n=== NEW HITS (${hits.length}) — not already in studios.yml ===`);
  for (const h of hits) console.log(`  [${h.confidence.toUpperCase().padEnd(6)}] ${h.name.padEnd(28)} ${h.ats.padEnd(15)} ${h.where}  (${h.count} jobs${h.loc ? ', e.g. ' + h.loc : ''})`);
  console.log(`\nSkipped ${skipped.length} already-tracked · ${names.length - hits.length - skipped.length} no feed found.`);
  console.log('HIGH = own-domain match (trust). MEDIUM = name-specific slug. VERIFY = generic slug (namesake risk — check the location).');
}
