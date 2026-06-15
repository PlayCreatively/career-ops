// @ts-check
/** @typedef {import('./_types.js').Provider} Provider */

import { toIsoDate } from './_util.mjs';

// Greenhouse provider — hits the public boards-api JSON endpoint.
// Handles both explicit `api:` URLs and auto-detection from `careers_url`.

const ALLOWED_GREENHOUSE_HOSTS = new Set([
  'boards-api.greenhouse.io',
  'boards.greenhouse.io',
  'job-boards.greenhouse.io',
  'job-boards.eu.greenhouse.io',
]);

function assertGreenhouseUrl(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`greenhouse: invalid URL: ${url}`);
  }
  if (parsed.protocol !== 'https:') throw new Error(`greenhouse: URL must use HTTPS: ${url}`);
  if (!ALLOWED_GREENHOUSE_HOSTS.has(parsed.hostname))
    throw new Error(`greenhouse: untrusted hostname "${parsed.hostname}" — must be one of: ${[...ALLOWED_GREENHOUSE_HOSTS].join(', ')}`);
  return url;
}

function resolveApiUrl(entry) {
  if (entry.api) {
    assertGreenhouseUrl(entry.api);
    return entry.api;
  }
  const url = entry.careers_url || '';
  const match = url.match(/job-boards(?:\.eu)?\.greenhouse\.io\/([^/?#]+)/);
  if (match) return `https://boards-api.greenhouse.io/v1/boards/${match[1]}/jobs`;
  return null;
}

/** @type {import('./_types.js').Probe} */
export const probe = {
  namesakeProne: true, // single-word board slugs collide with non-game namesakes
  canary: 'stripe',    // known-live tenant — proves greenhouse isn't throttling/blocking us
  endpoints: [{
    kind: 'slug',
    url: (s) => `https://boards-api.greenhouse.io/v1/boards/${s}/jobs`,
    where: (s) => s,
    parse: (d) => (d && Array.isArray(d.jobs)) ? { count: d.jobs.length, loc: d.jobs[0]?.location?.name || '' } : null,
  }],
};

/** @type {Provider} */
export default {
  id: 'greenhouse',

  detect(entry) {
    try {
      const apiUrl = resolveApiUrl(entry);
      return apiUrl ? { url: apiUrl } : null;
    } catch {
      return null;
    }
  },

  async fetch(entry, ctx) {
    const apiUrl = resolveApiUrl(entry);
    if (!apiUrl) throw new Error(`greenhouse: cannot derive API URL for ${entry.name}`);
    assertGreenhouseUrl(apiUrl);
    // redirect:'error' prevents SSRF via server-side redirects; combined with
    // assertGreenhouseUrl above it guarantees the final hostname stays in the allowlist.
    const json = await ctx.fetchJson(apiUrl, { redirect: 'error' });
    const jobs = Array.isArray(json?.jobs) ? json.jobs : [];
    return jobs.filter(j => j.absolute_url).map(j => {
      // `first_published` is the true posting date; `updated_at` is the last
      // edit (re-published roles bump it). The basic /jobs feed exposes neither
      // a structured remote flag nor a department, so only postedDate is set.
      const postedDate = toIsoDate(j.first_published || j.updated_at);
      return {
        title: j.title || '',
        url: j.absolute_url,
        company: entry.name,
        location: j.location?.name || '',
        ...(postedDate ? { postedDate } : {}),
      };
    });
  },
};
