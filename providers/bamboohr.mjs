// @ts-check
/** @typedef {import('./_types.js').Provider} Provider */

import { normalizeWorkMode } from './_util.mjs';

// BambooHR provider — hits the keyless public careers JSON every BambooHR tenant
// ships at `{tenant}.bamboohr.com/careers/list`. No auth, no scraping: it's the
// same JSON the public careers page consumes. Per-company like greenhouse/lever:
// one tracked_companies entry per studio.
//
// The list endpoint returns the WHOLE board in a single response
// ({meta:{totalCount}, result:[…]}) — result.length === totalCount, verified on
// live tenants — so there is no pagination. Each item already carries the title,
// department, and a structured location, so we never need the per-job
// `/careers/{id}/detail` call (which only adds the JD body and a posting date).
// One request per studio, zero tokens.
//
// Routing: BambooHR tenants live at `{tenant}.bamboohr.com`, so detect() claims
// the *.bamboohr.com host automatically; a custom-domain deployment can still be
// pinned with explicit `provider: bamboohr` + a careers_url on the tenant host.
//
// The list carries no posting date (only the detail page does), so jobs from
// this provider have no postedDate.

// Derive the list endpoint from any URL on a BambooHR careers site. An explicit
// `feed_url` wins so an unusual deployment can be pinned by hand.
function resolveListUrl(entry) {
  if (entry && typeof entry.feed_url === 'string' && entry.feed_url.trim()) return entry.feed_url.trim();
  const raw = (entry && entry.careers_url) || '';
  let origin;
  try {
    origin = new URL(raw).origin;
  } catch {
    return null;
  }
  if (!origin.startsWith('https:')) return null;
  return `${origin}/careers/list`;
}

function originOf(entry) {
  try { return new URL((entry && (entry.feed_url || entry.careers_url)) || '').origin; } catch { return ''; }
}

function clean(s) {
  return String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
}

// Compose a place-only location from BambooHR's two location shapes. The plain
// `location` ({city, state}) is the cleanest source; `atsLocation` adds a country
// but its `city` is sometimes a full address string ("Royal Leamington Spa,
// England, United Kingdom"), so we take only its first comma-segment as a
// fallback. Segments are de-duplicated (city/state/country can repeat).
function formatLocation(item) {
  const loc = (item && item.location) || {};
  const ats = (item && item.atsLocation) || {};
  const city = clean(String(loc.city || ats.city || '').split(',')[0]);
  const state = clean(loc.state || ats.state || '');
  const country = clean(ats.country || '');
  const parts = [];
  for (const p of [city, state, country]) {
    if (p && !parts.includes(p)) parts.push(p);
  }
  return parts.join(', ');
}

/**
 * Parse a BambooHR `/careers/list` payload into job rows. Exported for unit tests.
 * Builds the public URL `{origin}/careers/{id}` (verified 200, the human-facing
 * job page) from each item's id.
 *
 * @param {any} json — the parsed `{meta, result}` payload
 * @param {string} origin — the tenant origin (e.g. https://owi.bamboohr.com)
 * @param {string} fallbackCompany — written into job.company
 * @returns {Array<{title: string, url: string, company: string, location: string}>}
 */
export function parseBambooList(json, origin, fallbackCompany) {
  const result = json && Array.isArray(json.result) ? json.result : [];
  const jobs = [];
  const seen = new Set();
  for (const item of result) {
    if (!item || item.id == null) continue;
    const id = String(item.id);
    const title = clean(item.jobOpeningName);
    if (!id || !title) continue;
    const url = origin ? `${origin}/careers/${id}` : '';
    if (!url || seen.has(url)) continue;
    seen.add(url);
    const department = clean(item.departmentLabel);
    // isRemote is the only structured work-mode signal; locationType is an
    // opaque enum we don't trust. Fall back to scanning the location string.
    let workMode = item.isRemote === true ? 'remote' : '';
    const location = formatLocation(item);
    if (!workMode) workMode = normalizeWorkMode(location);
    jobs.push({
      title,
      url,
      company: fallbackCompany || '',
      location,
      ...(department ? { department } : {}),
      ...(workMode ? { workMode } : {}),
    });
  }
  return jobs;
}

// A {meta, result[]} payload is the BambooHR fingerprint (guards against a random
// host that happens to answer /careers/list).
const bhrParse = (d) =>
  (d && d.meta && Array.isArray(d.result)) ? { count: d.result.length, loc: '' } : null;

/** @type {import('./_types.js').Probe} */
export const probe = {
  namesakeProne: true, // {tenant}.bamboohr.com subdomain slugs collide with non-game namesakes (pharma/construction/etc.)
  canary: 'owi', // Offworld Industries — known-live tenant; proves bamboohr isn't blocking us
  endpoints: [
    { kind: 'slug', url: (s) => `https://${s}.bamboohr.com/careers/list`, where: (s) => `${s}.bamboohr.com`, careersUrl: (s) => `https://${s}.bamboohr.com/careers`, parse: bhrParse },
  ],
};

/** @type {Provider} */
export default {
  id: 'bamboohr',

  detect(entry) {
    let host;
    try {
      host = new URL((entry && entry.careers_url) || '').hostname.toLowerCase();
    } catch {
      return null;
    }
    if (host !== 'bamboohr.com' && !host.endsWith('.bamboohr.com')) return null;
    const listUrl = resolveListUrl(entry);
    return listUrl ? { url: listUrl } : null;
  },

  async fetch(entry, ctx) {
    const listUrl = resolveListUrl(entry);
    if (!listUrl) throw new Error(`bamboohr: cannot derive list URL for ${entry && entry.name} — set careers_url (https on the .bamboohr.com tenant) or feed_url`);
    const origin = originOf(entry);
    // redirect:'error' blocks redirect-based SSRF; the tenant host is trusted
    // user config (portals.yml), so no allowlist beyond requiring https.
    const json = await ctx.fetchJson(listUrl, { redirect: 'error' });
    return parseBambooList(json, origin, entry && entry.name);
  },
};
