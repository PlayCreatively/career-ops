// @ts-check
/** @typedef {import('./_types.js').Provider} Provider */

import { toIsoDate, normalizeWorkMode } from './_util.mjs';

// Games Jobs Direct provider — an AGGREGATOR board (like Hitmarker / Work With
// Indies), not a single company. One tracked_companies entry yields postings
// across many studios.
//
// Unlike the RSS/JSON aggregators, gamesjobsdirect.com is a server-rendered
// ASP.NET site with no public feed or API. Its `/all-jobs` listing is the
// broadest server-rendered page (every sector, every location), paginated 10
// postings per page via `?page=N`. We walk those pages and parse the listing
// cards out of the HTML — no browser, pure HTTP + regex, zero Claude tokens.
//
// Configure it explicitly in studios.yml:
//
//   - name: Games Jobs Direct
//     provider: games-jobs-direct
//     pages: 300        # optional — cap the pages walked (default: walk all)
//
// Each card is a `<li class="list-group-item job-list ...">` with a
// `<a class="job-title">` (href + clean title attr) plus `.job-company`,
// `.job-location`, `.job-sector` spans, a `.job-posteddate` line, and an
// optional `<i class="la la-globe" data-original-title="Remote">` work-mode icon.
// If a card breaks that shape we keep whatever parsed (fail-safe: a posting is
// never dropped just because one field was missing), and skip only cards with no
// usable title or URL.

const BASE = 'https://www.gamesjobsdirect.com';
const LISTING_PATH = '/all-jobs';
const MAX_PAGES = 400;        // hard cap (~4000 jobs) so a layout change can't loop forever

function decodeEntities(s) {
  return String(s == null ? '' : s)
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&nbsp;/g, ' ');
}

// Pull the inner text of the first `<tag class="cls">…</tag>`, entity-decoded
// and whitespace-collapsed. Returns '' when absent.
function pickField(block, tag, cls) {
  const m = block.match(new RegExp(`<${tag}[^>]*class="${cls}"[^>]*>([\\s\\S]*?)</${tag}>`));
  if (!m) return '';
  return decodeEntities(m[1].replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();
}

export function parseGamesJobsDirectPage(html) {
  if (typeof html !== 'string') return [];
  const blocks = html.match(/<li class="list-group-item job-list[\s\S]*?<\/li>/g) || [];
  const jobs = [];
  for (const block of blocks) {
    // Title + URL. Prefer the clean `title="…"` attr; fall back to the link text.
    const a = block.match(/<a\s+href="(\/job\/[^"]+)"[^>]*class="job-title"[^>]*?(?:\stitle="([^"]*)")?[^>]*>([\s\S]*?)<\/a>/);
    if (!a) continue;
    const href = a[1];
    const title = decodeEntities(a[2] || a[3].replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();
    if (!href || !title) continue;
    const url = BASE + href;

    const company = pickField(block, 'span', 'job-company');
    const location = pickField(block, 'span', 'job-location');
    const department = pickField(block, 'span', 'job-sector');

    // "Posted - 11 Jun 2026" → ISO-8601.
    const dateText = (block.match(/class="job-posteddate"[^>]*>\s*Posted\s*-\s*([^<]+)</) || [])[1] || '';
    const postedDate = toIsoDate(dateText.trim());

    // Work mode rides on a globe icon's tooltip (e.g. Remote / Hybrid). Job-level
    // icons (la-user "Junior") use the same tooltip attr, so key strictly on the
    // globe icon and normalise the value.
    const modeTip = (block.match(/<i\s+class="la la-globe"[^>]*data-original-title="([^"]*)"/) || [])[1] || '';
    const workMode = normalizeWorkMode(modeTip);

    jobs.push({
      title,
      url,
      company,
      location,
      ...(workMode ? { workMode } : {}),
      ...(department ? { department } : {}),
      ...(postedDate ? { postedDate } : {}),
    });
  }
  return jobs;
}

/** @type {Provider} */
export default {
  id: 'games-jobs-direct',

  // Opt-in via `provider: games-jobs-direct`, but also claim entries whose
  // careers_url points at gamesjobsdirect.com so a pasted board URL routes here.
  detect(entry) {
    let host;
    try {
      host = new URL(entry.careers_url || '').hostname.toLowerCase();
    } catch {
      return null;
    }
    return host === 'gamesjobsdirect.com' || host === 'www.gamesjobsdirect.com'
      ? { url: BASE + LISTING_PATH }
      : null;
  },

  async fetch(entry, ctx) {
    const requested = Number.isInteger(entry.pages) && entry.pages > 0 ? entry.pages : MAX_PAGES;
    const pages = Math.min(requested, MAX_PAGES);

    const jobs = [];
    const seen = new Set();
    for (let page = 1; page <= pages; page++) {
      const html = await ctx.fetchText(`${BASE}${LISTING_PATH}?page=${page}`, { redirect: 'error' });
      const batch = parseGamesJobsDirectPage(html);
      // The ONLY reliable end-of-listing signal is an empty page — mid-listing
      // pages legitimately render fewer than a full slate (featured slots, ads),
      // so a short page must NOT stop the walk or we'd truncate the board.
      if (batch.length === 0) break;
      for (const job of batch) {
        // The sliding pagination can repeat a card across page boundaries; dedupe
        // within the fetch so the snapshot doesn't double-count.
        if (seen.has(job.url)) continue;
        seen.add(job.url);
        jobs.push(job);
      }
    }
    return jobs;
  },
};
