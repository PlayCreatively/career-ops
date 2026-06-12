// @ts-check
/** @typedef {import('./_types.js').Provider} Provider */

import { toIsoDate } from './_util.mjs';

// Hitmarker provider — the largest games / esports job board.
//
// Unlike the per-company ATS providers (greenhouse, lever, ...), Hitmarker is a
// single aggregated board: one tracked_companies entry yields postings across
// many studios. Configure it in portals.yml with an explicit provider and,
// optionally, a free-text query plus a Typesense `filter_by` expression:
//
//   tracked_companies:
//     - name: Hitmarker — Gameplay/Design (EU, entry-junior)
//       provider: hitmarker
//       query: "gameplay programmer"          # optional, defaults to "*"
//       filter_by: "jobTags.id:[122733,122732] && jobLevel.id:[entry,junior]"
//       pages: 2                                # optional, defaults to 1
//
// Hitmarker's backend is Typesense; we hit its public multi_search endpoint
// with the scoped search-only key the site itself ships to browsers. The key's
// base64 tail decodes to {"exclude_fields":"...","limit_multi_searches":10000},
// i.e. it is search-only and cannot mutate data.

const HITMARKER_ENDPOINT = 'https://search.hitmarker.com/multi_search';
const HITMARKER_KEY =
  'QjFTckNNRFBWR2JOWjBvMUdlWmpEMUlYUEJJNnNnTFV6dEcxQVhvb28rVT1YNHFieyJleGNsdWRlX2ZpZWxkcyI6InRvdGFsQ291bnQsYWx0U2VhcmNoVGVybXMsYXV0aG9yIiwibGltaXRfbXVsdGlfc2VhcmNoZXMiOjEwMDAwfQ==';
const COLLECTION = 'hitmarker_jobs_open';
const PER_PAGE = 100;
const MAX_PAGES = 10; // hard cap so a misconfigured entry can't paginate forever

// Compose a human-readable location from a Hitmarker jobLocation entry, e.g.
// "Guildford, UK" — falls back gracefully when parents/title are missing.
function formatLocation(loc) {
  if (!loc || typeof loc !== 'object') return '';
  const city = typeof loc.title === 'string' ? loc.title.trim() : '';
  const parents = Array.isArray(loc.parents) ? loc.parents : [];
  const country = parents.find(p => p?.type === 'country')?.title;
  if (city && country && country !== city) return `${city}, ${country}`;
  return city || (typeof country === 'string' ? country : '');
}

export function parseHitmarkerResponse(json) {
  const hits = json?.results?.[0]?.hits;
  if (!Array.isArray(hits)) return [];
  return hits
    .map(h => h?.document)
    .filter(doc => doc && doc.title && doc.url)
    .map(doc => {
      // `postDate` is a Unix epoch in SECONDS. No structured remote flag or
      // department in the Typesense document, so only postedDate is set.
      const postedDate = toIsoDate(doc.postDate);
      return {
        title: String(doc.title),
        url: String(doc.url),
        company: doc.jobCompany?.title ? String(doc.jobCompany.title) : '',
        location: formatLocation(Array.isArray(doc.jobLocation) ? doc.jobLocation[0] : null),
        ...(postedDate ? { postedDate } : {}),
      };
    });
}

async function fetchPage(ctx, { query, filterBy, page }) {
  const search = {
    collection: COLLECTION,
    q: query,
    query_by: 'title,jobLocation.title,jobCompany.title',
    per_page: PER_PAGE,
    page,
  };
  if (filterBy) search.filter_by = filterBy;
  return ctx.fetchJson(HITMARKER_ENDPOINT, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-typesense-api-key': HITMARKER_KEY,
    },
    body: JSON.stringify({ searches: [search] }),
    redirect: 'error',
  });
}

/** @type {Provider} */
export default {
  id: 'hitmarker',

  // Hitmarker is opt-in via `provider: hitmarker`, but also claim entries whose
  // careers_url points at hitmarker.net so a pasted board URL routes here too.
  detect(entry) {
    let host;
    try {
      host = new URL(entry.careers_url || '').hostname.toLowerCase();
    } catch {
      return null;
    }
    return host === 'hitmarker.net' || host.endsWith('.hitmarker.net')
      ? { url: HITMARKER_ENDPOINT }
      : null;
  },

  async fetch(entry, ctx) {
    const query = typeof entry.query === 'string' && entry.query.trim() ? entry.query.trim() : '*';
    const filterBy = typeof entry.filter_by === 'string' ? entry.filter_by.trim() : '';
    const requested = Number.isInteger(entry.pages) && entry.pages > 0 ? entry.pages : 1;
    const pages = Math.min(requested, MAX_PAGES);

    const jobs = [];
    for (let page = 1; page <= pages; page++) {
      const json = await fetchPage(ctx, { query, filterBy, page });
      const batch = parseHitmarkerResponse(json);
      jobs.push(...batch);
      // Stop early once a page comes back short — no more results to page through.
      if (batch.length < PER_PAGE) break;
    }
    return jobs;
  },
};
