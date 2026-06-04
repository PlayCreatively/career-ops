// @ts-check
/** @typedef {import('./_types.js').Provider} Provider */

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
    return json.map(j => ({
      title: j.text || '',
      url: j.hostedUrl || '',
      company: entry.name,
      location: j.categories?.location || '',
    }));
  },
};
