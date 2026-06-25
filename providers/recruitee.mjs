// @ts-check
/** @typedef {import('./_types.js').Provider} Provider */

import { toIsoDate } from './_util.mjs';

// Recruitee provider — hits the public per-tenant offers API.
// Auto-detects from careers_url pattern `https://<slug>.recruitee.com`.
// Per-tenant subdomains are the variable part — SSRF defence uses a
// regex match on `<safe-slug>.recruitee.com` rather than a static
// allowlist.

const RECRUITEE_HOST_RE = /^[a-z0-9][a-z0-9-]*\.recruitee\.com$/;

function assertRecruiteeUrl(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`recruitee: invalid URL: ${url}`);
  }
  if (parsed.protocol !== 'https:') throw new Error(`recruitee: URL must use HTTPS: ${url}`);
  if (!RECRUITEE_HOST_RE.test(parsed.hostname)) {
    throw new Error(`recruitee: untrusted hostname "${parsed.hostname}" — must match <slug>.recruitee.com`);
  }
  return url;
}

function resolveApiUrl(entry) {
  const raw = typeof entry.careers_url === 'string' ? entry.careers_url : '';
  if (!raw) return null;
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'https:') return null;
  if (!RECRUITEE_HOST_RE.test(parsed.hostname)) return null;
  return `https://${parsed.hostname}/api/offers/`;
}

const rcParse = (d) => (d && Array.isArray(d.offers)) ? { count: d.offers.length, loc: d.offers[0]?.location || '' } : null;

/** @type {import('./_types.js').Probe} */
export const probe = {
  canary: 'tellent', // Recruitee's own corporate tenant (it rebranded to Tellent post-acquisition; the old `recruitee` slug now 404s) — throttle check
  endpoints: [
    { kind: 'slug', url: (s) => `https://${s}.recruitee.com/api/offers/`, where: (s) => `${s}.recruitee.com`, careersUrl: (s) => `https://${s}.recruitee.com`, parse: rcParse },
    { kind: 'domain', confidence: 'high', url: (host) => `https://${host}/api/offers/`, where: (host) => host, careersUrl: (host) => `https://${host}`, parse: rcParse },
  ],
};

/** @type {Provider} */
export default {
  id: 'recruitee',

  detect(entry) {
    const apiUrl = resolveApiUrl(entry);
    return apiUrl ? { url: apiUrl } : null;
  },

  // url→identity (inverse of probe): mine a {slug}.recruitee.com link to { slug, careers_url }.
  mineUrl(jobUrl) {
    let u; try { u = new URL(jobUrl); } catch { return null; }
    const h = u.hostname.toLowerCase();
    if (!RECRUITEE_HOST_RE.test(h)) return null;
    const sub = h.split('.')[0];
    return (sub && sub !== 'www') ? { slug: sub, careers_url: `https://${sub}.recruitee.com` } : null;
  },

  async fetch(entry, ctx) {
    const apiUrl = resolveApiUrl(entry);
    if (!apiUrl) throw new Error(`recruitee: cannot derive API URL for ${entry.name}`);
    assertRecruiteeUrl(apiUrl);
    const json = await ctx.fetchJson(apiUrl, { redirect: 'error' });
    return parseRecruiteeResponse(json, entry.name);
  },
};

/**
 * Parse a Recruitee /api/offers/ response. Exported for unit tests.
 *
 * Recruitee returns:
 *   { offers: [{ title, careers_url?, url?, city?, country?, remote?, location? }] }
 *
 * - url: prefer `careers_url`, fall back to `url`; validated against
 *   `https://<safe-slug>.recruitee.com` — an off-domain or non-HTTPS URL is
 *   dropped (empty string returned per the Job contract).
 * - location: prefer the explicit `location` field; else assemble from
 *   city/country. Remoteness is carried by the structured `workMode` field
 *   (from the remote/hybrid/on_site booleans), not appended to the text.
 *
 * @param {any} json
 * @param {string} companyName
 * @returns {Array<{title: string, url: string, company: string, location: string}>}
 */
export function parseRecruiteeResponse(json, companyName) {
  const offers = json?.offers;
  if (!Array.isArray(offers)) return [];
  return offers.map(j => {
    const city = j.city || '';
    const country = j.country || '';
    // Location stays place-only; remoteness is carried by workMode (below).
    const location = j.location || [city, country].filter(Boolean).join(', ');

    // Validate offer URL: must parse as https://<safe-slug>.recruitee.com/...
    let url = '';
    const rawUrl = j.careers_url || j.url || '';
    if (typeof rawUrl === 'string' && rawUrl) {
      try {
        const parsed = new URL(rawUrl);
        if (parsed.protocol === 'https:' && RECRUITEE_HOST_RE.test(parsed.hostname)) {
          url = parsed.href;
        }
      } catch {
        // malformed URL → leave url = ''
      }
    }

    // `published_at`/`created_at` arrive as "YYYY-MM-DD HH:mm:ss UTC".
    const postedDate = toIsoDate(j.published_at || j.created_at);
    const department = (typeof j.department === 'string' ? j.department : '').trim();
    // Recruitee exposes three independent booleans rather than one field;
    // resolve them to the tri-state token (remote wins, then hybrid, then onsite).
    const workMode = j.remote ? 'remote' : j.hybrid ? 'hybrid' : j.on_site ? 'onsite' : '';
    return {
      title: j.title || '',
      url,
      location,
      company: companyName,
      ...(postedDate ? { postedDate } : {}),
      ...(department ? { department } : {}),
      ...(workMode ? { workMode } : {}),
    };
  });
}
