// @ts-check
/** @typedef {import('./_types.js').Provider} Provider */

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

const PER_PAGE = 20;
const MAX_PAGES = 25; // hard cap: 25 * 20 = 500 postings per tenant, plenty.

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

export function parseWorkdayPage(json, { host, site, company }) {
  const postings = Array.isArray(json?.jobPostings) ? json.jobPostings : [];
  return postings
    .filter(p => p && p.title && p.externalPath)
    .map(p => ({
      title: String(p.title),
      // externalPath is site-relative and starts with "/job/..."; the public
      // job URL is {origin}/{site}{externalPath}.
      url: `https://${host}/${site}${p.externalPath}`,
      company: company || '',
      location: typeof p.locationsText === 'string' ? p.locationsText : '',
    }));
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

  async fetch(entry, ctx) {
    const resolved = resolveWorkday(entry);
    if (!resolved) throw new Error(`workday: cannot resolve tenant/site for ${entry.name} — use a *.myworkdayjobs.com careers_url or set tenant:/site:`);
    const { host, tenant, site } = resolved;
    const endpoint = `https://${host}/wday/cxs/${tenant}/${site}/jobs`;

    const jobs = [];
    for (let page = 0; page < MAX_PAGES; page++) {
      const offset = page * PER_PAGE;
      const json = await ctx.fetchJson(endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({ appliedFacets: {}, limit: PER_PAGE, offset, searchText: '' }),
        redirect: 'error',
      });
      const batch = parseWorkdayPage(json, { host, site, company: entry.name });
      jobs.push(...batch);
      const total = Number.isFinite(json?.total) ? json.total : 0;
      // Stop once we've covered `total`, or a short page signals the end.
      if (offset + PER_PAGE >= total || batch.length < PER_PAGE) break;
    }
    return jobs;
  },
};
