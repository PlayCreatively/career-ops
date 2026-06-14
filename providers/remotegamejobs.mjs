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

const FEED_URL = 'https://remotegamejobs.com/feed.rss';

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

/** @type {Provider} */
export default {
  id: 'remote-game-jobs',

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
    return parseRemoteGameJobsFeed(xml);
  },
};
