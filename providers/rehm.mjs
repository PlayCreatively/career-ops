// @ts-check
/** @typedef {import('./_types.js').Provider} Provider */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { toIsoDate, normalizeWorkMode } from './_util.mjs';

// alexanderrehm.com games-jobs provider — a curated games-industry aggregator
// (https://www.alexanderrehm.com/jobs.html). Like Hitmarker, ONE tracked entry
// yields postings across many studios. Its public, keyless feed lives at
// {origin}/jobs.json; each record carries source_ats + source_studio +
// source_url (the studio's real ATS apply URL).
//
//   tracked_companies:
//     - name: Rehm — uncovered ATS (games)
//       provider: rehm
//       # scope: uncovered   # (default) only studios on an ATS we DON'T ship a
//       #                     # provider for — the complementary long tail
//       #                     # (hrmos, ea-careers, comeet, phenom, garena, …).
//       # scope: all         # every games posting in the feed (overlaps direct feeds)
//       # query: "gameplay"  # optional case-insensitive title filter
//
// WHY scope to uncovered ATS by default: rehm exposes the REAL source_url, so its
// rows look "direct" to dedupeSnapshot. Pass-1 dedup (company+req-id) only
// collapses numeric-ID ATSes (greenhouse/teamtailor/recruitee); lever/ashby/
// workable use non-numeric IDs and would double-count against our own feeds.
// Emitting only ATSes we DON'T scan directly removes the overlap by construction.
// The covered set is DERIVED from the providers/ directory (no hardcoded list),
// so adding a provider automatically shrinks rehm's scope next run.
//
// WHY the provider self-filters blocked/off-theme employers: scan.mjs gates
// exclude_companies to aggregator HOSTS, but rehm rows carry real ATS hosts, so
// the pipeline treats them as direct and never applies the blocklist. We apply it
// here (read from studios.yml) plus an off-theme guard, mirroring mine-rehm.mjs.

const REHM_FEED = 'https://www.alexanderrehm.com/jobs.json';
const REHM_HOST = 'alexanderrehm.com';
// The site 403s a bare fetch; a browser UA is required.
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const STUDIOS = path.join(HERE, '..', 'studios.yml');

// Provider ids we ship = the ATS names rehm marks as source_ats that we already
// scan first-party. Derived from the providers/ directory at call time.
function coveredAts() {
  const set = new Set();
  try {
    for (const f of fs.readdirSync(HERE)) {
      if (f.endsWith('.mjs') && !f.startsWith('_') && f !== 'rehm.mjs') set.add(f.slice(0, -4));
    }
  } catch { /* unreadable dir — empty set means "nothing covered" (rehm emits all) */ }
  return set;
}

// exclude_companies from studios.yml (best-effort). Fail-safe: unreadable file or
// absent block blocks nothing.
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

const blockNorm = (s) => String(s).toLowerCase().replace(/[^a-z0-9]/g, '');
// Exact (like scan.mjs) OR a specific (>=6 char) blocklist token inside the
// despaced company name, so slug/variant spellings ("yggdrasilsandbox") resolve.
function isBlocked(company, excludes) {
  if (!company) return false;
  if (excludes.has(company.toLowerCase())) return true;
  const cn = blockNorm(company);
  for (const e of excludes) { const en = blockNorm(e); if (en.length >= 6 && cn.includes(en)) return true; }
  return false;
}
const OFF_THEME = /\b(vfx|fx\b|visual ?effects|imageworks|cinesite|framestore|feature animation|animation studios?|casino|gambling|i-?gaming|sportsbook|betting|lottery|slots?|poker|wager)\b/i;
const OFF_THEME_GLUED = /(vfx|visualeffects|imageworks|cinesite|framestore)/;
function isOffTheme(company) { return OFF_THEME.test(company || '') || OFF_THEME_GLUED.test(blockNorm(company)); }

// One fetch per process — multiple rehm entries (e.g. scoped queries) reuse it.
let _feedCache = null;
async function loadFeed(ctx) {
  if (_feedCache) return _feedCache;
  const json = await ctx.fetchJson(REHM_FEED, { headers: { 'user-agent': UA }, redirect: 'error' });
  _feedCache = Array.isArray(json) ? json : (json && Array.isArray(json.records) ? json.records : []);
  return _feedCache;
}

/** @type {Provider} */
export default {
  id: 'rehm',

  // Opt-in via `provider: rehm`; also claim a pasted alexanderrehm.com URL.
  detect(entry) {
    let host;
    try { host = new URL(entry.careers_url || '').hostname.toLowerCase(); } catch { return null; }
    return host === REHM_HOST || host.endsWith('.' + REHM_HOST) ? { url: REHM_FEED } : null;
  },

  async fetch(entry, ctx) {
    const records = await loadFeed(ctx);
    const scope = entry.scope === 'all' ? 'all' : 'uncovered';
    const covered = scope === 'uncovered' ? coveredAts() : new Set();
    const excludes = loadExcludes();
    const q = typeof entry.query === 'string' && entry.query.trim() ? entry.query.trim().toLowerCase() : '';

    const jobs = [];
    for (const r of records) {
      if (!r || !r.title || !r.source_url) continue;
      if (scope === 'uncovered' && covered.has(r.source_ats)) continue; // we scan this ATS directly
      const company = r.company || '';
      if (isBlocked(company, excludes) || isOffTheme(company)) continue;
      if (q && !String(r.title).toLowerCase().includes(q)) continue;
      const postedDate = toIsoDate(r.posted_at);
      const workMode = normalizeWorkMode(r.workplace) || (r.remote ? 'remote' : '');
      jobs.push({
        title: String(r.title),
        url: String(r.source_url),
        company: String(company),
        location: typeof r.location === 'string' ? r.location : '',
        ...(postedDate ? { postedDate } : {}),
        ...(workMode ? { workMode } : {}),
        ...(r.department ? { department: String(r.department) } : {}),
      });
    }
    return jobs;
  },
};
