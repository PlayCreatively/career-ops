// @ts-check
/** @typedef {import('./_types.js').Provider} Provider */

import { toIsoDate } from './_util.mjs';
import { parseJobPostingLd } from './_jsonld.mjs';

// GameDevJobs.com provider — an AGGREGATOR board (like GameJobs.co / Hitmarker /
// Work With Indies), not a single company. One tracked_companies entry yields
// postings across many studios.
//
// GameDevJobs.com is server-rendered behind Cloudflare with no public JSON feed,
// but publishes a sitemap INDEX (`/sitemap.xml` → `sitemaps/jobs-0.xml`, …) that
// lists every open posting (~650 URLs) each with a `<lastmod>` date. UNLIKE
// GameJobs.co, the job URL is `/jobs/{title}-{hexid}` — it carries only a TITLE,
// no company. So the sitemap alone gives a title + a posted date for every
// posting, but the company and location live ONLY on each posting's page, in a
// schema.org JobPosting JSON-LD block (shared reader: providers/_jsonld.mjs).
// That block is read during ENRICHMENT (below); its clean title +
// hiringOrganization + jobLocation override the slug-derived title.
//
// Verified independent of GameJobs.co: in a 40-job sample ~half the companies
// aren't on GameJobs.co at all, and each posting's JSON-LD `sameAs` points at the
// studio's real source ATS (Workable/BambooHR/Breezy/King/ArenaNet/…), not back
// at GameJobs.co — so it's a genuine second feed, not a mirror. It is also
// noisier (generic "Unity/C#" roles from non-game shops); scan.mjs's own
// title/location targeting + the aggregator company blocklist do the filtering.
//
// Configure it explicitly in studios.yml:
//
//   - name: GameDevJobs.com — Gameplay/Tools
//     provider: gamedevjobs
//     query: ["gameplay", "tools", "unity", "gameplay programmer"]  # optional scope
//     enrich: true            # optional — fill company/location from each page (default: on)
//     max_enrich: 500         # optional — cap per-page enrichment fetches (default: 500)
//     enrich_concurrency: 6   # optional — parallel detail fetches during enrichment
//
// QUERY SCOPING (optional). This is a whole-industry board. `query` (string or
// list) keeps only postings whose slug-derived TITLE contains ANY keyword
// (case-insensitive substring, OR-combined). Because the slug carries no company,
// scoping here is title-only (company matching happens downstream after
// enrichment). Omit it and the whole board is returned (nothing dropped).
//
// ENRICHMENT. Company + location live ONLY on each posting's page — so WITHOUT
// enrichment every posting has a title + date but an empty company. Enrichment
// fetches each posting once and overlays the JSON-LD. It's bounded by `max_enrich`
// (default 500) so a query-less run can't storm the board; postings beyond the
// cap are still returned with their slug title + sitemap date, just no company —
// the cap limits richness, never inclusion. Fail-safe throughout: a
// failed/blocked/unparseable page keeps the slug fields and never drops the
// posting. Opt out with `enrich: false` (fast, title+date only, no company).

const BASE = 'https://gamedevjobs.com';
const SITEMAP_URL = `${BASE}/sitemap.xml`;
const DEFAULT_MAX_ENRICH = 500;        // cap per-page enrichment fetches per run
const DEFAULT_ENRICH_CONCURRENCY = 6;  // parallel detail fetches during enrichment

function decodeEntities(s) {
  return String(s == null ? '' : s)
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&quot;/g, '"');
}

// A `/jobs/{title}-{hexid}` URL → a fallback title (company/location come from the
// page during enrichment). We strip the leading `/jobs/`, drop the trailing
// `-{hexid}` (an 8+ hex-char id GameDevJobs appends for uniqueness), and turn
// hyphens back into spaces. Fail-safe: a URL that doesn't fit keeps its whole path
// as the title and is never dropped. `lastmod` (from the sitemap) seeds postedDate.
export function jobFromSlug(url, lastmod) {
  let path = '';
  try {
    path = decodeURIComponent(new URL(url).pathname);
  } catch {
    return null;
  }
  let slug = path.replace(/^\/+/, '').replace(/^jobs\//i, '').trim();
  if (!slug) return null;
  slug = slug.replace(/-[0-9a-f]{8,}$/i, ''); // strip trailing hex id
  // GameDevJobs slugs are lowercased; title-case the fallback so postings shown
  // WITHOUT enrichment (past the cap / enrich:false) don't read all-lowercase.
  // Enrichment's JSON-LD title overrides this whenever it runs.
  const title = slug.replace(/-+/g, ' ').replace(/\s+/g, ' ').trim()
    .replace(/\b\w/g, (c) => c.toUpperCase());
  if (!title) return null;
  const postedDate = toIsoDate(lastmod);
  return {
    title,
    url,
    company: '',
    location: '',
    ...(postedDate ? { postedDate } : {}),
  };
}

// The `/sitemap.xml` is an INDEX of sub-sitemaps. Return the sub-sitemap URLs that
// hold job postings — the `<loc>`s that mention "jobs" (e.g. sitemaps/jobs-0.xml),
// skipping the pages sitemap. Deduped, order preserved.
export function parseSitemapIndex(xml) {
  if (typeof xml !== 'string') return [];
  const out = [];
  const seen = new Set();
  for (const m of xml.matchAll(/<loc>([\s\S]*?)<\/loc>/g)) {
    const url = decodeEntities(m[1].trim());
    // Slash-anchored so the "jobs" inside the domain (gamedevjobs.com) can't match —
    // only a real jobs sub-sitemap path (…/jobs-0.xml) qualifies.
    if (!url || !/\/jobs[\w-]*\.xml(\?|$)/i.test(url)) continue;
    if (seen.has(url)) continue;
    seen.add(url);
    out.push(url);
  }
  return out;
}

// Parse a jobs sub-sitemap into jobs. Each `<url>` carries a `<loc>` (the posting)
// and usually a `<lastmod>`. Deduped by loc, order preserved. Fail-safe: entries
// that don't parse are skipped, never crash.
export function parseJobsSitemap(xml) {
  if (typeof xml !== 'string') return [];
  const jobs = [];
  const seen = new Set();
  for (const block of xml.matchAll(/<url>([\s\S]*?)<\/url>/g)) {
    const inner = block[1];
    const locM = inner.match(/<loc>([\s\S]*?)<\/loc>/);
    if (!locM) continue;
    const url = decodeEntities(locM[1].trim());
    if (!url || seen.has(url)) continue;
    const lastM = inner.match(/<lastmod>([\s\S]*?)<\/lastmod>/);
    const lastmod = lastM ? decodeEntities(lastM[1].trim()) : '';
    const job = jobFromSlug(url, lastmod);
    if (job && job.title) {
      seen.add(url);
      jobs.push(job);
    }
  }
  return jobs;
}

// One role advertised across several offices shows up as several postings —
// same company, same title, different city — each with its own `-{hexid}` URL
// (e.g. SRT Marine's "Senior Unity / C# Developer" in Cardiff, Birmingham AND
// Bristol). Collapse those into ONE row whose location joins the distinct cities
// ("Cardiff, … / Birmingham, … / Bristol, …"), keeping the first posting's URL.
// Grouping is keyed on company + a punctuation-folded title, and — this is the
// fail-safe — only rows with a NON-EMPTY company are ever merged: a generic
// "Unity Developer" title with no company (past the enrichment cap / enrich:off)
// can't be proven to be the same employer, so those pass through untouched. The
// freshest postedDate in a group wins; the first row's other fields are kept.
// Exported for unit tests.
export function mergeSameRoleLocations(jobs) {
  if (!Array.isArray(jobs)) return [];
  const normTitle = (s) => (s || '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
  const groups = new Map(); // key -> merged job (first row, mutated)
  const out = [];
  for (const job of jobs) {
    const company = (job.company || '').trim();
    if (!company) { out.push(job); continue; } // no company → never merge (fail-safe)
    const key = `${company.toLowerCase()}::${normTitle(job.title)}`;
    const head = groups.get(key);
    if (!head) {
      groups.set(key, job);
      out.push(job);
      continue;
    }
    // Merge into the group head: union the locations, keep the freshest date.
    const locs = String(head.location || '').split(' / ').map((s) => s.trim()).filter(Boolean);
    const loc = (job.location || '').trim();
    if (loc && !locs.some((l) => l.toLowerCase() === loc.toLowerCase())) locs.push(loc);
    head.location = locs.join(' / ');
    if (job.postedDate && (!head.postedDate || job.postedDate > head.postedDate)) {
      head.postedDate = job.postedDate;
    }
  }
  return out;
}

// Normalise `query` (string | string[]) into a lowercased keyword list, or null
// when nothing usable is configured (caller then returns the whole board).
function normalizeQuery(query) {
  const list = Array.isArray(query) ? query : typeof query === 'string' ? [query] : [];
  const keywords = list
    .filter((s) => typeof s === 'string')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  return keywords.length ? keywords : null;
}

/** @type {Provider} */
export default {
  id: 'gamedevjobs',

  // Multi-studio board — hosts must be in scan.mjs DEFAULT_AGGREGATORS (see hitmarker).
  // `lastResort` additionally requires these hosts in DEFAULT_LAST_RESORT: the apply
  // path hides behind /login and the JSON-LD carries no direct posting link, so any
  // other source (a direct ATS OR a normal aggregator) wins over a GameDevJobs mirror.
  aggregatorHosts: ['gamedevjobs.com'],
  lastResort: true,

  // Opt-in via `provider: gamedevjobs`, but also claim entries whose careers_url
  // points at gamedevjobs.com so a pasted board URL routes here too.
  detect(entry) {
    let host;
    try {
      host = new URL(entry.careers_url || '').hostname.toLowerCase();
    } catch {
      return null;
    }
    return host === 'gamedevjobs.com' || host === 'www.gamedevjobs.com'
      ? { url: SITEMAP_URL }
      : null;
  },

  async fetch(entry, ctx) {
    const sitemapUrl = typeof entry.sitemap_url === 'string' && entry.sitemap_url.trim()
      ? entry.sitemap_url.trim()
      : SITEMAP_URL;

    // Sitemap index → job sub-sitemaps → jobs. Fetch sub-sitemaps sequentially
    // (there are only a handful); a failed sub-sitemap is skipped, not fatal.
    const indexXml = await ctx.fetchText(sitemapUrl, { redirect: 'error' });
    const subs = parseSitemapIndex(indexXml);
    /** @type {Array<{title:string,url:string,company:string,location:string,postedDate?:string}>} */
    const all = [];
    const seen = new Set();
    for (const sub of subs) {
      let xml;
      try { xml = await ctx.fetchText(sub, { redirect: 'error' }); } catch { continue; }
      for (const job of parseJobsSitemap(xml)) {
        if (seen.has(job.url)) continue;
        seen.add(job.url);
        all.push(job);
      }
    }

    // Optional query scope — title-only (slug carries no company). No query → the
    // whole board (nothing dropped).
    const keywords = normalizeQuery(entry.query);
    const jobs = keywords
      ? all.filter((j) => {
        const hay = j.title.toLowerCase();
        return keywords.some((k) => hay.includes(k));
      })
      : all;

    if (entry.enrich === false || typeof ctx.fetchText !== 'function') return jobs;

    // Enrichment: fetch each posting page and overlay the authoritative JSON-LD
    // fields (title/company/location/date/workMode). Bounded by max_enrich;
    // postings past the cap keep their slug title + sitemap date. Fail-safe: a
    // failed page keeps the slug fields and is never dropped.
    const cap = Number.isInteger(entry.max_enrich) && entry.max_enrich >= 0
      ? entry.max_enrich
      : DEFAULT_MAX_ENRICH;
    const targets = jobs.slice(0, cap);
    const concurrency = Number.isInteger(entry.enrich_concurrency) && entry.enrich_concurrency > 0
      ? entry.enrich_concurrency
      : DEFAULT_ENRICH_CONCURRENCY;

    let next = 0;
    const worker = async () => {
      while (next < targets.length) {
        const job = targets[next++];
        try {
          const html = await ctx.fetchText(job.url, { redirect: 'error' });
          const ld = parseJobPostingLd(html);
          if (ld) {
            if (ld.title) job.title = ld.title;
            if (ld.company) job.company = ld.company;
            if (ld.location) job.location = ld.location;
            if (ld.workMode) job.workMode = ld.workMode;
            if (ld.postedDate) job.postedDate = ld.postedDate;
          }
        } catch { /* keep slug-derived fields; never drop */ }
      }
    };
    await Promise.all(Array.from({ length: Math.min(concurrency, targets.length) }, worker));

    // Now that companies are known, collapse a role split across offices into one
    // row with joined locations (see mergeSameRoleLocations).
    return mergeSameRoleLocations(jobs);
  },
};
