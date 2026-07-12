// @ts-check
/** @typedef {import('./_types.js').Provider} Provider */

import { toIsoDate } from './_util.mjs';

// Remote Game Jobs provider — an AGGREGATOR board (like Hitmarker / Work With
// Indies), not a single company. One tracked_companies entry yields jobs across
// many studios. Remote Game Jobs publishes a public RSS feed of every open
// posting at https://remotegamejobs.com/feed.rss — no auth, no scraping.
//
// Remote-only and games-focused, so it complements the big-studio ATS feeds.
// Configure it explicitly:
//
//   - name: Remote Game Jobs
//     provider: remote-game-jobs
//
// Each <item> title follows "{Company} is hiring {Role} (Remote Job)", which we
// split into company/role. Every posting on the board is remote, so workMode is
// always 'remote'. If a title ever breaks that shape we fall back to the raw
// title with empty company — fail-safe: a job is never dropped just because it
// didn't parse.
//
// DIRECT APPLY LINK. RGJ's own `url` is its posting page, but the page's "Apply
// To Job" button is an internal /goto/{slug} redirector whose slug is exactly the
// posting's own /jobs/{slug} slug — so we can build the goto URL without fetching
// the page. A single 302 hop hands back the real destination: a first-party ATS
// URL for studio postings (which we surface as `applyUrl` so snapshot dedup can
// collapse this mirror onto a posting we scanned directly), or — the common indie
// case — a `mailto:`, which yields no applyUrl and dedups the old way. One request
// per job; opt out with `resolve_apply: false`. See gotoUrlFor / applyUrlFromLocation.

const FEED_URL = 'https://remotegamejobs.com/feed.rss';

// Per-job /goto/ redirect resolution concurrency (see fetch()).
const RESOLVE_CONCURRENCY = 8;

// "{Company} is hiring [a/an] {Role} (Remote Job)"
const TITLE_RE = /^(.*?) is hiring (?:an? )?(.*?)\s*\(Remote Job\)\.?$/i;

function decodeEntities(s) {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&quot;/g, '"');
}

function pickTag(block, tag) {
  const m = block.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`));
  if (!m) return '';
  return m[1].replace(/<!\[CDATA\[|\]\]>/g, '').trim();
}

export function parseRemoteGameJobsFeed(xml) {
  if (typeof xml !== 'string') return [];
  const blocks = [...xml.matchAll(/<item>([\s\S]*?)<\/item>/g)].map(m => m[1]);
  const jobs = [];
  for (const block of blocks) {
    const url = decodeEntities(pickTag(block, 'link'));
    const rawTitle = decodeEntities(pickTag(block, 'title'));
    if (!url || !rawTitle) continue;
    const postedDate = toIsoDate(pickTag(block, 'pubDate'));
    const m = rawTitle.match(TITLE_RE);
    if (m) {
      const [, company, role] = m;
      jobs.push({
        title: role.trim(),
        url,
        company: company.trim(),
        location: '',
        workMode: 'remote',
        ...(postedDate ? { postedDate } : {}),
      });
    } else {
      // Fail-safe: keep the posting with the raw title so it can still match the
      // title filter and reach the pipeline.
      jobs.push({
        title: rawTitle,
        url,
        company: '',
        location: '',
        workMode: 'remote',
        ...(postedDate ? { postedDate } : {}),
      });
    }
  }
  return jobs;
}

// Build the /goto/{slug} redirector URL for a posting. RGJ's apply button points
// at {origin}/goto/{slug}, and the slug equals the posting's own /jobs/{slug}
// slug, so no page fetch is needed. Returns '' for anything that isn't an RGJ
// /jobs/ URL (fail-safe: no goto → no applyUrl).
export function gotoUrlFor(jobUrl) {
  let u;
  try { u = new URL(jobUrl); } catch { return ''; }
  const m = u.pathname.match(/^\/jobs\/(.+)$/);
  if (!m) return '';
  return `${u.origin}/goto/${m[1]}`;
}

// Turn a /goto/ redirect's Location header into a surfaceable apply URL. http(s)
// targets are returned with utm_* tracking params stripped; a `mailto:`/`tel:`
// (or any non-http scheme), a self-referential remotegamejobs.com link, or an
// unparseable value all yield '' so the row keeps deduping on its RGJ url.
export function applyUrlFromLocation(loc) {
  if (typeof loc !== 'string' || !loc) return '';
  let u;
  try { u = new URL(loc); } catch { return ''; }
  if (!/^https?:$/.test(u.protocol)) return '';
  if (u.hostname.replace(/^www\./, '').toLowerCase() === 'remotegamejobs.com') return '';
  for (const k of [...u.searchParams.keys()]) {
    if (/^utm_/i.test(k)) u.searchParams.delete(k);
  }
  return u.toString();
}

// Run async `worker` over `items` with a fixed concurrency cap.
async function mapConcurrent(items, limit, worker) {
  let i = 0;
  async function next() {
    while (i < items.length) {
      const idx = i++;
      await worker(items[idx], idx);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, next));
}

/** @type {Provider} */
export default {
  id: 'remote-game-jobs',

  // Multi-studio board — hosts must be in scan.mjs DEFAULT_AGGREGATORS (see hitmarker).
  aggregatorHosts: ['remotegamejobs.com'],

  detect(entry) {
    let host;
    try {
      host = new URL(entry.careers_url || '').hostname.toLowerCase();
    } catch {
      return null;
    }
    return host === 'remotegamejobs.com' || host === 'www.remotegamejobs.com'
      ? { url: FEED_URL }
      : null;
  },

  async fetch(entry, ctx) {
    const feedUrl = typeof entry.feed_url === 'string' && entry.feed_url.trim()
      ? entry.feed_url.trim()
      : FEED_URL;
    const xml = await ctx.fetchText(feedUrl, { redirect: 'error' });
    const jobs = parseRemoteGameJobsFeed(xml);

    // Resolve each posting's direct apply destination via its /goto/ redirector
    // (one request per job). Studio postings resolve to a first-party ATS URL we
    // surface as `applyUrl`; indie mailto: postings leave it unset. Opt out with
    // `resolve_apply: false` to keep the single-request (feed-only) behaviour.
    //
    // Fail-safe throughout: a goto that errors, times out, or resolves to a
    // mailto:/self link simply leaves applyUrl unset — the job is never dropped.
    if (entry.resolve_apply === false || typeof ctx.fetchLocation !== 'function') return jobs;

    await mapConcurrent(jobs, RESOLVE_CONCURRENCY, async (job) => {
      const goto = gotoUrlFor(job.url);
      if (!goto) return;
      try {
        const loc = await ctx.fetchLocation(goto, { timeoutMs: 8000 });
        const applyUrl = applyUrlFromLocation(loc);
        if (applyUrl) job.applyUrl = applyUrl;
      } catch { /* unreachable → leave applyUrl unset, the next scan can retry */ }
    });
    return jobs;
  },
};
