// @ts-check
/** @typedef {import('./_types.js').Provider} Provider */

import { toIsoDate, slugifyTitle, normalizeWorkMode } from './_util.mjs';

// Phenom (Phenom People) provider — the career-site CMS behind careers.blizzard.com,
// careers.activision.com, careers.infinityward.com and many others. Each tenant
// renders its job list client-side, but the search-results page server-embeds the
// current page of jobs in a `phApp.ddo … "data":{"jobs":[…]}` blob. We page through
// `<base>/search-results?from=N&s=1` (10 per page) and parse that blob — zero-token,
// one HTML GET per page, no per-job request.
//
// WHY multiple rounds: the SSR result set is ordered by a NON-STABLE relevance sort,
// so paging by `from` over it overlaps and drops rows — a single crawl returns only
// ~80% of `totalHits`, and which 80% varies per request. Forcing `sortBy=Most recent`
// makes paging stable but silently buries undated/evergreen reqs (worse coverage).
// Instead we crawl the unsorted feed repeatedly and union by jobSeqNo: each pass
// reshuffles and surfaces the stragglers, converging on the full set in 2-3 passes.
// The JSON widgets API would be one clean request, but it's gated behind a Play
// CSRF handshake + bot checks that reject a plain fetch.
//
// Opt-in only via `provider: phenom` (Phenom serves thousands of unrelated tenants,
// so there is no safe host-based auto-detect). The `careers_url` is the tenant's
// locale base — the path the site lives under, e.g.:
//
//   tracked_companies:
//     - name: Blizzard Entertainment
//       provider: phenom
//       careers_url: https://careers.blizzard.com/global/en
//     - name: Activision
//       provider: phenom
//       careers_url: https://careers.activision.com
//
// The job apply link on these tenants often points back at a bot-protected Workday
// (e.g. xboxgaming.wd1.myworkdayjobs.com), so we link to the public Phenom job
// detail page instead: `<base>/job/<jobSeqNo>/<title-slug>` (verified to resolve).

const PAGE_SIZE = 10;          // Phenom increments `from` by 10 (page-size override is ignored)
const MAX_ROUNDS = 8;          // re-crawl passes to union away the reshuffle (usually 2-3 suffice)
const MAX_FETCHES = 200;       // hard ceiling on total page GETs per company, runaway guard

// Resolve the locale base from careers_url: origin + path, minus a trailing slash
// and a trailing `/search-results` segment if the user pasted the search page itself.
function resolveBase(entry) {
  const raw = typeof entry.careers_url === 'string' ? entry.careers_url.trim() : '';
  if (!raw) return null;
  let u;
  try { u = new URL(raw); } catch { return null; }
  let pathName = u.pathname.replace(/\/+$/, '');
  pathName = pathName.replace(/\/search-results$/i, '');
  return `${u.origin}${pathName}`;
}

/**
 * Pull the embedded job array out of one Phenom search-results page. Exported for
 * unit tests. The page embeds exactly one `…"data":{"jobs":[ … ]}` blob inside
 * `phApp.ddo`; we locate the first `"jobs":[`, then read object-by-object with a
 * string-aware brace matcher (job descriptions contain stray `{`/`}` and quotes,
 * so a naive regex or bracket count would mis-slice).
 *
 * @param {string} html
 * @returns {Array<object>} raw Phenom job records (unmapped)
 */
export function parsePhenomJobs(html) {
  const key = html.indexOf('"jobs":[');
  if (key === -1) return [];
  let i = html.indexOf('[', key) + 1;
  const out = [];
  while (i < html.length) {
    // Skip whitespace and commas between elements.
    while (i < html.length && (html[i] === ' ' || html[i] === '\n' || html[i] === '\r' || html[i] === '\t' || html[i] === ',')) i++;
    if (i >= html.length || html[i] === ']') break; // end of the array
    if (html[i] !== '{') break;                     // not an object array — bail
    const start = i;
    let depth = 0, inStr = false, esc = false;
    for (; i < html.length; i++) {
      const c = html[i];
      if (inStr) {
        if (esc) esc = false;
        else if (c === '\\') esc = true;
        else if (c === '"') inStr = false;
      } else if (c === '"') {
        inStr = true;
      } else if (c === '{') {
        depth++;
      } else if (c === '}') {
        depth--;
        if (depth === 0) { i++; break; }
      }
    }
    const slice = html.slice(start, i);
    try { out.push(JSON.parse(slice)); } catch { /* skip an unparseable record, keep going */ }
  }
  return out;
}

// Read the total match count Phenom embeds next to the jobs array, so we know when
// to stop paging. Returns null when absent (caller falls back to short-page detection).
function parseTotalHits(html) {
  const m = html.match(/"totalHits"\s*:\s*(\d+)/);
  return m ? Number(m[1]) : null;
}

// Map one raw Phenom record to the scanner's job shape. Returns null for records
// missing a title or a sequence number (can't build a stable URL without the seq).
function mapJob(rec, base, companyName) {
  if (!rec || !rec.title || !rec.jobSeqNo) return null;
  const title = String(rec.title).trim();
  if (!title) return null;
  const url = `${base}/job/${encodeURIComponent(String(rec.jobSeqNo))}/${slugifyTitle(title)}`;
  const location = typeof rec.location === 'string' && rec.location
    ? rec.location
    : [rec.city, rec.state, rec.country].filter(Boolean).join(', ');
  const postedDate = toIsoDate(rec.postedDate || rec.dateCreated);
  const workMode = normalizeWorkMode(rec.checkRemote);
  const department = typeof rec.category === 'string' ? rec.category : '';
  return {
    title,
    url,
    company: companyName,
    location,
    ...(postedDate ? { postedDate } : {}),
    ...(workMode ? { workMode } : {}),
    ...(department ? { department } : {}),
  };
}

/** @type {Provider} */
export default {
  id: 'phenom',

  async fetch(entry, ctx) {
    const base = resolveBase(entry);
    if (!base) throw new Error(`phenom: cannot derive base URL for ${entry.name}`);
    const searchUrl = `${base}/search-results`;

    const seen = new Set();
    const jobs = [];
    let total = null;
    let fetches = 0;

    for (let round = 1; round <= MAX_ROUNDS; round++) {
      let addedThisRound = 0;
      // Page until a short page ends the list. Once total is known, bound the page
      // count so a feed that always returns full pages can't loop forever.
      const maxPages = total != null ? Math.ceil(total / PAGE_SIZE) + 1 : Math.ceil(MAX_FETCHES / MAX_ROUNDS);
      for (let page = 0; page < maxPages; page++) {
        if (fetches >= MAX_FETCHES) break;
        fetches++;
        const html = await ctx.fetchText(`${searchUrl}?from=${page * PAGE_SIZE}&s=1`, { redirect: 'follow' });
        if (total == null) total = parseTotalHits(html);

        const raw = parsePhenomJobs(html);
        if (raw.length === 0) break;

        for (const rec of raw) {
          const seq = rec && rec.jobSeqNo;
          if (seq && seen.has(seq)) continue;      // already unioned in a prior page/round
          const job = mapJob(rec, base, entry.name);
          if (!job) continue;                      // missing title/seq — can't build a stable URL
          if (seq) seen.add(seq);
          jobs.push(job);
          addedThisRound++;
        }

        if (raw.length < PAGE_SIZE) break;          // tail of this round's ordering
        if (total != null && jobs.length >= total) break;
      }

      // Done when we've gathered the advertised total, hit the fetch ceiling, or a
      // full extra pass surfaced nothing new (the reshuffle has been exhausted).
      if (total != null && jobs.length >= total) break;
      if (fetches >= MAX_FETCHES) break;
      if (round >= 2 && addedThisRound === 0) break;
    }

    return jobs;
  },
};
