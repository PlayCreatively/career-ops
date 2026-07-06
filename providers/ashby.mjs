// @ts-check
/** @typedef {import('./_types.js').Provider} Provider */

import { toIsoDate, normalizeWorkMode, slugifyTitle, stripHtml, attachDetail } from './_util.mjs';

// Ashby provider — hits the public posting-api endpoint.
// Auto-detects from careers_url pattern `https://jobs.ashbyhq.com/<slug>`.
//
// Some tenants (e.g. Supercell) run Ashby for applications but DISABLE the
// hosted jobs.ashbyhq.com board, surfacing each role on their own domain
// instead. The posting-api still works, but j.jobUrl points at the dead board
// (a 200 SPA shell that renders "Page not found"). For those, set
// `job_url_template` on the studios.yml entry with {id} and {slug} tokens and we
// rewrite each posting's URL to the live one. {slug} uses the host's observed
// title-slug convention (see slugifyTitle in _util.mjs).
//
//   - name: Supercell
//     careers_url: https://jobs.ashbyhq.com/supercell
//     job_url_template: "https://supercell.com/en/careers/{slug}/{id}/"
//
// Ashby's public posting-api carries a ~10s+ server-side latency floor
// (response time is independent of board size) and rate-limits repeated
// unauthenticated hits. The global default timeout (10s, providers/_http.mjs)
// sits right on that floor, so requests race the timeout and abort. We give
// Ashby a longer timeout plus a backoff+jitter retry (the backoff spaces
// requests out to dodge rate-limiting).
// See .planning/codebase/ashby-scan-abort-diagnosis.md.
const ASHBY_TIMEOUT_MS = 30_000;
const ASHBY_RETRIES = 2;

function resolveApiUrl(entry) {
  const url = entry.careers_url || '';
  const match = url.match(/jobs\.ashbyhq\.com\/([^/?#]+)/);
  if (!match) return null;
  return `https://api.ashbyhq.com/posting-api/job-board/${match[1]}?includeCompensation=true`;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** @type {import('./_types.js').Probe} */
export const probe = {
  namesakeProne: true,
  canary: 'ramp',      // known-live tenant — proves ashby isn't throttling/blocking us
  endpoints: [{
    kind: 'slug',
    url: (s) => `https://api.ashbyhq.com/posting-api/job-board/${s}`,
    where: (s) => s,
    careersUrl: (s) => `https://jobs.ashbyhq.com/${s}`,
    parse: (d) => (d && Array.isArray(d.jobs)) ? { count: d.jobs.length, loc: d.jobs[0]?.location || '' } : null,
  }],
};

/** @type {Provider} */
export default {
  id: 'ashby',

  detect(entry) {
    const apiUrl = resolveApiUrl(entry);
    return apiUrl ? { url: apiUrl } : null;
  },

  // url→identity (inverse of probe): mine a jobs.ashbyhq.com/{slug} link to { slug, careers_url }.
  mineUrl(jobUrl) {
    let u; try { u = new URL(jobUrl); } catch { return null; }
    if (!/(^|\.)ashbyhq\.com$/.test(u.hostname.toLowerCase())) return null;
    const slug = u.pathname.split('/').filter(Boolean)[0];
    return slug ? { slug, careers_url: `https://jobs.ashbyhq.com/${slug}` } : null;
  },

  async fetch(entry, ctx) {
    const apiUrl = resolveApiUrl(entry);
    if (!apiUrl) throw new Error(`ashby: cannot derive API URL for ${entry.name}`);

    let lastErr;
    for (let attempt = 0; attempt <= ASHBY_RETRIES; attempt++) {
      if (attempt > 0) {
        // exponential backoff + jitter — spaces out retries to dodge Ashby rate-limiting
        const backoff = 1000 * 2 ** (attempt - 1) + Math.floor(Math.random() * 500);
        await sleep(backoff);
      }
      try {
        const json = await ctx.fetchJson(apiUrl, { timeoutMs: ASHBY_TIMEOUT_MS });
        const jobs = Array.isArray(json?.jobs) ? json.jobs : [];
        const tpl = typeof entry.job_url_template === 'string' ? entry.job_url_template.trim() : '';
        return jobs.map((j) => {
          const postedDate = toIsoDate(j.publishedAt);
          const department = (j.department || j.team || '').trim();
          // Use `workplaceType` (OnSite/Hybrid/Remote) for the tri-state — NOT
          // `isRemote`, which Ashby sets true for BOTH Hybrid and Remote roles.
          // Fall back to isRemote only when workplaceType is absent (no hybrid
          // signal available then).
          const workMode = normalizeWorkMode(j.workplaceType)
            || (typeof j.isRemote === 'boolean' ? (j.isRemote ? 'remote' : 'onsite') : '');
          // job_url_template rewrites the dead-board jobUrl to the studio's own
          // canonical page; needs both an id and a title, else fall back to jobUrl.
          const url = (tpl && j.id && j.title)
            ? tpl.replace(/\{id\}/g, j.id).replace(/\{slug\}/g, slugifyTitle(j.title))
            : (j.jobUrl || '');
          const job = {
            title: j.title || '',
            url,
            company: entry.name,
            location: j.location || '',
            ...(postedDate ? { postedDate } : {}),
            ...(department ? { department } : {}),
            ...(workMode ? { workMode } : {}),
          };
          // FREE inline detail: the job-board API already returns the full
          // description (descriptionPlain is plain text; descriptionHtml is HTML)
          // → hand it to the sponsorship enricher with no per-job fetch.
          const text = typeof j.descriptionPlain === 'string' && j.descriptionPlain
            ? j.descriptionPlain : stripHtml(j.descriptionHtml);
          return attachDetail(job, { text });
        });
      } catch (e) {
        lastErr = e;
      }
    }
    throw lastErr;
  },
};
