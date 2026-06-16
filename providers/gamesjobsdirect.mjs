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
//     exclude_sectors:  # optional — drop these board sectors (case-insensitive)
//       - Finance
//       - HR
//       - Legal
//
// Because this is a *whole-industry* board, its `/all-jobs` listing mixes
// game-craft roles (Programming, Art, Animation, Design, Audio, Production, QA…)
// with business/back-office functions (Finance, HR, Legal, Sales, Marketing, PR,
// Administration, Operations, Customer Services) and the Gambling sector. Title
// keyword filters in scan.mjs don't reliably catch these (a "Senior Finance
// Manager" carries no negative keyword), so the board leaks non-craft postings.
// `exclude_sectors` filters on the board's own sector taxonomy — the most
// reliable signal — and is fail-safe: a card whose sector didn't parse is NEVER
// dropped (we'd rather pass a stray than silently swallow a real role). The board
// sectors are: Administration, Animation, Art, Audio, Customer Services, Design,
// Education, eSports, Finance, Gambling, HR, Journalism & Copywriting, Legal,
// Localisation, Marketing, Operations, PR, Production, Programming, QA, Sales,
// VR and AI, Web Development.
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
    // Numeric character references first — this board emits CJK (and other
    // non-Latin) text as decimal/hex entities, e.g. a bilingual title like
    // "3D Environment Trainee&#19977;&#32500;…". Decode them to real characters
    // so they don't leak through as raw `&#NNN;` codes. fromCodePoint can throw
    // on out-of-range values, so guard and drop anything invalid.
    .replace(/&#(\d+);/g, (m, dec) => {
      const cp = Number(dec);
      try { return String.fromCodePoint(cp); } catch { return ''; }
    })
    .replace(/&#x([0-9a-fA-F]+);/g, (m, hex) => {
      const cp = parseInt(hex, 16);
      try { return String.fromCodePoint(cp); } catch { return ''; }
    })
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

// Build a case-insensitive sector-blocklist predicate from an entry's
// `exclude_sectors` config. Returns null when nothing is configured (caller
// skips filtering entirely). Non-string / empty entries are ignored so a stray
// list item can't accidentally void the whole filter.
export function buildSectorFilter(excludeSectors) {
  if (!Array.isArray(excludeSectors)) return null;
  const blocked = new Set(
    excludeSectors
      .filter((s) => typeof s === 'string')
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean),
  );
  if (blocked.size === 0) return null;
  // Fail-safe: a job with no parsed department is KEPT — we only drop a posting
  // when its sector is present AND explicitly blocked.
  return (job) => {
    const dept = (job.department || '').trim().toLowerCase();
    return dept === '' || !blocked.has(dept);
  };
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

    // Optional sector blocklist (whole-industry board → drop non-craft sectors).
    const sectorFilter = buildSectorFilter(entry.exclude_sectors);

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
        // within the fetch so the snapshot doesn't double-count. Dedup runs before
        // the sector gate so a blocked card never silently masks a later keeper.
        if (seen.has(job.url)) continue;
        seen.add(job.url);
        if (sectorFilter && !sectorFilter(job)) continue;
        jobs.push(job);
      }
    }
    return jobs;
  },
};
