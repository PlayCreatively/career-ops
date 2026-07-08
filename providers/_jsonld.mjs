// @ts-check
// Shared schema.org JobPosting (JSON-LD) reader for aggregator providers.
//
// Job boards that server-render each posting almost always embed a
// schema.org/JobPosting block as <script type="application/ld+json"> — the
// authoritative title, hiringOrganization, jobLocation and datePosted for that
// posting. GameJobs.co and GameDevJobs.com (and any future board that does the
// same) read it the identical way during ENRICHMENT, so the parsing lives here
// once rather than in each provider.
//
// Files prefixed with _ are never loaded as providers by scan.mjs.

import { toIsoDate, normalizeWorkMode, splitLocationMode, stripHtml } from './_util.mjs';

// Strip a "<team/game name> in " prefix that some employers fold into the FIRST
// segment of a plain-string schema.org address. King, for one, emits e.g.
// "Candy Crush Soda Saga in Stockholm, Stockholm County, Sweden" — the team name
// glued in front of the real city. Left as-is it becomes the "primary city" and
// makes the posting's location incompatible with its clean first-party twin, so
// snapshot dedup keeps both (a visible duplicate on the board). We only touch the
// segment BEFORE the first comma, and only when it contains " in " (real city
// names never do — "San Francisco", "København", "Stockholm" have no " in "), so
// legitimate locations pass through untouched. Keep everything AFTER the last
// " in " in that segment (the actual place), plus the region/country tail.
export function cleanLdAddress(addr) {
  const s = String(addr == null ? '' : addr).trim();
  if (!s) return '';
  const comma = s.indexOf(',');
  const head = comma === -1 ? s : s.slice(0, comma);
  const tail = comma === -1 ? '' : s.slice(comma); // includes the leading comma
  const m = head.match(/^(?:.*\s)?in\s+(\S.*)$/i);
  if (!m) return s;
  const city = m[1].trim();
  return city ? `${city}${tail}` : s;
}

// Compose a place-only location string from a schema.org jobLocation node. `address`
// may be a plain string ("København 1123 DK") or a PostalAddress object; a country
// may be a bare code/string or a Country object. jobLocation itself may be an array
// (multi-site) — we take the first. Returns '' when nothing usable is present.
export function formatLdLocation(jobLocation) {
  let loc = Array.isArray(jobLocation) ? jobLocation[0] : jobLocation;
  if (!loc) return '';
  if (typeof loc === 'string') return cleanLdAddress(loc);
  if (typeof loc !== 'object') return '';
  const a = loc.address;
  if (typeof a === 'string') return cleanLdAddress(a);
  if (a && typeof a === 'object') {
    const val = (x) =>
      typeof x === 'string' ? x.trim()
        : x && typeof x === 'object' && typeof x.name === 'string' ? x.name.trim()
          : '';
    const parts = [a.addressLocality, a.addressRegion, a.addressCountry].map(val).filter(Boolean);
    // Dedupe (region/country often repeat) while preserving order.
    return [...new Set(parts)].join(', ');
  }
  return '';
}

// Pull the JobPosting fields we care about out of a posting page's JSON-LD. A page
// can carry several ld+json blocks (BreadcrumbList, Organization, …) and the
// JobPosting may sit inside an `@graph`; we scan all of them for the first
// JobPosting. Returns null when none parses — the caller then keeps its slug
// fallback. Never throws.
export function parseJobPostingLd(html) {
  if (typeof html !== 'string' || !html) return null;
  const re = /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = re.exec(html))) {
    let data;
    try { data = JSON.parse(m[1].trim()); } catch { continue; }
    const nodes = Array.isArray(data)
      ? data
      : Array.isArray(data?.['@graph']) ? data['@graph'] : [data];
    for (const node of nodes) {
      if (!node || typeof node !== 'object') continue;
      const type = node['@type'];
      const isJob = type === 'JobPosting' || (Array.isArray(type) && type.includes('JobPosting'));
      if (!isJob) continue;

      const org = node.hiringOrganization;
      const company = typeof org === 'string' ? org.trim()
        : org && typeof org === 'object' && typeof org.name === 'string' ? org.name.trim()
          : '';
      const rawLoc = formatLdLocation(node.jobLocation);
      const { location, workMode: wmFromText } = splitLocationMode(rawLoc);
      // A structured TELECOMMUTE flag wins over anything inferred from the text.
      const wmStructured = node.jobLocationType === 'TELECOMMUTE' ? 'remote' : '';
      const workMode = normalizeWorkMode(wmStructured) || wmFromText;
      const postedDate = toIsoDate(node.datePosted);
      // Plain-text description body — consumed by detail-phase enrichers
      // (e.g. sponsorship detection), not shown on the board. schema.org stores
      // it as escaped HTML; strip to readable prose. Omitted when absent.
      const description = stripHtml(node.description);

      return {
        title: typeof node.title === 'string' ? node.title.trim() : '',
        company,
        location,
        ...(workMode ? { workMode } : {}),
        ...(postedDate ? { postedDate } : {}),
        ...(description ? { description } : {}),
      };
    }
  }
  return null;
}
