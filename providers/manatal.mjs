// @ts-check
/** @typedef {import('./_types.js').Provider} Provider */

import { stripHtml, splitLocationMode, attachDetail } from './_util.mjs';

// Manatal provider — Manatal's hosted career pages live at
// https://www.careers-page.com/<slug> (studios often iframe them into their own
// site; tinyBuild embeds theirs in a Wix page at tinybuild.com/jobs). The page
// is a Vue app fed by a public, keyless, paginated JSON API on the same host:
//
//   GET https://www.careers-page.com/api/v1.0/c/<slug>/jobs/?page=<n>&page_size=<k>
//       → { count, next, results: [{ hash, position_name, location_display,
//                                    organization_name, description, ... }] }
//
// An unknown slug 404s ("No ClientPortalSettings matches the given query").
// The fetch host is pinned to www.careers-page.com; careers_url only selects the
// slug (SSRF-safe). The list carries each posting's HTML description, so it's
// attached inline (free-tier detail) for the enrichers — no per-job request.
//
//   - name: tinyBuild
//     provider: manatal
//     careers_url: https://www.careers-page.com/tinybuild

const HOST = 'https://www.careers-page.com';
const PAGE_SIZE = 100;
const MAX_PAGES = 20;

/**
 * Resolve the career-page slug from careers_url. Exported for unit tests.
 *
 * @param {{careers_url?: string}} entry
 * @returns {string|null}
 */
export function resolveManatalSlug(entry) {
  const raw = typeof entry?.careers_url === 'string' ? entry.careers_url.trim() : '';
  if (!raw) return null;
  let u;
  try { u = new URL(raw); } catch { return null; }
  if (u.protocol !== 'https:') return null;
  const host = u.hostname.toLowerCase();
  if (host !== 'www.careers-page.com' && host !== 'careers-page.com') return null;
  const m = u.pathname.match(/^\/([A-Za-z0-9_-]+)(?:\/|$)/);
  if (!m || m[1] === 'api') return null;
  return m[1];
}

/**
 * Map Manatal job records into the scanner's job shape. Exported for unit tests.
 *
 * @param {Array<object>} results
 * @param {string} companyName
 * @param {string} slug
 * @returns {Array<{title: string, url: string, company: string, location: string, workMode?: string, department?: string}>}
 */
export function mapManatalJobs(results, companyName, slug) {
  if (!Array.isArray(results)) return [];
  const out = [];
  const seen = new Set();
  for (const rec of results) {
    if (!rec || typeof rec !== 'object') continue;
    const title = typeof rec.position_name === 'string' ? rec.position_name.trim() : '';
    const hash = typeof rec.hash === 'string' ? rec.hash.trim() : '';
    if (!title || !hash || seen.has(hash)) continue;
    seen.add(hash);

    const rawLoc = typeof rec.location_display === 'string' ? rec.location_display.trim() : '';
    const { location, workMode } = splitLocationMode(rawLoc);
    const department = typeof rec.organization_name === 'string' ? rec.organization_name.trim() : '';
    const job = {
      title,
      url: `${HOST}/${slug}/job/${encodeURIComponent(hash)}`,
      company: companyName,
      location,
      ...(workMode ? { workMode } : {}),
      ...(department ? { department } : {}),
    };
    const text = typeof rec.description === 'string' ? stripHtml(rec.description) : '';
    out.push(attachDetail(job, { text }));
  }
  return out;
}

/** @type {Provider} */
export default {
  id: 'manatal',

  detect(entry) {
    const slug = resolveManatalSlug(entry);
    return slug ? { url: `${HOST}/${slug}` } : null;
  },

  // url→identity for the rehm miner: careers-page.com/<slug>/job/<hash> → slug.
  mineUrl(jobUrl) {
    const slug = resolveManatalSlug({ careers_url: jobUrl });
    return slug ? { slug, careers_url: `${HOST}/${slug}` } : null;
  },

  async fetch(entry, ctx) {
    const slug = resolveManatalSlug(entry);
    if (!slug) throw new Error(`manatal: careers_url must be https://www.careers-page.com/<slug> for ${entry.name}`);

    const all = [];
    for (let page = 1; page <= MAX_PAGES; page++) {
      const url = `${HOST}/api/v1.0/c/${encodeURIComponent(slug)}/jobs/?page=${page}&page_size=${PAGE_SIZE}`;
      const res = /** @type {any} */ (await ctx.fetchJson(url));
      const batch = Array.isArray(res?.results) ? res.results : null;
      if (!batch) throw new Error(`manatal: unexpected jobs shape for ${entry.name}`);
      all.push(...batch);
      if (!res.next || batch.length === 0) break;
    }
    return mapManatalJobs(all, entry.name, slug);
  },
};
