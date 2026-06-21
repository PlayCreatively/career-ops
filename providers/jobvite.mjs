// @ts-check
/** @typedef {import('./_types.js').Provider} Provider */

import { splitLocationMode } from './_util.mjs';

// Jobvite provider — Jobvite career sites ("CareerWebSite"/CWS) live at
// `jobs.jobvite.com/{slug}/jobs` and render the whole board server-side as a
// set of category tables. There is no documented public JSON feed (the v2 API
// is auth-gated), but the `/jobs` HTML page is keyless and ships every opening
// as a `<td class="jv-job-list-name"><a href="/{slug}/job/{id}">Title</a>`
// row paired with a `<td class="jv-job-list-location">` cell — so we parse that
// list page directly. No auth, no headless browser. Per-company like
// greenhouse/lever: one tracked_companies entry per studio.
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
// `/careers/{slug}` form — the slug is taken from the path and the canonical
// list URL `https://jobs.jobvite.com/{slug}/jobs` is derived from it. An empty
// board (studio left Jobvite / no openings) yields zero rows, not an error.
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

// Derive the list endpoint. An explicit `feed_url` wins so an unusual deployment
// can be pinned by hand.
function resolveListUrl(entry) {
  if (entry && typeof entry.feed_url === 'string' && entry.feed_url.trim()) return entry.feed_url.trim();
  const slug = slugOf(entry);
  return slug ? `https://${CWS_HOST}/${slug}/jobs` : null;
}

function strip(s) {
  return String(s == null ? '' : s).replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#0?39;|&apos;/g, "'").replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ').trim();
}

/**
 * Parse a Jobvite `/jobs` careersite page into job rows. Exported for unit tests.
 * Each opening is a name-cell anchor (relative `/{slug}/job/{id}` href) followed
 * by a location cell; the location often leads with a work-mode token
 * ("Hybrid Remote, Leamington Spa, UK") which splitLocationMode lifts out.
 *
 * @param {string} html — the fetched `/jobs` page
 * @param {string} fallbackCompany — written into job.company
 * @returns {Array<{title: string, url: string, company: string, location: string, workMode?: string}>}
 */
export function parseJobviteList(html, fallbackCompany) {
  const jobs = [];
  const seen = new Set();
  const re = /<td class="jv-job-list-name">\s*<a href="([^"]+)">([\s\S]*?)<\/a>\s*<\/td>\s*<td class="jv-job-list-location">([\s\S]*?)<\/td>/g;
  let m;
  while ((m = re.exec(String(html)))) {
    const href = m[1];
    const title = strip(m[2]);
    if (!href || !title) continue;
    let url;
    try { url = new URL(href, `https://${CWS_HOST}`).href; } catch { continue; }
    if (seen.has(url)) continue;
    seen.add(url);
    const { location, workMode } = splitLocationMode(strip(m[3]));
    jobs.push({
      title,
      url,
      company: fallbackCompany || '',
      location,
      ...(workMode ? { workMode } : {}),
    });
  }
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
    const listUrl = resolveListUrl(entry);
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
    const listUrl = resolveListUrl(entry);
    if (!listUrl) throw new Error(`jobvite: cannot derive list URL for ${entry && entry.name} — set careers_url with the slug in its path (https://jobs.jobvite.com/{slug}) or feed_url`);
    // redirect:'error' guards against redirect-based SSRF; the host is the fixed
    // jobs.jobvite.com careersite.
    const html = await ctx.fetchText(listUrl, { redirect: 'error' });
    return parseJobviteList(html, entry && entry.name);
  },
};
