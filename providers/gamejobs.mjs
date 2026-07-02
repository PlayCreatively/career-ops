// @ts-check
/** @typedef {import('./_types.js').Provider} Provider */

import { parseJobPostingLd } from './_jsonld.mjs';

// GameJobs.co provider — an AGGREGATOR board (like Hitmarker / Work With Indies /
// Games Jobs Direct), not a single company. One tracked_companies entry yields
// postings across many studios.
//
// GameJobs.co is a server-rendered site behind Cloudflare with no public JSON
// feed or search API, but it publishes a complete `sitemap.xml` listing every
// open posting (~6,700 URLs). Each job URL is `/{Title}-at-{Company}` (punctuation
// stripped, spaces → hyphens, an optional `-{n}` dedup suffix), so the sitemap
// alone yields a title + company for every posting with ZERO per-job fetches.
// Each posting page also carries a schema.org JobPosting JSON-LD block with the
// authoritative title, hiringOrganization, jobLocation and datePosted — which we
// read during ENRICHMENT (below) to fill in location + posted date + a clean
// title/company.
//
// Configure it explicitly in studios.yml:
//
//   - name: GameJobs.co — Gameplay/Tools (EU)
//     provider: gamejobs-co
//     query: ["gameplay", "tools", "unity", "gameplay programmer"]  # optional scope
//     enrich: true            # optional — fill location/date from each page (default: on)
//     max_enrich: 500         # optional — cap per-page enrichment fetches (default: 500)
//     enrich_concurrency: 6   # optional — parallel detail fetches during enrichment
//
// QUERY SCOPING (optional). This is a WHOLE-INDUSTRY, global board — the sitemap
// carries thousands of postings, most irrelevant to any one search. `query`
// (a string or list of strings) keeps only postings whose slug-derived
// "title company" text contains ANY of the keywords (case-insensitive substring,
// OR-combined). It scopes BOTH what is returned AND what is enriched, the same way
// Hitmarker's `query`/`filter_by` scopes its board. Omit it and the WHOLE board is
// returned (nothing is silently dropped) — scan.mjs's own title/location targeting
// then does the filtering, just over a much larger set.
//
// ENRICHMENT. Location and posted date live ONLY on each posting's own page
// (in the JSON-LD), never in the sitemap. Filling them in means fetching each
// posting once and reading its JobPosting block. Enrichment is bounded by
// `max_enrich` (default 500) so a query-less run can't fire thousands of requests
// at the board; postings BEYOND the cap are still returned, just with the
// slug-derived title/company and no location — the cap limits richness, never
// inclusion. Enrichment is fail-safe throughout: a failed/blocked/unparseable
// page keeps the slug-derived fields and never drops the posting. Opt out entirely
// with `enrich: false` (fast, slug-only, single request for the whole board).

const BASE = 'https://gamejobs.co';
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

// Turn a `/{Title}-at-{Company}` job URL into a fallback title/company. We split on
// the LAST "-at-" (company names don't contain it; a title occasionally does), drop
// a trailing "-{n}" dedup suffix from the company, and turn hyphens back into
// spaces. This is only a FALLBACK — when a posting is enriched the JSON-LD's clean
// title + hiringOrganization override both. Fail-safe: a slug with no "-at-" keeps
// the whole slug as the title and an empty company (never dropped).
export function jobFromSlug(url) {
  let slug = '';
  try {
    slug = decodeURIComponent(new URL(url).pathname.replace(/^\/+/, ''));
  } catch {
    return null;
  }
  slug = slug.trim();
  if (!slug) return null;
  const deHyphen = (s) => s.replace(/-+/g, ' ').replace(/\s+/g, ' ').trim();

  const at = slug.toLowerCase().lastIndexOf('-at-');
  if (at === -1) {
    return { title: deHyphen(slug), url, company: '', location: '' };
  }
  const titlePart = slug.slice(0, at);
  const companyPart = slug.slice(at + '-at-'.length).replace(/-\d+$/, ''); // strip dedup suffix
  return {
    title: deHyphen(titlePart),
    url,
    company: deHyphen(companyPart),
    location: '',
  };
}

// Extract every job URL from the sitemap. Job postings are the `<loc>`s that look
// like `/{slug}-at-{slug}`; the homepage and any nested sitemap (.xml) `<loc>` lack
// "-at-" and are skipped. Deduped, order preserved.
export function parseSitemapJobs(xml) {
  if (typeof xml !== 'string') return [];
  const jobs = [];
  const seen = new Set();
  for (const m of xml.matchAll(/<loc>([\s\S]*?)<\/loc>/g)) {
    const url = decodeEntities(m[1].trim());
    if (!url || !/-at-/i.test(url)) continue;
    if (seen.has(url)) continue;
    seen.add(url);
    const job = jobFromSlug(url);
    if (job && job.title) jobs.push(job);
  }
  return jobs;
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
  id: 'gamejobs-co',

  // Multi-studio board — hosts must be in scan.mjs DEFAULT_AGGREGATORS (see hitmarker).
  aggregatorHosts: ['gamejobs.co'],

  // Opt-in via `provider: gamejobs-co`, but also claim entries whose careers_url
  // points at gamejobs.co so a pasted board URL routes here too.
  detect(entry) {
    let host;
    try {
      host = new URL(entry.careers_url || '').hostname.toLowerCase();
    } catch {
      return null;
    }
    return host === 'gamejobs.co' || host === 'www.gamejobs.co'
      ? { url: SITEMAP_URL }
      : null;
  },

  async fetch(entry, ctx) {
    const sitemapUrl = typeof entry.sitemap_url === 'string' && entry.sitemap_url.trim()
      ? entry.sitemap_url.trim()
      : SITEMAP_URL;
    const xml = await ctx.fetchText(sitemapUrl, { redirect: 'error' });
    const all = parseSitemapJobs(xml);

    // Optional query scope — keeps only postings whose slug-derived text matches
    // ANY keyword. Scopes both what's returned and what's enriched. No query →
    // the whole board (nothing dropped).
    const keywords = normalizeQuery(entry.query);
    const jobs = keywords
      ? all.filter((j) => {
        const hay = `${j.title} ${j.company}`.toLowerCase();
        return keywords.some((k) => hay.includes(k));
      })
      : all;

    if (entry.enrich === false || typeof ctx.fetchText !== 'function') return jobs;

    // Enrichment: fetch each posting page and overlay the authoritative JSON-LD
    // fields (title/company/location/date/workMode). Bounded by max_enrich so a
    // query-less run can't storm the board; postings past the cap are still
    // returned with their slug fields. Fail-safe: a failed page keeps the slug
    // fields and is never dropped.
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

    return jobs;
  },
};
