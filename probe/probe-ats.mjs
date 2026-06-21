#!/usr/bin/env node

/**
 * probe-ats.mjs — Given a list of company names, guess their ATS board.
 *
 * For each company it generates slug candidates from the name and probes the
 * public, keyless feed endpoints of the four ATS we have providers for:
 *   - Greenhouse  boards-api.greenhouse.io/v1/boards/{slug}/jobs
 *   - Lever       api.lever.co/v0/postings/{slug}?mode=json
 *   - Ashby       api.ashbyhq.com/posting-api/job-board/{slug}
 *   - Teamtailor  {slug}.teamtailor.com/jobs.json  (custom domains won't match —
 *                 those need manual lookup, so a Teamtailor miss isn't conclusive)
 *
 * First responding endpoint wins. Companies with no hit are emitted under
 * "misses" for manual / browser research.
 *
 * This is a mining utility, NOT a provider — it lives in root and is never
 * loaded by scan.mjs. Run it ad-hoc when extending studio coverage.
 *
 * Usage:
 *   node probe-ats.mjs                # probe the built-in candidate list
 *   node probe-ats.mjs --json         # machine-readable output
 */

const TIMEOUT_MS = 12000;
const CONCURRENCY = 6;

// ── Candidate studios (not already in portals.yml), weighted to the
//    user's Nordic / UK / EU games niche. {name, [explicit slug hints]}.
//    Explicit hints are tried first; name-derived slugs are tried after.
const CANDIDATES = [
  // ── Nordic ──
  { name: 'Arrowhead Game Studios', hints: ['arrowheadgamestudios', 'arrowhead'] },
  { name: 'Hazelight Studios', hints: ['hazelight'] },
  { name: 'Ghost Ship Games', hints: ['ghostshipgames', 'ghostship'] },
  { name: 'Funcom', hints: ['funcom'] },
  { name: 'Remedy Entertainment', hints: ['remedy', 'remedyentertainment'] },
  { name: 'Housemarque', hints: ['housemarque'] },
  { name: 'Colossal Order', hints: ['colossalorder'] },
  { name: 'Stunlock Studios', hints: ['stunlock', 'stunlockstudios'] },
  { name: 'Snowprint Studios', hints: ['snowprint', 'snowprintstudios'] },
  { name: 'MAG Interactive', hints: ['maginteractive', 'mag'] },
  { name: 'Liquid Swords', hints: ['liquidswords'] },
  { name: 'The Outsiders', hints: ['theoutsiders', 'outsiders'] },
  { name: 'Fall Damage', hints: ['falldamage'] },
  { name: 'Might and Delight', hints: ['mightanddelight'] },
  { name: 'Goodbye Kansas', hints: ['goodbyekansas'] },
  { name: 'Enad Global 7 (EG7)', hints: ['eg7', 'enadglobal7'] },
  { name: 'Redhill Games', hints: ['redhillgames', 'redhill'] },
  { name: 'Frozenbyte', hints: ['frozenbyte'] },
  { name: 'Tuxedo Labs', hints: ['tuxedolabs'] },
  // ── UK / Ireland ──
  { name: 'Cloud Imperium Games', hints: ['cloudimperiumgames', 'cig', 'cloudimperium'] },
  { name: 'Jagex', hints: ['jagex'] },
  { name: 'Frontier Developments', hints: ['frontier', 'frontierdevelopments'] },
  { name: 'Rebellion', hints: ['rebellion'] },
  { name: 'Splash Damage', hints: ['splashdamage'] },
  { name: 'Sumo Digital', hints: ['sumodigital', 'sumo'] },
  { name: 'Supermassive Games', hints: ['supermassive', 'supermassivegames'] },
  { name: 'nDreams', hints: ['ndreams'] },
  { name: 'Bossa Studios', hints: ['bossa', 'bossastudios'] },
  { name: 'Kwalee', hints: ['kwalee'] },
  { name: 'Tripledot Studios', hints: ['tripledot', 'tripledotstudios'] },
  { name: 'Space Ape Games', hints: ['spaceape', 'spaceapegames'] },
  { name: 'Hutch Games', hints: ['hutch', 'hutchgames'] },
  // ── EU (non-Nordic) ──
  { name: 'CD Projekt Red', hints: ['cdprojektred', 'cdprojekt', 'cdpr'] },
  { name: '11 bit studios', hints: ['11bitstudios', '11bit'] },
  { name: 'Techland', hints: ['techland'] },
  { name: 'People Can Fly', hints: ['peoplecanfly'] },
  { name: 'Bloober Team', hints: ['blooberteam', 'bloober'] },
  { name: 'Saber Interactive', hints: ['saber', 'saberinteractive'] },
  { name: 'Crytek', hints: ['crytek'] },
  { name: 'Yager', hints: ['yager'] },
  { name: 'InnoGames', hints: ['innogames'] },
  { name: 'Kolibri Games', hints: ['kolibrigames', 'kolibri'] },
  { name: 'Klang Games', hints: ['klang', 'klanggames'] },
  { name: 'Sandbox Interactive', hints: ['sandboxinteractive', 'sandbox'] },
  { name: "Don't Nod", hints: ['dontnod', 'dont-nod'] },
  { name: 'Amplitude Studios', hints: ['amplitude', 'amplitudestudios'] },
  { name: 'Sloclap', hints: ['sloclap'] },
  { name: 'Shiro Games', hints: ['shirogames', 'shiro'] },
  { name: 'Focus Entertainment', hints: ['focusentertainment', 'focus'] },
  // ── Global / mobile (clean ATS likely) ──
  { name: 'Niantic', hints: ['niantic'] },
  { name: 'Supercell', hints: ['supercell'] },
  { name: 'Wooga', hints: ['wooga'] },
  { name: 'Dream Games', hints: ['dreamgames', 'dream'] },
  { name: 'Tripledot', hints: ['tripledot'] },
  { name: 'PlaySide Studios', hints: ['playside', 'playsidestudios'] },
];

// ── Slug generation ─────────────────────────────────────────────────
function nameSlugs(name) {
  const base = name.toLowerCase().replace(/\(.*?\)/g, '').trim();
  const alnum = base.replace(/[^a-z0-9]+/g, '');
  const hyphen = base.replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  const noSuffix = base.replace(/\b(studios?|games?|interactive|entertainment|the)\b/g, '').trim();
  const noSuffixAlnum = noSuffix.replace(/[^a-z0-9]+/g, '');
  return [...new Set([alnum, hyphen, noSuffixAlnum].filter(Boolean))];
}

// ── HTTP with timeout ───────────────────────────────────────────────
async function getJson(url) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: { 'User-Agent': 'Mozilla/5.0', Accept: 'application/json' },
    });
    if (!res.ok) return { ok: false, status: res.status };
    const text = await res.text();
    try { return { ok: true, status: res.status, data: JSON.parse(text) }; }
    catch { return { ok: false, status: res.status, nonJson: true }; }
  } catch (err) {
    return { ok: false, error: err.name === 'AbortError' ? 'timeout' : err.message };
  } finally {
    clearTimeout(t);
  }
}

// ── Per-ATS probes — return {count} on a real hit, null otherwise ────
async function probeGreenhouse(slug) {
  const r = await getJson(`https://boards-api.greenhouse.io/v1/boards/${slug}/jobs`);
  if (r.ok && Array.isArray(r.data?.jobs)) return { count: r.data.jobs.length };
  return null;
}
async function probeLever(slug) {
  const r = await getJson(`https://api.lever.co/v0/postings/${slug}?mode=json`);
  if (r.ok && Array.isArray(r.data)) return { count: r.data.length };
  return null;
}
async function probeAshby(slug) {
  const r = await getJson(`https://api.ashbyhq.com/posting-api/job-board/${slug}`);
  if (r.ok && Array.isArray(r.data?.jobs)) return { count: r.data.jobs.length };
  return null;
}
async function probeTeamtailor(slug) {
  const r = await getJson(`https://${slug}.teamtailor.com/jobs.json`);
  if (r.ok && (Array.isArray(r.data?.items) || Array.isArray(r.data))) {
    const count = Array.isArray(r.data?.items) ? r.data.items.length : r.data.length;
    return { count };
  }
  return null;
}

const ATS = [
  { id: 'greenhouse', probe: probeGreenhouse, api: s => `https://boards-api.greenhouse.io/v1/boards/${s}/jobs`, careers: s => `https://job-boards.greenhouse.io/${s}` },
  { id: 'lever', probe: probeLever, careers: s => `https://jobs.lever.co/${s}` },
  { id: 'ashby', probe: probeAshby, careers: s => `https://jobs.ashbyhq.com/${s}` },
  { id: 'teamtailor', probe: probeTeamtailor, careers: s => `https://${s}.teamtailor.com` },
];

async function probeCompany(c) {
  const slugs = [...new Set([...(c.hints || []), ...nameSlugs(c.name)])];
  for (const slug of slugs) {
    for (const ats of ATS) {
      const hit = await ats.probe(slug);
      if (hit) return { name: c.name, ats: ats.id, slug, count: hit.count, ats_def: ats };
    }
  }
  return { name: c.name, ats: null, slugsTried: slugs };
}

async function runPool(items, worker, limit) {
  const out = [];
  let i = 0;
  async function next() {
    while (i < items.length) {
      const idx = i++;
      out[idx] = await worker(items[idx]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, next));
  return out;
}

async function main() {
  const json = process.argv.includes('--json');
  const results = await runPool(CANDIDATES, probeCompany, CONCURRENCY);
  const hits = results.filter(r => r.ats);
  const misses = results.filter(r => !r.ats);

  if (json) {
    console.log(JSON.stringify({ hits, misses }, null, 2));
    return;
  }

  console.log(`\n=== HITS (${hits.length}) — add these to portals.yml ===`);
  for (const h of hits) {
    const careers = h.ats_def.careers(h.slug);
    const api = h.ats_def.api ? h.ats_def.api(h.slug) : '';
    console.log(`  ✅ ${h.name}  →  ${h.ats} [${h.slug}] (${h.count} jobs)`);
    console.log(`       careers_url: ${careers}${api ? `\n       api: ${api}` : ''}`);
  }
  console.log(`\n=== MISSES (${misses.length}) — log for manual research ===`);
  for (const m of misses) {
    console.log(`  ❔ ${m.name}  (tried: ${m.slugsTried.join(', ')})`);
  }
}

main().catch(e => { console.error('Fatal:', e); process.exit(1); });
