// Recover careers_url for every ledger hit (data/probe-state.tsv).
//
// The ledger records name + hit_ats but NOT the careers_url (that only lived in
// the per-run live snapshot, which is cleared each run). This re-derives the URL
// by replaying the provider's probe endpoints against the studio's slug
// candidates and keeping the first one that returns real jobs — which also
// VALIDATES the hit (a dead slug / namesake returns nothing or foreign content).
//
// Usage: node probe/recover-hits.mjs            # all hits
//        node probe/recover-hits.mjs verify     # only verify-tier (needs review)
//        node probe/recover-hits.mjs medium     # only trusted-tier

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(SCRIPT_DIR, '..');
const LEDGER = resolve(REPO_ROOT, 'data/probe-state.tsv');

const tierFilter = process.argv[2] || '';

// Mirror of probe-studios.mjs nameSlugs (kept inline to avoid import side effects).
function nameSlugs(name) {
  const base = name.toLowerCase().replace(/\(.*?\)/g, '').trim();
  const alnum = base.replace(/[^a-z0-9]+/g, '');
  const hyphen = base.replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  const noSuffix = base.replace(/\b(studios?|games?|interactive|entertainment|the|group)\b/g, '').trim().replace(/[^a-z0-9]+/g, '');
  return [...new Set([alnum, hyphen, noSuffix].filter(s => s && s.length >= 4))];
}

async function getJson(url) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 12000);
  try {
    const res = await fetch(url, { signal: ctrl.signal, redirect: 'manual', headers: { 'User-Agent': 'Mozilla/5.0', Accept: 'application/json' } });
    if (res.status < 200 || res.status >= 300) return { status: res.status, data: null };
    const text = await res.text();
    try { return { status: res.status, data: JSON.parse(text) }; }
    catch { return { status: res.status, data: null }; }
  } catch (e) {
    return { status: 0, data: null, err: String(e.message || e) };
  } finally { clearTimeout(t); }
}

// Pull a few sample job titles + locations from any ATS shape, to eyeball whether
// the tenant is really this game studio vs. a namesake.
function sampleTitles(data) {
  const arr = Array.isArray(data) ? data
    : Array.isArray(data?.jobs) ? data.jobs
    : Array.isArray(data?.content) ? data.content
    : [];
  return arr.slice(0, 4).map(j => {
    const title = j.title || j.name || j.text || j.jobTitle || '';
    const loc = j.location?.name || j.location?.city || j.location || j.categories?.location || j.locationName || '';
    return `${title}${loc ? ' — ' + loc : ''}`.trim();
  }).filter(Boolean);
}

const rows = readFileSync(LEDGER, 'utf-8').split('\n').filter(l => l && !l.startsWith('#'));
const hits = [];
for (const line of rows) {
  const [name_norm, name, , hit_ats, , , conf] = line.split('\t');
  if (!hit_ats) continue;
  if (tierFilter && (conf || 'legacy') !== tierFilter) continue;
  for (const ats of hit_ats.split(',').filter(Boolean)) hits.push({ name_norm, name, ats, conf: conf || 'legacy' });
}

console.error(`Recovering ${hits.length} hits${tierFilter ? ` (tier=${tierFilter})` : ''}...`);
const out = [];
for (const h of hits) {
  let prov;
  try { prov = await import(`../providers/${h.ats}.mjs`); }
  catch { out.push({ ...h, careers_url: null, reason: 'no-provider-module' }); continue; }
  const desc = prov.probe;
  if (!desc) { out.push({ ...h, careers_url: null, reason: 'no-probe-descriptor' }); continue; }
  const slugs = desc.slugs ? desc.slugs(h.name) : nameSlugs(h.name);
  let resolved = null;
  outer:
  for (const ep of desc.endpoints) {
    if (ep.kind !== 'slug') continue; // skip domain-sweep endpoints; need the studio's own host
    for (const slug of slugs) {
      const { data } = await getJson(ep.url(slug));
      const parsed = data == null ? null : ep.parse(data);
      if (parsed && parsed.count > 0) {
        resolved = { careers_url: ep.careersUrl(slug), where: ep.where(slug), count: parsed.count, loc: parsed.loc, samples: sampleTitles(data) };
        break outer;
      }
    }
  }
  if (resolved) out.push({ ...h, ...resolved });
  else out.push({ ...h, careers_url: null, reason: 'no-live-feed (dead slug / empty / namesake gone)' });
  await new Promise(r => setTimeout(r, 150));
}

console.log(JSON.stringify(out, null, 2));
const live = out.filter(o => o.careers_url);
console.error(`\nResolved ${live.length}/${out.length} to a live feed.`);
