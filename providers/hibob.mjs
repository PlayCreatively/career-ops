// @ts-check
/** @typedef {import('./_types.js').Provider} Provider */

import { toIsoDate, normalizeWorkMode, splitLocationMode } from './_util.mjs';

// HiBob ("Bob") careers provider — HiBob is a multi-tenant HR platform whose
// public careers site lives at a per-customer subdomain:
//
//   https://<slug>.careers.hibob.com/jobs            (Angular SPA shell)
//   https://<slug>.careers.hibob.com/api/job-ad      (the JSON the SPA fetches)
//
// The SPA is JS-rendered, but it pulls every published role from /api/job-ad in
// one shot — no pagination, no auth. The ONLY gate is a same-origin `Referer`
// header (a bare fetch 401s); we send `Referer: <origin>/jobs` and get the full
// list. Response shape: { filterGroups, jobAdDetails: [ { id, title, department,
// site, country, workspaceType, workspaceTypeId, publishedAt, ... } ] }.
//
// Job permalinks are the SPA route with the id as a query param:
//   https://<slug>.careers.hibob.com/jobs?jobId=<uuid>
//
// Every endpoint is derived from the entry's OWN careers_url origin and we never
// leave it (same-origin is the security boundary — see assertSameOrigin). Routing
// is host-auto-detected: any *.careers.hibob.com careers_url claims this provider,
// so studios need no explicit `provider:` line.

const HIBOB_SUFFIX = '.careers.hibob.com';

function originOf(entry) {
  try {
    const u = new URL(entry && entry.careers_url ? entry.careers_url : '');
    if (u.protocol !== 'https:') return null;
    return { origin: u.origin, host: u.hostname.toLowerCase() };
  } catch {
    return null;
  }
}

// Guard a URL to the tenant origin: https-only and exact host match. Keeps a
// per-tenant provider from being steered off the customer's careers host.
function assertSameOrigin(url, host) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`hibob: invalid URL: ${url}`);
  }
  if (parsed.protocol !== 'https:') throw new Error(`hibob: URL must use HTTPS: ${url}`);
  if (parsed.hostname.toLowerCase() !== host) {
    throw new Error(`hibob: URL host "${parsed.hostname}" must match careers host "${host}"`);
  }
  return url;
}

/**
 * Map a HiBob /api/job-ad `jobAdDetails` array into the scanner's job shape.
 * Exported for unit tests. Records missing a title or id are skipped; rows are
 * deduped by id (a published role appears once). The structured
 * `workspaceTypeId` (remote/hybrid/onsite) wins for workMode; the location text
 * is cleaned of any embedded mode token and falls back to country.
 *
 * @param {Array<object>} details
 * @param {string} companyName
 * @param {string} origin — the tenant origin, e.g. https://ustwo.careers.hibob.com
 * @returns {Array<{title: string, url: string, company: string, location: string, postedDate?: string, workMode?: string, department?: string}>}
 */
export function mapHibobJobAds(details, companyName, origin) {
  if (!Array.isArray(details)) return [];
  const out = [];
  const seen = new Set();
  for (const rec of details) {
    if (!rec || typeof rec !== 'object') continue;
    const title = typeof rec.title === 'string' ? rec.title.trim() : '';
    const id = rec.id != null ? String(rec.id) : '';
    if (!title || !id) continue;
    if (seen.has(id)) continue;
    seen.add(id);

    const country = typeof rec.country === 'string' ? rec.country.trim() : '';
    const site = typeof rec.site === 'string' ? rec.site.trim() : '';
    // site is the employer's chosen label (e.g. "London Studio", "UK - Remote");
    // strip any work-mode word baked into it, then prefer the structured mode.
    const split = splitLocationMode(site || country);
    const location = split.location || country;
    const workMode = normalizeWorkMode(rec.workspaceTypeId || rec.workspaceType) || split.workMode;
    const postedDate = toIsoDate(rec.publishedAt);
    const department = typeof rec.department === 'string' ? rec.department.trim() : '';

    out.push({
      title,
      url: `${origin}/jobs?jobId=${encodeURIComponent(id)}`,
      company: companyName,
      location,
      ...(postedDate ? { postedDate } : {}),
      ...(workMode ? { workMode } : {}),
      ...(department ? { department } : {}),
    });
  }
  return out;
}

/** @type {Provider} */
export default {
  id: 'hibob',

  detect(entry) {
    const resolved = originOf(entry);
    if (!resolved) return null;
    if (!resolved.host.endsWith(HIBOB_SUFFIX)) return null;
    return { url: `${resolved.origin}/jobs` };
  },

  async fetch(entry, ctx) {
    const resolved = originOf(entry);
    if (!resolved) {
      throw new Error(`hibob: cannot resolve careers origin for ${entry && entry.name} — set an https careers_url`);
    }
    const { origin, host } = resolved;
    const apiUrl = `${origin}/api/job-ad`;
    assertSameOrigin(apiUrl, host);

    // The endpoint 401s without a same-origin Referer; send one.
    const data = await ctx.fetchJson(apiUrl, {
      headers: { referer: `${origin}/jobs`, accept: 'application/json' },
      redirect: 'error',
    });
    if (!data || typeof data !== 'object' || !Array.isArray(data.jobAdDetails)) {
      throw new Error(`hibob: unexpected /api/job-ad response for ${entry.name} (${host})`);
    }
    return mapHibobJobAds(data.jobAdDetails, entry.name, origin);
  },
};
