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
//     pages: 300              # optional — cap the pages walked (default: walk all)
//     enrich_country: true    # optional — grab the full location per posting (default: on)
//     enrich_experience: true # optional — grab the experience level per posting (default: on)
//     enrich_concurrency: 6   # optional — parallel detail fetches during enrichment
//     exclude_sectors:        # optional — drop these board sectors (case-insensitive)
//       - Finance
//       - HR
//       - Legal
//
// DETAIL-PAGE ENRICHMENT. Two useful fields live ONLY on each posting's detail
// page, never in the listing HTML: the fully-qualified Location ("City, Country")
// and the Experience Level (the board's own taxonomy — Junior-Associate,
// Mid-Senior Level, Director…). The Experience Level is present on every posting,
// so filling it in means fetching every posting's detail page (default on; opt
// out with `enrich_experience: false`). Because we're already visiting every
// posting for that, the authoritative Location is grabbed at the same time for
// free (opt out with `enrich_country: false`). Each detail page is fetched at
// most once and both fields are read from the single response. Enrichment is
// fail-safe throughout: a failed detail fetch keeps the listing location, omits
// the experience level, and never drops the posting.
//
// LOCATION. The board's listing cards carry an inconsistent `.job-location`:
// ~64% are already "City, Country" (e.g. "Daresbury, United Kingdom"), but ~36%
// are a bare city ("Guildford", "Krakow", "Las Vegas") with no country at all.
// Downstream targeting/ranking matches country names against `job.location`, so
// those bare-city postings silently slip through any country-level filter. The
// full location only exists on each posting's own detail page (a dedicated
// `Location` field — the listing HTML never sends it, and the board has no JSON
// feed), which we already fetch for every posting during enrichment (see below),
// so we replace the card location with the authoritative detail one. When
// enrichment is disabled the bare cities stay as-is. See DETAIL-PAGE ENRICHMENT.
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
const DEFAULT_ENRICH_CONCURRENCY = 6;  // parallel detail fetches when filling in country

// Lowercased English country names, generated from ISO-3166 alpha-2 codes via
// Intl so we never hand-maintain a names table. Used ONLY to skip a detail fetch
// when a card's location is already a bare country ("Romania", "Singapore") — a
// pure optimization, never a correctness gate. A spelling we miss (the board
// writes "Republic of Korea", Intl says "South Korea") just costs one harmless
// extra fetch; it can never produce wrong data.
const COUNTRY_NAMES = (() => {
  const set = new Set();
  try {
    const dn = new Intl.DisplayNames(['en'], { type: 'region', fallback: 'none' });
    const A = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
    for (const a of A) for (const b of A) {
      let name;
      try { name = dn.of(a + b); } catch { name = null; }
      if (name) set.add(name.toLowerCase());
    }
  } catch { /* Intl region names unavailable — set stays empty, we just enrich a bit more */ }
  // Board spellings Intl renders differently — keeps us from re-fetching these.
  for (const n of ['united states', 'czech republic', 'republic of korea', 'russia', 'turkey']) set.add(n);
  return set;
})();

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

// Does this listing-card location need a country looked up from the detail page?
// No when it's empty (nothing to enrich), already has a comma (the card's own
// "City, Country" form — last part is a real country ~98% of the time), or is
// itself a bare country. Yes only for a bare city like "Guildford" / "Krakow".
export function needsCountryEnrichment(location) {
  const loc = (location || '').trim();
  if (!loc) return false;
  if (loc.includes(',')) return false;
  return !COUNTRY_NAMES.has(loc.toLowerCase());
}

// Pull the value of a `<label>Name</label> <p>value</p>` field from a posting's
// detail page. The detail view renders each attribute this way (Location,
// Country, Experience Level, …). Returns '' when absent (older layout, expired
// posting). Shared by the field-specific extractors below.
/** @param {unknown} html @param {string} label @returns {string} */
function pickDetailField(html, label) {
  if (typeof html !== 'string') return '';
  const m = html.match(
    new RegExp(`<label[^>]*>\\s*${label}\\s*</label>\\s*<p[^>]*>([\\s\\S]*?)</p>`, 'i'),
  );
  if (!m) return '';
  return decodeEntities(m[1].replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();
}

// Pull the country from a posting's detail page. Returns '' when absent, so the
// caller falls back to the city-only location.
/** @param {unknown} html @returns {string} */
export function extractCountry(html) {
  return pickDetailField(html, 'Country');
}

// Pull the fully-qualified location from a posting's detail page. The detail
// `Location` field is the authoritative "City, Country" string — complete even
// for the bare-city cards the listing renders ("Las Vegas" → "Las Vegas, United
// States"). Returns '' when absent, so the caller keeps the listing location.
/** @param {unknown} html @returns {string} */
export function extractLocation(html) {
  return pickDetailField(html, 'Location');
}

// Pull the experience level from a posting's detail page — the board's own
// taxonomy (Junior-Associate, Mid-Senior Level, Director, …). This lives ONLY on
// the detail page; the listing card's `la-user` icon is a DIFFERENT, unreliable
// signal (it disagrees with this field), so we never trust the card for it.
// Returns '' when absent or the board's "Not specified" placeholder, so the
// field is omitted rather than storing noise.
/** @param {unknown} html @returns {string} */
export function extractExperienceLevel(html) {
  const v = pickDetailField(html, 'Experience Level');
  return /^not specified$/i.test(v) ? '' : v;
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

    // Work mode rides on a globe icon's tooltip (e.g. Remote / Hybrid). Other
    // job-level icons reuse the same tooltip attr — notably la-user, whose value
    // is NOT the experience level (it disagrees with the detail page's Experience
    // Level field), so we key strictly on the globe icon here and read the real
    // experience level from the detail page during enrichment below.
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

  // Multi-studio board — hosts must be in scan.mjs DEFAULT_AGGREGATORS (see hitmarker).
  aggregatorHosts: ['gamesjobsdirect.com'],

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
        // Blocked sector no longer drops: mark `filtered: true` so the job
        // survives into the snapshot and the board's global filters-off toggle
        // can reveal it. Hidden by default everywhere else (personal scans skip
        // flagged jobs at the scan.mjs gate).
        if (sectorFilter && !sectorFilter(job)) job.filtered = true;
        jobs.push(job);
      }
    }

    // Detail-page enrichment. Two fields only live on each posting's own detail
    // page, never in the listing HTML:
    //   • Experience Level — the board's taxonomy (Junior-Associate, Mid-Senior
    //     Level, Director, …). Present on EVERY posting → wanting it means
    //     fetching every detail page. Opt-out with `enrich_experience: false`.
    //   • Location — the authoritative "City, Country" string, complete even for
    //     the ~36% of cards the listing renders as a bare city ("Las Vegas").
    //     Opt-out with `enrich_country: false`.
    // We fetch each posting's detail page AT MOST ONCE and read whatever we're
    // after out of the single response. When experience enrichment is on we're
    // already visiting every posting, so location is grabbed for all of them for
    // free; when it's off, location enrichment falls back to fetching only the
    // bare-city cards (the cheap original behaviour). Fail-safe throughout: a
    // failed detail fetch keeps the listing location, omits the experience
    // level, and never drops the posting.
    const wantExperience = entry.enrich_experience !== false;
    const wantLocation = entry.enrich_country !== false;
    if ((wantExperience || wantLocation) && typeof ctx.fetchText === 'function') {
      const targets = jobs.filter((j) =>
        wantExperience || (wantLocation && needsCountryEnrichment(j.location)),
      );
      const concurrency = Number.isInteger(entry.enrich_concurrency) && entry.enrich_concurrency > 0
        ? entry.enrich_concurrency
        : DEFAULT_ENRICH_CONCURRENCY;
      let next = 0;
      const worker = async () => {
        while (next < targets.length) {
          const job = targets[next++];
          try {
            const html = await ctx.fetchText(job.url, { redirect: 'error' });
            if (wantLocation) {
              // Prefer the detail Location field (full "City, Country"); fall back
              // to appending just the Country for older layouts that omit it.
              const loc = extractLocation(html);
              if (loc) {
                job.location = loc;
              } else {
                const country = extractCountry(html);
                if (country && !job.location.toLowerCase().includes(country.toLowerCase())) {
                  job.location = job.location ? `${job.location}, ${country}` : country;
                }
              }
            }
            if (wantExperience) {
              const exp = extractExperienceLevel(html);
              if (exp) job.experienceLevel = exp;
            }
          } catch { /* keep listing location, omit experience level */ }
        }
      };
      await Promise.all(
        Array.from({ length: Math.min(concurrency, targets.length) }, worker),
      );
    }

    return jobs;
  },
};
