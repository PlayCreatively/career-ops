// @ts-check
/** @typedef {import('./_types.js').Provider} Provider */

import { parseJobPostingLd } from './_jsonld.mjs';
import { splitLocationMode, toIsoDate, stripHtml } from './_util.mjs';

// GameJobs.co provider — an AGGREGATOR board (like Hitmarker / Work With Indies /
// Games Jobs Direct), not a single company. One tracked_companies entry yields
// postings across many studios.
//
// GameJobs.co is a server-rendered site behind Cloudflare with no public JSON
// feed or search API, but it publishes a complete `sitemap.xml` listing every
// open posting (~6,700 URLs). Each job URL is `/{Title}-at-{Company}` (punctuation
// stripped, spaces → hyphens, an optional `-{n}` dedup suffix), so the sitemap
// alone yields a title + company for every posting with ZERO per-job fetches.
// The authoritative title, company, location and posted date live on each posting
// page and are read during ENRICHMENT (below) to fill in location + posted date +
// a clean title/company. Older pages carried a schema.org JobPosting JSON-LD block;
// current pages render those fields as visible header markup inside the main
// <article> instead. Enrichment reads JSON-LD when present and falls back to the
// header markup otherwise (see parsePostingHtml), so either layout works.
//
// Configure it explicitly in studios.yml:
//
//   - name: GameJobs.co — Gameplay/Tools (EU)
//     provider: gamejobs-co
//     query: ["gameplay", "tools", "unity", "gameplay programmer"]  # optional scope
//     enrich: true            # optional — fill location/date from each page (default: on)
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
// posting once and reading its JobPosting block. EVERY posting is enriched — no
// count cap, so location/date are never silently missing on the long tail; the
// request rate is bounded only by enrich_concurrency (and by a `query:` scope, if
// set, which shrinks the set that's fetched). Enrichment is fail-safe throughout:
// a failed/blocked/unparseable page keeps the slug-derived fields and never drops
// the posting. Opt out entirely with `enrich: false` (fast, slug-only, single
// request for the whole board).

const BASE = 'https://gamejobs.co';
const SITEMAP_URL = `${BASE}/sitemap.xml`;
const DEFAULT_ENRICH_CONCURRENCY = 6;  // parallel detail fetches (scanner enriches every job)

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

// The URL pathname (slug) with leading slashes stripped, decoded. '' on a bad URL.
function slugOf(url) {
  try {
    return decodeURIComponent(new URL(url).pathname.replace(/^\/+/, '')).trim();
  } catch {
    return '';
  }
}

// Extract every job URL from the sitemap. Job postings are the `<loc>`s that look
// like `/{slug}-at-{slug}`; the homepage and any nested sitemap (.xml) `<loc>` lack
// "-at-" and are skipped. Deduped, order preserved.
//
// Also collapse GameJobs.co's OWN slug-collision twins. When it slugs two postings to
// the same `title-at-company`, the first keeps the bare slug (`…-at-Netflix`) and the
// second gets a numeric suffix (`…-at-Netflix-8057`); both list the same role, so left
// alone the board shows a visible duplicate that downstream snapshot dedup can't
// collapse (two rows from the SAME normal aggregator — neither is a "direct" twin nor a
// last-resort mirror). We drop a suffixed slug ONLY when its exact bare twin is also
// present this run — the strongest possible signal. A studio whose name ends in a number
// (e.g. Team17) is safe: the stripped base (`…-at-Team`) won't exist as a real slug, so
// the row is kept. Fail-safe: a suffixed slug with no bare twin is never touched.
export function parseSitemapJobs(xml) {
  if (typeof xml !== 'string') return [];
  const rows = [];
  const seen = new Set();
  for (const m of xml.matchAll(/<loc>([\s\S]*?)<\/loc>/g)) {
    const url = decodeEntities(m[1].trim());
    if (!url || !/-at-/i.test(url)) continue;
    if (seen.has(url)) continue;
    seen.add(url);
    const job = jobFromSlug(url);
    if (job && job.title) rows.push({ job, slug: slugOf(url) });
  }
  const slugs = new Set(rows.map((r) => r.slug));
  return rows
    .filter((r) => {
      const base = r.slug.replace(/-\d+$/, '');
      return base === r.slug || !slugs.has(base); // keep bare slugs + orphan-suffixed
    })
    .map((r) => r.job);
}

// Turn GameJobs.co's relative "posted" label ("15 days ago", "1 month ago",
// "today", "yesterday") into an ISO date. Best-effort: returns '' for anything
// unrecognised so the caller simply omits the posted date. `now` is injectable
// for tests.
export function parseRelativeDate(text, now = new Date()) {
  const s = String(text == null ? '' : text).trim().toLowerCase();
  if (!s) return '';
  const d = new Date(now.getTime());
  if (s === 'today') return toIsoDate(d);
  if (s === 'yesterday') { d.setUTCDate(d.getUTCDate() - 1); return toIsoDate(d); }
  const m = s.match(/^(\d+)\s+(minute|hour|day|week|month|year)s?\s+ago$/);
  if (!m) return '';
  const n = Number(m[1]);
  switch (m[2]) {
    case 'minute': d.setUTCMinutes(d.getUTCMinutes() - n); break;
    case 'hour': d.setUTCHours(d.getUTCHours() - n); break;
    case 'day': d.setUTCDate(d.getUTCDate() - n); break;
    case 'week': d.setUTCDate(d.getUTCDate() - n * 7); break;
    case 'month': d.setUTCMonth(d.getUTCMonth() - n); break;
    case 'year': d.setUTCFullYear(d.getUTCFullYear() - n); break;
  }
  return toIsoDate(d);
}

// Read the authoritative fields from a posting page's VISIBLE header markup — the
// fallback for pages that no longer embed schema.org JSON-LD. The main posting sits
// in `<article class="w800">` with a tight header:
//
//   <h1>Unity Developer</h1>
//   <div><a href="/search?c=Virtuos" class="c">Virtuos</a></div>
//   <div><a href="/search?w=Ukraine%2C+Kyiv" class="w">Ukraine, Kyiv</a></div>
//   <div>15 days ago</div>
//
// The SAME page also renders a "more jobs" list lower down whose rows carry their
// OWN class="c"/class="w" chips — so we bind location + date to the header block
// (company div, then an OPTIONAL location div, then the date div) in one anchored
// match, never "the first class="w" on the page". A remote posting with no location
// chip therefore yields an empty location, not a neighbour's city. Returns the same
// shape as parseJobPostingLd, or null when there's no <h1> to anchor to. Never throws.
export function parsePostingHtml(html) {
  if (typeof html !== 'string' || !html) return null;
  // Header block, anchored at <h1>. Location div is optional; date div ends it.
  const header = html.match(
    /<h1[^>]*>([\s\S]*?)<\/h1>\s*<div>\s*<a\b[^>]*class="c"[^>]*>([^<]*)<\/a>\s*<\/div>\s*(?:<div>\s*<a\b[^>]*class="w"[^>]*>([^<]*)<\/a>\s*<\/div>\s*)?<div>\s*([^<]*?(?:ago|today|yesterday))\s*<\/div>/i,
  );
  if (!header) return null;

  const title = decodeEntities(stripHtml(header[1])).trim();
  const company = decodeEntities(header[2] || '').trim();
  const rawLoc = decodeEntities(header[3] || '').trim();
  const { location, workMode } = splitLocationMode(rawLoc);
  const postedDate = parseRelativeDate(header[4]);

  // Description body for detail-phase enrichers (sponsorship). The whole <article>
  // includes the related-jobs list too, but that's harmless for a keyword scan.
  const artM = html.match(/<article[^>]*>([\s\S]*?)<\/article>/i);
  const description = artM ? stripHtml(artM[1]) : '';

  return {
    title,
    company,
    location,
    ...(workMode ? { workMode } : {}),
    ...(postedDate ? { postedDate } : {}),
    ...(description ? { description } : {}),
  };
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
    // ANY keyword. No query → the whole board (nothing dropped). Phase 1 ends here:
    // the scanner's detail phase (fetchDetail below) overlays the authoritative
    // JSON-LD fields from each posting page.
    const keywords = normalizeQuery(entry.query);
    return keywords
      ? all.filter((j) => {
        const hay = `${j.title} ${j.company}`.toLowerCase();
        return keywords.some((k) => hay.includes(k));
      })
      : all;
  },

  // PAID detail (a real per-page fetch): the sitemap gives only a rough
  // slug-derived title/company, so the JSON-LD overlay is what makes rows
  // accurate. Runs by default (--extra-fetch on) over every job; --no-extra-fetch
  // falls back to the slug basics. detailConcurrency parallel fetches.
  detailConcurrency: DEFAULT_ENRICH_CONCURRENCY,

  // Fetch one posting page and read its authoritative fields. Prefer the schema.org
  // JobPosting JSON-LD (older layout); fall back to the visible header markup for
  // pages that no longer embed it (current layout). Merge field-by-field so a value
  // missing from one source is filled from the other — JSON-LD wins where both have
  // it. `overlay` carries title/company/location/workMode/date; `text` is the
  // description body for cross-cutting enrichers (sponsorship). Fail-safe: when
  // neither source parses, return null and the scanner keeps the slug fields.
  async fetchDetail(job, ctx) {
    const html = await ctx.fetchText(job.url, { redirect: 'error' });
    const ld = parseJobPostingLd(html);
    const htmlLd = parsePostingHtml(html);
    if (!ld && !htmlLd) return null;

    const a = ld || {};
    const b = htmlLd || {};
    const pick = (k) => (a[k] ? a[k] : b[k] ? b[k] : '');
    const overlay = {
      title: pick('title'),
      company: pick('company'),
      location: pick('location'),
    };
    const workMode = pick('workMode');
    if (workMode) overlay.workMode = workMode;
    const postedDate = pick('postedDate');
    if (postedDate) overlay.postedDate = postedDate;
    const description = pick('description');
    return { overlay, ...(description ? { text: description } : {}) };
  },
};
