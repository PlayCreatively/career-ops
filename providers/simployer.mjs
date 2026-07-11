// @ts-check
/** @typedef {import('./_types.js').Provider} Provider */

import { toIsoDate, stripHtml, attachDetail } from './_util.mjs';

// Simployer Recruitment provider — multi-tenant ATS on
// `{tenant}.recruitment.simployer.com` (used by Nordic studios, e.g. Tarsier
// Studios / Little Nightmares). The public careers page is a server-rendered
// Next.js app: the FULL job list — titles, slugs, locations, remote/hybrid
// flags, salary, and each posting's HTML body — is embedded in the page's
// `__NEXT_DATA__` blob at `props.pageProps.job_data.jobs`. So one HTML GET per
// tenant yields everything, zero per-job fetches (the description rides along
// as free inline detail for the enrichers). No JSON API, no scraping of markup.
//
// Auto-detects from a careers_url on `*.recruitment.simployer.com`. The listing
// URL is `{origin}/careers`; detail URLs are `{origin}/{client_slug}/{slug}/view-job`.
//
//   tracked_companies:
//     - name: Tarsier Studios
//       provider: simployer
//       careers_url: https://tarsier.recruitment.simployer.com/careers

const SIMPLOYER_HOST_RE = /^[a-z0-9][a-z0-9-]*\.recruitment\.simployer\.com$/i;

// Cap pagination so a tenant that ignores the ?page param (echoing page 1
// forever) can't loop — we also stop the moment a page yields no NEW slugs.
const MAX_PAGES = 25;

// Derive the origin from any URL on a Simployer career site, validating it's a
// real *.recruitment.simployer.com host over https. An explicit `feed_url` entry
// wins so an unusual deployment can be pinned by hand.
function resolveOrigin(entry) {
  const raw = (typeof entry.feed_url === 'string' && entry.feed_url.trim())
    ? entry.feed_url.trim()
    : (typeof entry.careers_url === 'string' ? entry.careers_url : '');
  if (!raw) return null;
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'https:') return null;
  if (!SIMPLOYER_HOST_RE.test(parsed.hostname)) return null;
  return parsed.origin;
}

const listUrl = (origin, page) => `${origin}/careers${page > 1 ? `?page=${page}` : ''}`;

// Pull the __NEXT_DATA__ JSON out of a Simployer careers page. Returns the
// parsed object, or null if the page carries no such blob (not a Next.js page /
// unexpected shape).
function extractNextData(html) {
  const m = String(html).match(/<script id="__NEXT_DATA__" type="application\/json">([\s\S]*?)<\/script>/);
  if (!m) return null;
  try {
    return JSON.parse(m[1]);
  } catch {
    return null;
  }
}

/**
 * Parse ONE page of a Simployer careers page (its __NEXT_DATA__ HTML). Exported
 * for unit tests.
 *
 * Each job in `job_data.jobs` carries:
 *   { job_title, slug, is_remote, is_hybrid, city_country, location_attributes,
 *     published_date (a relative "Posted N day(s) ago" string), description (HTML) }
 *
 * - url: `{origin}/{client_slug}/{slug}/view-job` (client_slug is tenant-level).
 * - company: the tenant's `career_page.client_name`, falling back to the entry name.
 * - location: `city_country` (already "City, Country"); remoteness is carried by
 *   the structured `workMode` field (is_remote / is_hybrid), not appended to text.
 * - postedDate: `published_date` is relative prose, not a date — use the location
 *   record's `created_at` (a real ISO timestamp that tracks when the job went up).
 *
 * @param {string} html
 * @param {string} origin
 * @param {string} fallbackCompany
 * @returns {Array<{title: string, url: string, company: string, location: string}>}
 */
export function parseSimployerHtml(html, origin, fallbackCompany) {
  const data = extractNextData(html);
  const jd = data?.props?.pageProps?.job_data;
  const jobs = Array.isArray(jd?.jobs) ? jd.jobs : [];
  if (!jobs.length) return [];

  const clientSlug = (typeof jd.client_slug === 'string' && jd.client_slug.trim())
    ? jd.client_slug.trim()
    // Fall back to the host's leading label (the tenant subdomain).
    : new URL(origin).hostname.split('.')[0];
  const company = (typeof jd.career_page?.client_name === 'string' && jd.career_page.client_name.trim())
    ? jd.career_page.client_name.trim()
    : (fallbackCompany || '');

  return jobs
    .filter(j => j && j.job_title && j.slug)
    .map(j => {
      const slug = String(j.slug);
      const loc = j.location_attributes || {};
      const location = (typeof j.city_country === 'string' && j.city_country.trim())
        ? j.city_country.trim()
        : (typeof loc.full_address === 'string' ? loc.full_address.trim() : '');
      // Two independent booleans → the tri-state token (remote wins, then
      // hybrid, else onsite when we have a place).
      const workMode = j.is_remote ? 'remote' : j.is_hybrid ? 'hybrid' : (location ? 'onsite' : '');
      const postedDate = toIsoDate(loc.created_at || j.job_salary_detail_attributes?.created_at);
      const job = {
        title: String(j.job_title),
        url: `${origin}/${clientSlug}/${encodeURIComponent(slug)}/view-job`,
        company,
        location,
        ...(postedDate ? { postedDate } : {}),
        ...(workMode ? { workMode } : {}),
      };
      // FREE inline detail: the list already carries the posting's HTML body →
      // strip to text for the sponsorship enricher, no per-job fetch.
      return attachDetail(job, { text: stripHtml(j.description) });
    });
}

// No `probe` export: the probe framework (probe-studios.mjs) always JSON-parses
// an endpoint response before calling parse(), but Simployer serves HTML — so a
// probe endpoint would always miss. Like the other HTML providers (hrmos,
// gamesjobsdirect), discovery is manual; the provider is reached via detect()/fetch().

/** @type {Provider} */
export default {
  id: 'simployer',

  // Claim *.recruitment.simployer.com careers URLs automatically.
  detect(entry) {
    const origin = resolveOrigin(entry);
    return origin ? { url: listUrl(origin, 1) } : null;
  },

  // url→identity (inverse of probe): mine a {tenant}.recruitment.simployer.com
  // link to { slug, careers_url }.
  mineUrl(jobUrl) {
    let u; try { u = new URL(jobUrl); } catch { return null; }
    const h = u.hostname.toLowerCase();
    if (!SIMPLOYER_HOST_RE.test(h)) return null;
    const sub = h.split('.')[0];
    return (sub && sub !== 'www') ? { slug: sub, careers_url: `https://${h}/careers` } : null;
  },

  async fetch(entry, ctx) {
    const origin = resolveOrigin(entry);
    if (!origin) throw new Error(`simployer: cannot derive careers URL for ${entry.name} — set careers_url on *.recruitment.simployer.com (https)`);

    // NOTE: the pagination loop below is written defensively (dedup-by-url +
    // no-new-slugs stop + MAX_PAGES cap) but is UNVERIFIED against a multi-page
    // tenant — the only wired studio (Tarsier) has 2 roles and next_page=null.
    // Re-check the loop against a Simployer studio with 30+ openings if one turns up.
    const out = [];
    const seen = new Set();
    for (let page = 1; page <= MAX_PAGES; page++) {
      // redirect:'error' blocks redirect-based SSRF; host is validated above.
      const html = await ctx.fetchText(listUrl(origin, page), { redirect: 'error' });
      const jobs = parseSimployerHtml(html, origin, entry.name);
      let added = 0;
      for (const job of jobs) {
        if (seen.has(job.url)) continue;
        seen.add(job.url);
        out.push(job);
        added++;
      }
      // Stop when a page carried nothing new (last page, or a tenant that
      // ignores ?page and echoes page 1) or the feed signals no further pages.
      const nextPage = extractNextData(html)?.props?.pageProps?.job_data?.next_page;
      if (added === 0 || !nextPage) break;
    }
    return out;
  },
};
