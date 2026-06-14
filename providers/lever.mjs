// @ts-check
/** @typedef {import('./_types.js').Provider} Provider */

import { toIsoDate, normalizeWorkMode } from './_util.mjs';

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
  endpoints: [
    { kind: 'slug', url: (s) => `https://api.lever.co/v0/postings/${s}?mode=json`, where: (s) => s,
      parse: (d) => Array.isArray(d) ? { count: d.length, loc: d[0]?.categories?.location || '' } : null },
    // EU data-residency boards live on a separate host; probe both regions.
    { kind: 'slug', label: 'lever-eu', url: (s) => `https://api.eu.lever.co/v0/postings/${s}?mode=json`, where: (s) => `${s} (eu)`,
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
      return {
        title: j.text || '',
        url: j.hostedUrl || '',
        company: entry.name,
        location: cats.location || '',
        ...(postedDate ? { postedDate } : {}),
        ...(department ? { department } : {}),
        ...(workMode ? { workMode } : {}),
      };
    });
  },
};
