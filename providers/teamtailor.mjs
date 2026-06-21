// @ts-check
/** @typedef {import('./_types.js').Provider} Provider */

import { toIsoDate } from './_util.mjs';

// Teamtailor provider — hits the public JSON Feed every Teamtailor career site
// ships at `{site-origin}/jobs.json` (JSON Feed 1.1). No auth, no scraping: the
// feed is the same one Teamtailor exposes for syndication, so this is as clean
// and account-safe as the greenhouse/lever providers.
//
// Unlike Hitmarker (one aggregated board), Teamtailor is per-company — like
// greenhouse/lever, you add one tracked_companies entry per studio. Teamtailor
// sites commonly run on a custom domain (e.g. careers.envarstudio.com) as well
// as the default `{slug}.teamtailor.com`, so routing is primarily via an
// explicit `provider: teamtailor`, with detect() claiming *.teamtailor.com as a
// convenience:
//
//   tracked_companies:
//     - name: Envar Studio
//       provider: teamtailor
//       careers_url: https://careers.envarstudio.com
//
// careers_url may be the site root or any page on it (e.g. a pasted job URL) —
// the feed URL is derived from its origin.

// Derive the JSON Feed URL from any URL on a Teamtailor career site. An explicit
// `feed_url` entry wins, so an unusual deployment can be pinned by hand.
function resolveFeedUrl(entry) {
  if (typeof entry.feed_url === 'string' && entry.feed_url.trim()) return entry.feed_url.trim();
  const raw = entry.careers_url || '';
  let origin;
  try {
    origin = new URL(raw).origin;
  } catch {
    return null;
  }
  if (!origin.startsWith('https:')) return null;
  return `${origin}/jobs.json`;
}

// Compose "City, Country" from a schema.org Place. Teamtailor studios fill the
// address inconsistently (a "Remote" role may still carry an office address), so
// this is surface-level location only — good enough for rank.mjs triage.
function formatLocation(place) {
  const addr = place?.address;
  if (!addr || typeof addr !== 'object') return '';
  const city = typeof addr.addressLocality === 'string' ? addr.addressLocality.trim() : '';
  const country = typeof addr.addressCountry === 'string' ? addr.addressCountry.trim() : '';
  if (city && country && country !== city) return `${city}, ${country}`;
  return city || country;
}

export function parseTeamtailorFeed(json, fallbackCompany) {
  const items = Array.isArray(json?.items) ? json.items : [];
  return items
    .filter(it => it && it.title && it.url)
    .map(it => {
      const posting = it._jobposting || {};
      const place = Array.isArray(posting.jobLocation) ? posting.jobLocation[0] : posting.jobLocation;
      const org = posting.hiringOrganization?.name;
      // The feed carries a JSON Feed `date_published` (mirrored by the
      // schema.org `datePosted`); it does not expose a structured remote flag
      // or a department, so only postedDate is set.
      const postedDate = toIsoDate(it.date_published || posting.datePosted);
      return {
        title: String(it.title),
        url: String(it.url),
        company: typeof org === 'string' && org.trim() ? org.trim() : (fallbackCompany || ''),
        location: formatLocation(place),
        ...(postedDate ? { postedDate } : {}),
      };
    });
}

// jsonfeed-shaped /jobs.json is the Teamtailor fingerprint (guards against a
// random site that happens to serve a /jobs.json).
const ttParse = (d) =>
  (Array.isArray(d?.items) && typeof d.version === 'string' && d.version.includes('jsonfeed'))
    ? { count: d.items.length, loc: '' } : null;

/** @type {import('./_types.js').Probe} */
export const probe = {
  namesakeProne: true, // {tenant}.teamtailor.com subdomain slugs collide with non-game namesakes (own-domain endpoint below stays HIGH)
  canary: 'polestar',  // known-live tenant — proves teamtailor isn't throttling/blocking us
  endpoints: [
    { kind: 'slug', url: (s) => `https://${s}.teamtailor.com/jobs.json`, where: (s) => `${s}.teamtailor.com`, careersUrl: (s) => `https://${s}.teamtailor.com`, parse: ttParse },
    // Many TT studios run on a custom domain — sweep the studio's own host too.
    { kind: 'domain', confidence: 'high', url: (host) => `https://${host}/jobs.json`, where: (host) => host, careersUrl: (host) => `https://${host}`, parse: ttParse },
  ],
};

/** @type {Provider} */
export default {
  id: 'teamtailor',

  // Claim the default *.teamtailor.com domains automatically. Custom domains
  // can't be detected by host, so those route via explicit provider: teamtailor.
  detect(entry) {
    let host;
    try {
      host = new URL(entry.careers_url || '').hostname.toLowerCase();
    } catch {
      return null;
    }
    if (host !== 'teamtailor.com' && !host.endsWith('.teamtailor.com')) return null;
    const feedUrl = resolveFeedUrl(entry);
    return feedUrl ? { url: feedUrl } : null;
  },

  async fetch(entry, ctx) {
    const feedUrl = resolveFeedUrl(entry);
    if (!feedUrl) throw new Error(`teamtailor: cannot derive feed URL for ${entry.name} — set careers_url (https) or feed_url`);
    // redirect:'error' blocks redirect-based SSRF; the host is trusted user
    // config (portals.yml), so no allowlist is enforced beyond requiring https.
    const json = await ctx.fetchJson(feedUrl, { redirect: 'error' });
    return parseTeamtailorFeed(json, entry.name);
  },
};
