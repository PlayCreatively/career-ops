// @ts-check
/** @typedef {import('./_types.js').Provider} Provider */

import { toIsoDate, stripHtml, decodeEntities, attachDetail } from './_util.mjs';

// Greenhouse provider — hits the public boards-api JSON endpoint.
// Handles both explicit `api:` URLs and auto-detection from `careers_url`.
//
// FREE-tier detail: the list endpoint returns the full posting body when asked
// with `?content=true` (one extra query param, NO per-job fetch). The `content`
// is entity-escaped HTML, so we decode+strip it to plain text and hang it on the
// job for the cross-cutting enrichers (sponsorship). See providers/_util.mjs DETAIL.

const ALLOWED_GREENHOUSE_HOSTS = new Set([
  'boards-api.greenhouse.io',
  'boards.greenhouse.io',
  'job-boards.greenhouse.io',
  'job-boards.eu.greenhouse.io',
]);

function assertGreenhouseUrl(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`greenhouse: invalid URL: ${url}`);
  }
  if (parsed.protocol !== 'https:') throw new Error(`greenhouse: URL must use HTTPS: ${url}`);
  if (!ALLOWED_GREENHOUSE_HOSTS.has(parsed.hostname))
    throw new Error(`greenhouse: untrusted hostname "${parsed.hostname}" — must be one of: ${[...ALLOWED_GREENHOUSE_HOSTS].join(', ')}`);
  return url;
}

function resolveApiUrl(entry) {
  if (entry.api) {
    assertGreenhouseUrl(entry.api);
    return entry.api;
  }
  const url = entry.careers_url || '';
  const match = url.match(/job-boards(?:\.eu)?\.greenhouse\.io\/([^/?#]+)/);
  if (match) return `https://boards-api.greenhouse.io/v1/boards/${match[1]}/jobs`;
  return null;
}

/** @type {import('./_types.js').Probe} */
export const probe = {
  namesakeProne: true, // single-word board slugs collide with non-game namesakes
  canary: 'stripe',    // known-live tenant — proves greenhouse isn't throttling/blocking us
  endpoints: [{
    kind: 'slug',
    url: (s) => `https://boards-api.greenhouse.io/v1/boards/${s}/jobs`,
    where: (s) => s,
    careersUrl: (s) => `https://job-boards.greenhouse.io/${s}`,
    parse: (d) => (d && Array.isArray(d.jobs)) ? { count: d.jobs.length, loc: d.jobs[0]?.location?.name || '' } : null,
  }],
};

/** @type {Provider} */
export default {
  id: 'greenhouse',

  detect(entry) {
    try {
      const apiUrl = resolveApiUrl(entry);
      return apiUrl ? { url: apiUrl } : null;
    } catch {
      return null;
    }
  },

  // url→identity (inverse of probe): mine a raw greenhouse board/job link down to
  // { slug, careers_url } for mine-asgc.mjs, or null if not greenhouse. Board hosts
  // carry the slug in the path; a {slug}.greenhouse.io vanity host carries it as the
  // subdomain. careers_url is normalised to the job-boards form fetch() accepts.
  mineUrl(jobUrl) {
    let u; try { u = new URL(jobUrl); } catch { return null; }
    const h = u.hostname.replace(/^www\./, '').toLowerCase();
    if (!/(^|\.)greenhouse\.io$/.test(h)) return null;
    const slug = /^(boards|job-boards|boards-api)(\.eu)?\.greenhouse\.io$/.test(h)
      ? u.pathname.split('/').filter(Boolean)[0]
      : h.replace(/(\.eu)?\.greenhouse\.io$/, '');
    return slug ? { slug, careers_url: `https://job-boards.greenhouse.io/${slug}` } : null;
  },

  async fetch(entry, ctx) {
    const apiUrl = resolveApiUrl(entry);
    if (!apiUrl) throw new Error(`greenhouse: cannot derive API URL for ${entry.name}`);
    assertGreenhouseUrl(apiUrl);
    // ?content=true makes the SAME list call return each posting's body, so the
    // sponsorship enricher gets its text with no per-job fetch. Set it via the URL
    // object so an explicit `api:` that already has query params keeps them.
    const withContent = new URL(apiUrl);
    withContent.searchParams.set('content', 'true');
    // redirect:'error' prevents SSRF via server-side redirects; combined with
    // assertGreenhouseUrl above it guarantees the final hostname stays in the allowlist.
    const json = await ctx.fetchJson(withContent.href, { redirect: 'error' });
    const jobs = Array.isArray(json?.jobs) ? json.jobs : [];
    return jobs.filter(j => j.absolute_url).map(j => {
      // `first_published` is the true posting date; `updated_at` is the last
      // edit (re-published roles bump it). The basic /jobs feed exposes neither
      // a structured remote flag nor a department, so only postedDate is set.
      const postedDate = toIsoDate(j.first_published || j.updated_at);
      const job = {
        title: j.title || '',
        url: j.absolute_url,
        company: entry.name,
        location: j.location?.name || '',
        ...(postedDate ? { postedDate } : {}),
      };
      // FREE inline detail: `content` is entity-escaped HTML → decode then strip.
      return attachDetail(job, { text: stripHtml(decodeEntities(j.content || '')) });
    });
  },
};
