// @ts-check
/** @typedef {import('./_types.js').Provider} Provider */

import { toIsoDate } from './_util.mjs';

// Breezy HR provider — hits the public positions feed every Breezy career site
// ships at `{tenant-origin}/json`. No auth, no scraping: it's the same JSON the
// public careers page renders from, so this is as clean and account-safe as the
// greenhouse / lever / teamtailor providers.
//
// Per-company (like greenhouse/lever, NOT Hitmarker): one tracked_companies entry
// per studio. Breezy tenants live at `{slug}.breezy.hr`, which detect() claims
// automatically (skipping Breezy's own marketing/app subdomains). A studio on a
// custom domain (rare) routes via an explicit `provider: breezy` + careers_url
// (or feed_url):
//
//   tracked_companies:
//     - name: Pine Creek Games
//       careers_url: https://pine-creek-games.breezy.hr
//
// careers_url may be the site root or any page on it (a pasted job URL) — the
// feed URL is derived from its origin.

// Breezy subdomains that are NOT customer tenants (marketing / app surfaces). A
// careers_url on one of these is Breezy itself, not a studio, so detect() skips it.
const RESERVED_SUBDOMAINS = new Set([
  'www', 'app', 'marketing', 'support', 'help', 'status', 'api', 'blog',
  'login', 'secure', 'account', 'developer', 'developers',
]);

// Derive the JSON feed URL from any URL on a Breezy tenant. An explicit
// `feed_url` wins so an unusual deployment can be pinned by hand. Requires https;
// returns null otherwise. Does NOT enforce the .breezy.hr host here (custom
// domains route in via an explicit provider:); the host check lives in detect().
function resolveFeedUrl(entry) {
  if (typeof entry.feed_url === 'string' && entry.feed_url.trim()) return entry.feed_url.trim();
  const raw = typeof entry.careers_url === 'string' ? entry.careers_url : '';
  let origin;
  try {
    origin = new URL(raw).origin;
  } catch {
    return null;
  }
  if (!origin.startsWith('https:')) return null;
  return `${origin}/json`;
}

// Compose a human-readable location from a Breezy location object. Breezy fills
// `name` inconsistently (sometimes a city, sometimes the country), so compose
// "City, Country" only when both are present and distinct, else whichever exists.
function formatLocation(loc) {
  if (!loc || typeof loc !== 'object') return '';
  const name = typeof loc.name === 'string' ? loc.name.trim() : '';
  const country = typeof loc.country?.name === 'string' ? loc.country.name.trim() : '';
  if (name && country && name.toLowerCase() !== country.toLowerCase()) return `${name}, ${country}`;
  return name || country;
}

/**
 * Parse Breezy's public `/json` positions feed (a top-level JSON array). Exported
 * for unit tests. Each element exposes `name` (title), `url`, an optional nested
 * `company.name`, a `location` object (with `is_remote` + `remote_details`), a
 * `department`, and a `published_date`. Items missing name or url are dropped.
 *
 * @param {unknown} json — parsed feed body
 * @param {string} fallbackCompany — used when the item has no company.name
 */
export function parseBreezyFeed(json, fallbackCompany) {
  const items = Array.isArray(json) ? json : [];
  return items
    .filter(it => it && it.name && it.url)
    .map(it => {
      const loc = it.location || (Array.isArray(it.locations) ? it.locations[0] : null);
      const org = it.company?.name;
      const postedDate = toIsoDate(it.published_date);
      const department = typeof it.department === 'string' ? it.department.trim() : '';
      // is_remote → workMode. remote_details.value distinguishes "anywhere"
      // (no geo constraint) from a region-scoped remote ("remote-location").
      let workMode = '';
      if (loc?.is_remote) {
        const rd = String(loc.remote_details?.value || '').toLowerCase();
        workMode = rd.includes('anywhere') ? 'anywhere' : 'remote';
      }
      return {
        title: String(it.name),
        url: String(it.url),
        company: typeof org === 'string' && org.trim() ? org.trim() : (fallbackCompany || ''),
        location: formatLocation(loc),
        ...(postedDate ? { postedDate } : {}),
        ...(workMode ? { workMode } : {}),
        ...(department ? { department } : {}),
      };
    });
}

/** @type {import('./_types.js').Probe} */
export const probe = {
  namesakeProne: true, // {tenant}.breezy.hr subdomain slugs collide with non-game namesakes
  // Breezy IP-throttles with 403 (not 404), but it CAN regress to 404-style
  // hiding under a WAF — so a known-live tenant guards the probe's 404 trust.
  // pine-creek-games is a confirmed real Breezy tenant (Winter Burrow devs); if
  // its /json stops returning an array, Breezy is unhealthy and 404s are distrusted.
  canary: 'pine-creek-games',
  endpoints: [{
    kind: 'slug',
    // A dead slug 200s with the marketing HTML page (non-JSON), so a parsed
    // array proves a real tenant — even an empty [] means they use Breezy.
    url: (s) => `https://${s}.breezy.hr/json`,
    where: (s) => `${s}.breezy.hr`,
    careersUrl: (s) => `https://${s}.breezy.hr`,
    parse: (d) => Array.isArray(d) ? { count: d.length, loc: d[0]?.location?.name || '' } : null,
  }],
};

/** @type {Provider} */
export default {
  id: 'breezy',

  // Claim the default *.breezy.hr tenant domains automatically. Bare breezy.hr
  // and reserved marketing/app subdomains are not tenants. Custom domains can't
  // be detected by host, so those route via explicit provider: breezy.
  detect(entry) {
    let host;
    try {
      host = new URL(entry.careers_url || '').hostname.toLowerCase();
    } catch {
      return null;
    }
    if (host !== 'breezy.hr' && !host.endsWith('.breezy.hr')) return null;
    if (host === 'breezy.hr' || RESERVED_SUBDOMAINS.has(host.split('.')[0])) return null;
    const feedUrl = resolveFeedUrl(entry);
    return feedUrl ? { url: feedUrl } : null;
  },

  // url→identity (inverse of probe): mine a {slug}.breezy.hr link to { slug, careers_url };
  // careers_url is the tenant origin. Bare/reserved hosts aren't tenants → null.
  mineUrl(jobUrl) {
    let u; try { u = new URL(jobUrl); } catch { return null; }
    const h = u.hostname.toLowerCase();
    if (h === 'breezy.hr' || !h.endsWith('.breezy.hr')) return null;
    const sub = h.split('.')[0];
    return (sub && !RESERVED_SUBDOMAINS.has(sub)) ? { slug: sub, careers_url: u.origin } : null;
  },

  async fetch(entry, ctx) {
    const feedUrl = resolveFeedUrl(entry);
    if (!feedUrl) throw new Error(`breezy: cannot derive feed URL for ${entry.name} — set careers_url (https) or feed_url`);
    // redirect:'error' blocks redirect-based SSRF; the host is trusted user
    // config (studios.yml/portals.yml), so no allowlist is enforced beyond https.
    const json = await ctx.fetchJson(feedUrl, { redirect: 'error' });
    return parseBreezyFeed(json, entry.name);
  },
};
