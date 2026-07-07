// @ts-check
/** @typedef {import('./_types.js').Provider} Provider */

import { stripHtml } from './_util.mjs';

// Workday provider — hits the public "cxs" job-search JSON API that every
// Workday career site exposes at:
//
//   POST https://{host}/wday/cxs/{tenant}/{site}/jobs
//   body: {"appliedFacets":{},"limit":20,"offset":0,"searchText":""}
//
// This is the same unauthenticated endpoint the Workday careers UI calls; no
// login, no scraping. Workday powers most large publishers (EA, King, Toca
// Boca/Spin Master, ...). Unlike the per-studio ATS providers it is paginated
// (total + offset), so we loop until we've pulled `total` postings (capped).
//
// Routing: most tenants live on `{tenant}.{dc}.myworkdayjobs.com`, which
// detect() claims and parses automatically:
//
//   - name: King
//     careers_url: https://activision.wd1.myworkdayjobs.com/King_External_Careers
//
// White-labelled custom domains (e.g. jobs.ea.com) can't be parsed from the
// host, so pin them with explicit `tenant:` + `site:` (and careers_url as the
// site origin):
//
//   - name: EA
//     provider: workday
//     careers_url: https://jobs.ea.com
//     tenant: ea
//     site: ea_external
//
// Scoping a shared/whole-company site: some tenants expose one site that mixes
// many business units (e.g. warnerbros/global = all of Warner Bros Discovery,
// HBO/CNN + the games studios), with no business-unit facet to filter on. Two
// optional, fail-safe knobs scope such an entry (omit both = scan everything):
//
//   query: "<keyword>"   server-side — maps to Workday's `searchText` (the
//                        careers UI search box). Fuzzy/OR-matched, so it can
//                        both leak (matches any field) and undercount (misses
//                        postings that don't mention the term). Coarse; prefer
//                        `locations` when a business unit maps to fixed offices.
//
//   locations: [..]      client-side allow-list — keep only postings whose
//                        location contains one of these substrings (case-
//                        insensitive). Exact and complete when each office
//                        belongs to one business unit. This is how WB Games is
//                        carved out of the WBD tenant: its studios sit at
//                        dedicated addresses, so the offices ARE the filter:
//
//   - name: Warner Bros. Games
//     provider: workday
//     careers_url: https://warnerbros.wd5.myworkdayjobs.com/global
//     locations:
//       - "Rocksteady Studios"                 # London (Rocksteady)
//       - "Chicago 2650A W Bradley"            # NetherRealm
//       - "Salt Lake City 175 East 400 South"  # Avalanche Software
//       - "Remote Utah"                        # Avalanche (remote)
//       - "Knutsford Canute Court"             # TT Games

const PER_PAGE = 20;
const MAX_PAGES = 25; // hard cap: 25 * 20 = 500 postings per tenant, plenty.

// Non-enumerable stash for the per-job cxs DETAIL endpoint, set during parse and
// read by fetchDetail. It can't be re-derived from the public job.url alone: the
// url is `{host}/{site}{externalPath}` and carries no tenant, which custom
// domains (jobs.ea.com, tenant "ea") don't expose in the host. Module-local and
// non-enumerable, so it never reaches the JSON snapshot, a `{...job}` spread, or
// the parser unit tests' deepStrictEqual. See attachDetail in _util for the same
// pattern applied to inline detail text.
const DETAIL_ENDPOINT = Symbol('workday.detailEndpoint');

// A Workday path may carry a locale prefix (en-US, en_US, fr-FR). The site id is
// the first path segment that isn't a locale.
const LOCALE_RE = /^[a-z]{2}([-_][A-Za-z]{2})?$/;

// Resolve {host, tenant, site} from a portal entry. Explicit tenant/site win
// (needed for custom domains); otherwise derive from a *.myworkdayjobs.com URL.
export function resolveWorkday(entry) {
  let url;
  try {
    url = new URL(entry.careers_url || '');
  } catch {
    return null;
  }
  if (url.protocol !== 'https:') return null;
  const host = url.hostname.toLowerCase();

  const explicitTenant = typeof entry.tenant === 'string' ? entry.tenant.trim() : '';
  const explicitSite = typeof entry.site === 'string' ? entry.site.trim() : '';
  if (explicitTenant && explicitSite) {
    return { host, tenant: explicitTenant, site: explicitSite };
  }

  // Auto-derive only for genuine Workday hosts.
  if (!host.endsWith('.myworkdayjobs.com')) return null;
  const tenant = host.split('.')[0];
  const segments = url.pathname.split('/').filter(Boolean);
  const site = segments.find(s => !LOCALE_RE.test(s));
  if (!tenant || !site) return null;
  return { host, tenant, site };
}

export function parseWorkdayPage(json, { host, tenant, site, company }) {
  const postings = Array.isArray(json?.jobPostings) ? json.jobPostings : [];
  return postings
    .filter(p => p && p.title && p.externalPath)
    .map(p => {
      const job = {
        title: String(p.title),
        // externalPath is site-relative and starts with "/job/..."; the public
        // job URL is {origin}/{site}{externalPath}.
        url: `https://${host}/${site}${p.externalPath}`,
        company: company || '',
        location: typeof p.locationsText === 'string' ? p.locationsText : '',
      };
      // Stash the cxs DETAIL endpoint for fetchDetail (PAID tier). Same host as
      // the list, tenant/site from the entry, externalPath from the posting.
      if (tenant) {
        Object.defineProperty(job, DETAIL_ENDPOINT, {
          value: `https://${host}/wday/cxs/${tenant}/${site}${p.externalPath}`,
          enumerable: false, configurable: true, writable: true,
        });
      }
      return job;
    });
}

/** @type {Provider} */
export default {
  id: 'workday',

  detect(entry) {
    let host;
    try {
      host = new URL(entry.careers_url || '').hostname.toLowerCase();
    } catch {
      return null;
    }
    if (!host.endsWith('.myworkdayjobs.com')) return null;
    const resolved = resolveWorkday(entry);
    return resolved ? { url: `https://${resolved.host}/wday/cxs/${resolved.tenant}/${resolved.site}/jobs` } : null;
  },

  // url→identity (inverse of probe): mine a {tenant}.{dc}.myworkdayjobs.com/{locale?}/{site}
  // link to { slug, careers_url }; careers_url ({host}/{site}) is self-sufficient — fetch()
  // re-derives tenant/site from it. slug = tenant; label shows tenant/site.
  mineUrl(jobUrl) {
    let u; try { u = new URL(jobUrl); } catch { return null; }
    const host = u.hostname.toLowerCase();
    if (!host.endsWith('.myworkdayjobs.com')) return null;
    const tenant = host.split('.')[0];
    const site = u.pathname.split('/').filter(Boolean).find(s => !LOCALE_RE.test(s));
    return (tenant && site) ? { slug: tenant, careers_url: `https://${host}/${site}`, label: `${tenant}/${site}` } : null;
  },

  async fetch(entry, ctx) {
    const resolved = resolveWorkday(entry);
    if (!resolved) throw new Error(`workday: cannot resolve tenant/site for ${entry.name} — use a *.myworkdayjobs.com careers_url or set tenant:/site:`);
    const { host, tenant, site } = resolved;
    const endpoint = `https://${host}/wday/cxs/${tenant}/${site}/jobs`;
    // Optional keyword scope for shared sites (maps to Workday's searchText).
    const searchText = typeof entry.query === 'string' ? entry.query.trim() : '';

    const jobs = [];
    // Some tenants (e.g. warnerbros/global) report `total` only on the first
    // page and return 0 afterwards, so capture it once and otherwise let a
    // short page signal the end — never trust a per-page `total` to paginate.
    let knownTotal = 0;
    for (let page = 0; page < MAX_PAGES; page++) {
      const offset = page * PER_PAGE;
      const json = await ctx.fetchJson(endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({ appliedFacets: {}, limit: PER_PAGE, offset, searchText }),
        redirect: 'error',
      });
      if (page === 0 && Number.isFinite(json?.total) && json.total > 0) knownTotal = json.total;
      const batch = parseWorkdayPage(json, { host, tenant, site, company: entry.name });
      jobs.push(...batch);
      // Stop on a short/empty page, or once we've pulled the first-page total.
      if (batch.length < PER_PAGE) break;
      if (knownTotal && jobs.length >= knownTotal) break;
    }

    // Optional office allow-list: keep only postings at one of the named
    // locations (case-insensitive substring). Fail-safe — an empty/missing or
    // all-blank list filters nothing.
    const allow = Array.isArray(entry.locations)
      ? entry.locations.filter(l => typeof l === 'string' && l.trim()).map(l => l.trim().toLowerCase())
      : [];
    if (allow.length) {
      return jobs.filter(j => {
        const loc = (j.location || '').toLowerCase();
        return allow.some(a => loc.includes(a));
      });
    }
    return jobs;
  },

  // PAID detail (runs by default; skipped by --no-extra-fetch). The list carries
  // no description; each posting's cxs detail endpoint returns it as
  // jobPostingInfo.jobDescription (HTML). One GET per job, gated by the enrich
  // cap/concurrency. Keep concurrency modest — big publishers (SEGA, Spin Master,
  // WBD) sit behind CDNs that throttle bursts, and a per-job miss only costs that
  // job's detail, never the posting. Endpoint comes from the parse-time stash;
  // for a standard *.myworkdayjobs.com host we can also re-derive it from job.url
  // (tenant = first host label) as a fail-safe when the stash is absent.
  detailConcurrency: 3,
  async fetchDetail(job, ctx) {
    let endpoint = job && job[DETAIL_ENDPOINT];
    if (!endpoint) endpoint = detailEndpointFromUrl(job && job.url);
    if (!endpoint) return null;
    const json = await ctx.fetchJson(endpoint, {
      headers: { accept: 'application/json' },
      redirect: 'follow',
    });
    const desc = json?.jobPostingInfo?.jobDescription;
    const text = stripHtml(desc);
    return text ? { text } : null;
  },
};

// Fail-safe endpoint recovery for standard hosts: a public Workday job URL is
// `https://{tenant}.{dc}.myworkdayjobs.com/{site}{externalPath}`, and on these
// hosts the tenant IS the first host label — so the cxs detail endpoint is
// recoverable without the stash. Custom domains (jobs.ea.com) hide the tenant in
// the host and so rely on the stash; here we return '' and fetchDetail no-ops.
function detailEndpointFromUrl(url) {
  let u;
  try { u = new URL(url || ''); } catch { return ''; }
  const host = u.hostname.toLowerCase();
  if (u.protocol !== 'https:' || !host.endsWith('.myworkdayjobs.com')) return '';
  const tenant = host.split('.')[0];
  const segments = u.pathname.split('/').filter(Boolean);
  const site = segments.shift();
  const externalPath = segments.length ? `/${segments.join('/')}` : '';
  if (!tenant || !site || !externalPath) return '';
  return `https://${host}/wday/cxs/${tenant}/${site}${externalPath}`;
}
