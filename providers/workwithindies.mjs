// @ts-check
/** @typedef {import('./_types.js').Provider} Provider */

import { toIsoDate, stripHtml, attachDetail } from './_util.mjs';

// Work With Indies provider — an AGGREGATOR board (like Hitmarker), not a single
// company. One tracked_companies entry yields jobs across many indie studios.
// Work With Indies publishes a public RSS feed of every open posting at
// https://www.workwithindies.com/careers/rss.xml — no auth, no scraping.
//
// Indie/remote-heavy and friendly to earlier-career roles, so it complements the
// big-studio ATS feeds. Configure it explicitly:
//
//   - name: Work With Indies
//     provider: work-with-indies
//
// Each <item> title follows "{Company} is hiring a {Role} to work from {Loc}"
// (or "... to work remotely"), which we split into company/role/location. If a
// title ever breaks that shape we fall back to the raw title with empty
// company/location — fail-safe: a job is never dropped just because it didn't
// parse.

const FEED_URL = 'https://www.workwithindies.com/careers/rss.xml';

// Per-job page fetch concurrency for the closed-posting check (see below).
const VERIFY_CONCURRENCY = 8;

// "{Company} is hiring a/an {Role} to work from {Location}" | "... to work remotely"
const TITLE_RE = /^(.*?) is hiring an? (.*?) to work (?:from (.*?)|(remotely))\.?$/;

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

export function parseWorkWithIndiesFeed(xml) {
  const blocks = [...xml.matchAll(/<item>([\s\S]*?)<\/item>/g)].map(m => m[1]);
  const jobs = [];
  for (const block of blocks) {
    const url = decodeEntities(pickTag(block, 'link'));
    const rawTitle = decodeEntities(pickTag(block, 'title'));
    if (!url || !rawTitle) continue;
    // RFC-2822 pubDate (e.g. "Sat, 13 Jun 2026 00:00:00 GMT") → ISO-8601.
    const postedDate = toIsoDate(pickTag(block, 'pubDate'));
    // The RSS <description> is a one-line teaser (+ a "Tags: [...]" suffix), too
    // shallow for a visa-sponsorship line — those live deep in the JD. Attach it
    // as a FREE fallback anyway (harmless: the enricher is precision-first). The
    // closed-check in fetch() then upgrades kept jobs to the full page body.
    const blurb = stripHtml(decodeEntities(pickTag(block, 'description')));
    const m = rawTitle.match(TITLE_RE);
    if (m) {
      const [, company, role, fromLoc, remote] = m;
      jobs.push(attachDetail({
        title: role.trim(),
        url,
        company: company.trim(),
        // Location stays place-only; remoteness goes to workMode, not the text.
        location: (fromLoc || '').trim(),
        ...(remote ? { workMode: 'remote' } : {}),
        ...(postedDate ? { postedDate } : {}),
      }, { text: blurb }));
    } else {
      // Fail-safe: keep the posting with the raw title so it can still match
      // the title filter and reach the pipeline.
      jobs.push(attachDetail({ title: rawTitle, url, company: '', location: '', ...(postedDate ? { postedDate } : {}) }, { text: blurb }));
    }
  }
  return jobs;
}

// Whether a fetched job page shows the "This position has been closed." banner.
//
// The literal string is NOT a reliable signal: Webflow renders that banner into
// EVERY job page's HTML and merely hides it with the `w-condition-invisible`
// class while the posting is open. A closed posting drops that class so the
// banner (the `closed-notif` wrapper) becomes visible. So we look for a
// `closed-notif` element that is NOT Webflow-hidden, rather than for the text.
//
//   open:   <div class="closed-notif w-condition-invisible">…closed…</div>
//   closed: <div class="closed-notif">…closed…</div>
//
// Returns false for anything we can't positively read as closed — the caller is
// fail-safe and keeps a job whenever the page is ambiguous or unreachable.
export function isClosedPosting(html) {
  if (typeof html !== 'string' || !html) return false;
  for (const m of html.matchAll(/class="([^"]*\bclosed-notif\b[^"]*)"/g)) {
    if (!/\bw-condition-invisible\b/.test(m[1])) return true;
  }
  return false;
}

// Extract the plain-text JD body from a WWI job page. The description lives in a
// Webflow rich-text container `<div class="job-description w-richtext">…</div>`;
// we depth-match the surrounding <div> so nested block tags don't cut it short,
// then strip to prose. The closed-check already fetched this HTML, so reading the
// body here is FREE — no extra request. Exported for unit tests. Returns '' when
// the container is absent (fail-safe: the RSS blurb detail stays in place).
export function extractJobBody(html) {
  if (typeof html !== 'string' || !html) return '';
  const anchor = html.indexOf('job-description w-richtext');
  if (anchor === -1) return '';
  const open = html.lastIndexOf('<div', anchor);
  if (open === -1) return '';
  const re = /<\/?div\b[^>]*>/gi;
  re.lastIndex = open;
  let depth = 0, end = -1, m;
  while ((m = re.exec(html))) {
    if (m[0][1] === '/') { depth--; if (depth === 0) { end = m.index; break; } }
    else depth++;
  }
  if (end === -1) return '';
  return stripHtml(html.slice(open, end));
}

// Run async `worker` over `items` with a fixed concurrency cap, preserving order.
async function mapConcurrent(items, limit, worker) {
  const results = new Array(items.length);
  let i = 0;
  async function next() {
    while (i < items.length) {
      const idx = i++;
      results[idx] = await worker(items[idx], idx);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, next));
  return results;
}

/** @type {Provider} */
export default {
  id: 'work-with-indies',

  // Multi-studio board — hosts must be in scan.mjs DEFAULT_AGGREGATORS (see hitmarker).
  aggregatorHosts: ['workwithindies.com'],

  detect(entry) {
    let host;
    try {
      host = new URL(entry.careers_url || '').hostname.toLowerCase();
    } catch {
      return null;
    }
    return host === 'workwithindies.com' || host === 'www.workwithindies.com'
      ? { url: FEED_URL }
      : null;
  },

  async fetch(entry, ctx) {
    const feedUrl = typeof entry.feed_url === 'string' && entry.feed_url.trim()
      ? entry.feed_url.trim()
      : FEED_URL;
    const xml = await ctx.fetchText(feedUrl, { redirect: 'error' });
    const jobs = parseWorkWithIndiesFeed(xml);

    // Closed-posting filter. The RSS feed can still list a role after the studio
    // has closed it, so we open each job page and drop the ones whose "This
    // position has been closed." banner is actually visible. One extra request
    // per job — opt out with `verify_closed: false` in the studios.yml entry to
    // keep the single-request behaviour.
    //
    // Fail-safe throughout: a page that errors, times out, or reads ambiguously
    // is KEPT, so a flaky network never silently shrinks the feed.
    if (entry.verify_closed === false) return jobs;

    const open = await mapConcurrent(jobs, VERIFY_CONCURRENCY, async (job) => {
      try {
        const html = await ctx.fetchText(job.url, { timeoutMs: 8000 });
        if (isClosedPosting(html)) return null;
        // Same fetch, no extra request: upgrade the shallow RSS blurb to the full
        // page body so the sponsorship enricher sees the requirements section.
        const body = extractJobBody(html);
        return body ? attachDetail(job, { text: body }) : job;
      } catch {
        return job; // unreachable page → keep it, the next scan can re-check
      }
    });
    return open.filter(Boolean);
  },
};
