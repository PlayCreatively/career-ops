// @ts-check
/** @typedef {import('./_types.js').Provider} Provider */

import { toIsoDate, normalizeWorkMode, stripHtml, attachDetail } from './_util.mjs';

// Lever provider — hits the public postings endpoint.
// Auto-detects from careers_url patterns:
//   - US:  `https://jobs.lever.co/<slug>`    → api.lever.co
//   - EU:  `https://jobs.eu.lever.co/<slug>` → api.eu.lever.co
// Lever's EU data-residency boards live on the `eu.` host with a matching API
// host; routing to the wrong region returns 404, so the region is preserved.

function resolveApiUrl(entry) {
  let url;
  try {
    url = new URL(entry.careers_url || '');
  } catch {
    return null;
  }
  if (url.protocol !== 'https:') return null;
  // jobs.lever.co (US) or jobs.eu.lever.co (EU) — capture the optional region.
  const hostMatch = url.hostname.match(/^jobs\.(eu\.)?lever\.co$/);
  if (!hostMatch) return null;
  const slug = url.pathname.split('/').filter(Boolean)[0];
  if (!slug) return null;
  const apiHost = hostMatch[1] ? 'api.eu.lever.co' : 'api.lever.co';
  return `https://${apiHost}/v0/postings/${slug}`;
}

/** @type {import('./_types.js').Probe} */
export const probe = {
  namesakeProne: true,
  canary: 'lever',     // Lever's own board (won't leave its own ATS) — throttle check
  endpoints: [
    { kind: 'slug', url: (s) => `https://api.lever.co/v0/postings/${s}?mode=json`, where: (s) => s,
      careersUrl: (s) => `https://jobs.lever.co/${s}`,
      parse: (d) => Array.isArray(d) ? { count: d.length, loc: d[0]?.categories?.location || '' } : null },
    // EU data-residency boards live on a separate host; probe both regions.
    { kind: 'slug', label: 'lever-eu', url: (s) => `https://api.eu.lever.co/v0/postings/${s}?mode=json`, where: (s) => `${s} (eu)`,
      careersUrl: (s) => `https://jobs.eu.lever.co/${s}`,
      parse: (d) => Array.isArray(d) ? { count: d.length, loc: d[0]?.categories?.location || '' } : null },
  ],
};

/** @type {Provider} */
export default {
  id: 'lever',

  detect(entry) {
    const apiUrl = resolveApiUrl(entry);
    return apiUrl ? { url: apiUrl } : null;
  },

  // url→identity (inverse of probe): mine jobs.lever.co / jobs.eu.lever.co links to
  // { slug, careers_url }, preserving the EU region, or null if not lever.
  mineUrl(jobUrl) {
    let u; try { u = new URL(jobUrl); } catch { return null; }
    const m = u.hostname.toLowerCase().match(/^jobs\.(eu\.)?lever\.co$/);
    if (!m) return null;
    const slug = u.pathname.split('/').filter(Boolean)[0];
    return slug ? { slug, careers_url: `https://jobs.${m[1] ? 'eu.' : ''}lever.co/${slug}` } : null;
  },

  async fetch(entry, ctx) {
    const apiUrl = resolveApiUrl(entry);
    if (!apiUrl) throw new Error(`lever: cannot derive API URL for ${entry.name}`);
    const json = await ctx.fetchJson(apiUrl);
    if (!Array.isArray(json)) return [];
    return json.map(j => {
      const cats = j.categories || {};
      const postedDate = toIsoDate(j.createdAt);  // epoch milliseconds
      const department = (cats.department || cats.team || '').trim();
      // `workplaceType` is 'remote' | 'hybrid' | 'on-site' | 'unspecified';
      // normalize to the tri-state token ('unspecified' → '' → omitted).
      const workMode = normalizeWorkMode(j.workplaceType);
      const job = {
        title: j.text || '',
        url: j.hostedUrl || '',
        company: entry.name,
        location: cats.location || '',
        ...(postedDate ? { postedDate } : {}),
        ...(department ? { department } : {}),
        ...(workMode ? { workMode } : {}),
      };
      // FREE inline detail: the postings list already carries the description
      // (descriptionPlain is ready plain text; description is HTML) → hand it to
      // the sponsorship enricher with no per-job fetch.
      const text = typeof j.descriptionPlain === 'string' && j.descriptionPlain
        ? j.descriptionPlain : stripHtml(j.description);
      return attachDetail(job, { text });
    });
  },
};
