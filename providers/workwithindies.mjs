// @ts-check
/** @typedef {import('./_types.js').Provider} Provider */

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
    const m = rawTitle.match(TITLE_RE);
    if (m) {
      const [, company, role, fromLoc, remote] = m;
      jobs.push({
        title: role.trim(),
        url,
        company: company.trim(),
        // Location stays place-only; remoteness goes to workMode, not the text.
        location: (fromLoc || '').trim(),
        ...(remote ? { workMode: 'remote' } : {}),
      });
    } else {
      // Fail-safe: keep the posting with the raw title so it can still match
      // the title filter and reach the pipeline.
      jobs.push({ title: rawTitle, url, company: '', location: '' });
    }
  }
  return jobs;
}

/** @type {Provider} */
export default {
  id: 'work-with-indies',

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
    return parseWorkWithIndiesFeed(xml);
  },
};
