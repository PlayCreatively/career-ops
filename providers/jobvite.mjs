// @ts-check
/** @typedef {import('./_types.js').Provider} Provider */

import { splitLocationMode } from './_util.mjs';

// Jobvite provider — Jobvite career sites ("CareerWebSite"/CWS) live at
// `jobs.jobvite.com/{slug}`. There is no documented public JSON feed (the v2
// API is auth-gated), but the board is server-rendered keyless HTML — we parse
// the list page directly. No auth, no headless browser. Per-company like
// greenhouse/lever: one tracked_companies entry per studio.
//
// TWO board generations are in the wild, with different list markup AND a
// different list URL — we handle both:
//
//   1. LEGACY TABLE boards serve every opening at `/{slug}/jobs` as
//      `<td class="jv-job-list-name"><a href="/{slug}/job/{id}">Title</a></td>`
//      paired with a `<td class="jv-job-list-location">` cell.
//      (e.g. playground-games, probablymonsters)
//   2. MODERN CARD boards turn `/{slug}/jobs` into a marketing wrapper that
//      iframes the list, so it parses to ZERO rows. The real server-rendered
//      list lives at `/{slug}/jobs/positions` as
//      `<li class="job-item"><a href="/{slug}/job/{id}">…<div class="jv-job-list-name">Title</div>
//      <div class="jv-job-list-location">Location</div>`.
//      (e.g. amberstudiocareers — 74 jobs the old /jobs path showed as 0)
//
// So fetch() tries `/{slug}/jobs/positions` first (modern; the legacy boards
// 303 it) and falls back to `/{slug}/jobs` (legacy). parseJobviteList handles
// both markups. A few genuinely iframe-only legacy boards (no server-rendered
// list at either path — e.g. capcomusa) yield zero here and must be sourced
// from the rehm aggregator via `provider: rehm` + `studio:` instead.
//
// Routing: detect() claims any *.jobvite.com host (the careersite host is
// `jobs.jobvite.com`). Custom-domain deployments can be pinned with explicit
// `provider: jobvite` + a careers_url whose path carries the slug:
//
//   - name: Playground Games
//     provider: jobvite
//     careers_url: https://jobs.jobvite.com/playground-games
//
// careers_url may be the board root, the `/jobs` page, or the older
// `/careers/{slug}` form — the slug is taken from the path. An empty board
// (studio left Jobvite / no openings) yields zero rows, not an error.
//
// The list page carries no posting date (only the per-job page does), so jobs
// from this provider have no postedDate.

const CWS_HOST = 'jobs.jobvite.com';

// Pull the company slug out of any URL on a Jobvite careersite. Path shapes seen
// in the wild: `/{slug}`, `/{slug}/jobs`, `/{slug}/job/{id}`, and the older
// `/careers/{slug}/...` form. The first path segment is the slug unless it's the
// literal "careers", in which case the slug is the second segment.
function slugOf(entry) {
  const raw = (entry && entry.careers_url) || '';
  let segs;
  try {
    segs = new URL(raw).pathname.split('/').filter(Boolean);
  } catch {
    return null;
  }
  if (!segs.length) return null;
  if (segs[0].toLowerCase() === 'careers') return segs[1] || null;
  return segs[0];
}

// Derive the list endpoint(s) to try, in order. An explicit `feed_url` wins so
// an unusual deployment can be pinned by hand (single URL, no fallback). For a
// derived slug we try the modern `/jobs/positions` page first (legacy boards
// 303 it) then the legacy `/jobs` page.
function resolveListUrls(entry) {
  if (entry && typeof entry.feed_url === 'string' && entry.feed_url.trim()) return [entry.feed_url.trim()];
  const slug = slugOf(entry);
  if (!slug) return [];
  return [`https://${CWS_HOST}/${slug}/jobs/positions`, `https://${CWS_HOST}/${slug}/jobs`];
}

function strip(s) {
  return String(s == null ? '' : s).replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#0?39;|&apos;/g, "'").replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ').trim();
}

/**
 * Parse a Jobvite careersite list page into job rows. Handles BOTH board
 * generations (see header): the legacy `<td class="jv-job-list-name">` table
 * and the modern `<li class="job-item">` + `<div class="jv-job-list-name">`
 * cards. Each opening is an anchor (relative `/{slug}/job/{id}` href) with a
 * name and a location; the location often leads with a work-mode token
 * ("Hybrid Remote, Leamington Spa, UK") which splitLocationMode lifts out.
 * Modern card boards also repeat a few openings in a "Featured Jobs" block
 * (different markup) — those resolve to the same job URLs and are deduped out.
 * Exported for unit tests.
 *
 * @param {string} html — the fetched list page
 * @param {string} fallbackCompany — written into job.company
 * @returns {Array<{title: string, url: string, company: string, location: string, workMode?: string}>}
 */
export function parseJobviteList(html, fallbackCompany) {
  const jobs = [];
  const seen = new Set();
  const push = (href, rawTitle, rawLoc) => {
    const title = strip(rawTitle);
    if (!href || !title) return;
    let url;
    try { url = new URL(href, `https://${CWS_HOST}`).href; } catch { return; }
    if (seen.has(url)) return;
    seen.add(url);
    const { location, workMode } = splitLocationMode(strip(rawLoc));
    jobs.push({
      title,
      url,
      company: fallbackCompany || '',
      location,
      ...(workMode ? { workMode } : {}),
    });
  };
  const src = String(html);
  // Legacy table shape.
  const tableRe = /<td class="jv-job-list-name">\s*<a href="([^"]+)">([\s\S]*?)<\/a>\s*<\/td>\s*<td class="jv-job-list-location">([\s\S]*?)<\/td>/g;
  let m;
  while ((m = tableRe.exec(src))) push(m[1], m[2], m[3]);
  // Modern card shape. Anchored to the `<li class="job-item">` row (not the
  // Featured Jobs cards, which use jv-featured-job-* markup) so the lazy gap
  // between the anchor and its name div can't pair across rows.
  const cardRe = /<li class="job-item">\s*<a href="([^"]+)"[^>]*>\s*(?:<span>\s*)?<div class="jv-job-list-name">([\s\S]*?)<\/div>\s*<div class="jv-job-list-location">([\s\S]*?)<\/div>/g;
  while ((m = cardRe.exec(src))) push(m[1], m[2], m[3]);
  return jobs;
}

/** @type {Provider} */
export default {
  id: 'jobvite',

  detect(entry) {
    let host;
    try {
      host = new URL((entry && entry.careers_url) || '').hostname.toLowerCase();
    } catch {
      return null;
    }
    if (host !== 'jobvite.com' && !host.endsWith('.jobvite.com')) return null;
    const [listUrl] = resolveListUrls(entry);
    return listUrl ? { url: listUrl } : null;
  },

  // url→identity (inverse of probe): mine a jobs.jobvite.com/{slug} (or /careers/{slug})
  // link to { slug, careers_url }.
  mineUrl(jobUrl) {
    let u; try { u = new URL(jobUrl); } catch { return null; }
    const h = u.hostname.toLowerCase();
    if (h !== 'jobvite.com' && !h.endsWith('.jobvite.com')) return null;
    const segs = u.pathname.split('/').filter(Boolean);
    const slug = segs[0] === 'careers' ? segs[1] : segs[0];
    return (slug && slug !== 'job') ? { slug, careers_url: `https://jobs.jobvite.com/${slug}` } : null;
  },

  async fetch(entry, ctx) {
    const urls = resolveListUrls(entry);
    if (!urls.length) throw new Error(`jobvite: cannot derive list URL for ${entry && entry.name} — set careers_url with the slug in its path (https://jobs.jobvite.com/{slug}) or feed_url`);
    // Try modern /jobs/positions then legacy /jobs. redirect:'error' guards
    // against redirect-based SSRF (and is how legacy boards reject the modern
    // path — they 303 it, which we treat as "try the next URL"). A page that
    // fetches OK but parses to zero rows is a legitimately empty/iframe-only
    // board → return []; only throw if NONE of the endpoints was reachable.
    let anyOk = false;
    let lastErr;
    for (const url of urls) {
      let html;
      try {
        html = await ctx.fetchText(url, { redirect: 'error' });
      } catch (err) {
        lastErr = err;
        continue;
      }
      anyOk = true;
      const jobs = parseJobviteList(html, entry && entry.name);
      if (jobs.length) return jobs;
    }
    if (!anyOk) throw lastErr || new Error(`jobvite: no reachable list endpoint for ${entry && entry.name}`);
    return [];
  },
};
