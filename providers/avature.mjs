// @ts-check
/** @typedef {import('./_types.js').Provider} Provider */

// Avature provider — Avature is a multi-tenant ATS where each customer runs on
// its own (usually white-labelled) domain, e.g. Electronic Arts at jobs.ea.com.
// There is NO shared host suffix to allowlist (unlike apply.workable.com or
// boards.greenhouse.io), so this provider derives every endpoint from the
// entry's OWN careers_url origin and never leaves it — same-origin is the
// security boundary, enforced by assertSameOrigin() below.
//
// Surface: the public careers search page paginates server-side via jobOffset:
//   {origin}/{locale}/careers/SearchJobs/?jobRecordsPerPage=20&jobOffset=N
// It returns server-rendered HTML (no auth, no JS execution needed). Page size
// is capped at 20 server-side regardless of jobRecordsPerPage, so we step
// jobOffset by 20 until a page returns zero cards (offsets past the total
// return an empty list — Avature does NOT wrap to page 1, verified on EA).
//
// The sibling RSS feed (.../SearchJobs/feed/) is deliberately NOT used: it
// ignores jobOffset and only ever returns ~20 recent items, so it can't cover a
// 400-posting board. We parse the HTML cards instead — each carries a JobDetail
// link, a title, and `list-item-location` / `list-item-department` spans.
//
// Routing: per-tenant domains can't be auto-derived from the host the way
// *.myworkdayjobs.com can, so pin the studio with explicit `provider: avature`
// (careers_url = the careers origin, e.g. https://jobs.ea.com). As a
// convenience, a careers_url whose path already points at /careers/SearchJobs
// or /careers/JobDetail is auto-detected.
//
// Avature's HTML cards carry no posting date (the only dated surface is the
// broken RSS feed), so jobs from this provider have no postedDate.

const PER_PAGE = 20;
const MAX_PAGES = 40; // hard cap: 40 * 20 = 800 postings per tenant.

// An Avature path may carry a locale prefix (en_US, en-US, fr_FR) before
// /careers. The search/feed URLs accept it but also work without it; we keep the
// one from careers_url when present and default to en_US otherwise.
const LOCALE_RE = /^[a-z]{2}([-_][A-Za-z]{2})?$/;

// Resolve {origin, host, locale} from a portal entry. Returns null when the
// careers_url is missing or not an https URL.
export function resolveAvature(entry) {
  let url;
  try {
    url = new URL(entry && entry.careers_url ? entry.careers_url : '');
  } catch {
    return null;
  }
  if (url.protocol !== 'https:') return null;
  const segments = url.pathname.split('/').filter(Boolean);
  const locale = segments.length && LOCALE_RE.test(segments[0]) ? segments[0] : 'en_US';
  return { origin: url.origin, host: url.hostname.toLowerCase(), locale };
}

function searchUrl({ origin, locale }, offset) {
  return `${origin}/${locale}/careers/SearchJobs/?jobRecordsPerPage=${PER_PAGE}&jobOffset=${offset}`;
}

// Guard every fetched URL against the entry's own origin: https-only and exact
// host match. This is what keeps a per-tenant provider from being steered to an
// arbitrary host (no shared allowlist is possible).
function assertSameOrigin(url, host) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`avature: invalid URL: ${url}`);
  }
  if (parsed.protocol !== 'https:') throw new Error(`avature: URL must use HTTPS: ${url}`);
  if (parsed.hostname.toLowerCase() !== host) {
    throw new Error(`avature: URL host "${parsed.hostname}" must match careers host "${host}"`);
  }
  return url;
}

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

// Decode the small set of HTML entities Avature emits in titles/locations
// (&amp;, &#39;, &#8226;, &nbsp;, …). Numeric refs are resolved generically.
function decodeEntities(s) {
  return String(s == null ? '' : s)
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => safeCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => safeCodePoint(parseInt(d, 10)))
    .replace(/&([a-zA-Z]+);/g, (m, name) => (name in ENTITIES ? ENTITIES[name] : m));
}

function safeCodePoint(n) {
  if (!Number.isFinite(n) || n < 0 || n > 0x10ffff) return '';
  try {
    return String.fromCodePoint(n);
  } catch {
    return '';
  }
}

function stripTags(s) {
  return String(s == null ? '' : s).replace(/<[^>]*>/g, ' ');
}

function clean(s) {
  return decodeEntities(stripTags(s)).replace(/\s+/g, ' ').trim();
}

/**
 * Parse an Avature SearchJobs HTML page into job rows. Exported for unit tests.
 * Keys on the result anchor `<a class="link link_result" href="...">Title</a>`
 * (one per card — the "More Information" button uses a different class, so each
 * card is counted once). Location and department come from the
 * `list-item-location` / `list-item-department` spans in the slice that follows
 * each anchor, up to the next card. Job URLs are validated same-origin/https.
 *
 * @param {string} html
 * @param {string} companyName — value written into job.company
 * @param {string} host — the entry's careers hostname (lowercased)
 * @returns {Array<{title: string, url: string, company: string, location: string}>}
 */
export function parseAvatureHtml(html, companyName, host) {
  if (typeof html !== 'string' || !html) return [];
  const anchorRe = /<a\s+class="link link_result"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
  const matches = [];
  let m;
  while ((m = anchorRe.exec(html)) !== null) {
    matches.push({ url: m[1], titleRaw: m[2], start: m.index, end: anchorRe.lastIndex });
  }
  const jobs = [];
  const seen = new Set();
  for (let i = 0; i < matches.length; i++) {
    const { url: rawUrl, titleRaw, end } = matches[i];
    let url = decodeEntities(rawUrl);
    try {
      const parsed = new URL(url);
      if (parsed.protocol !== 'https:' || parsed.hostname.toLowerCase() !== host) continue;
      url = parsed.href;
    } catch {
      continue;
    }
    const title = clean(titleRaw);
    if (!title) continue;
    if (seen.has(url)) continue;
    seen.add(url);

    // The subtitle spans live between this anchor and the next card's anchor.
    const sliceEnd = i + 1 < matches.length ? matches[i + 1].start : html.length;
    const slice = html.slice(end, sliceEnd);
    const locMatch = slice.match(/class="list-item-location"[^>]*>([\s\S]*?)<\/span>/);
    const deptMatch = slice.match(/class="list-item-department"[^>]*>([\s\S]*?)<\/span>/);
    const location = locMatch ? clean(locMatch[1]) : '';
    const department = deptMatch ? clean(deptMatch[1]) : '';

    jobs.push({
      title,
      url,
      location,
      company: companyName || '',
      ...(department ? { department } : {}),
    });
  }
  return jobs;
}

// No `probe` export: Avature tenants are per-tenant origins with no shared host
// or guessable slug, so they can't be auto-discovered by probe-studios.mjs the
// way greenhouse/ashby/etc. are — they're added manually with explicit
// `provider: avature`.

/** @type {Provider} */
export default {
  id: 'avature',

  detect(entry) {
    let url;
    try {
      url = new URL(entry && entry.careers_url ? entry.careers_url : '');
    } catch {
      return null;
    }
    if (url.protocol !== 'https:') return null;
    // Auto-claim only URLs that already look like Avature career paths; bare
    // tenant origins (e.g. https://jobs.ea.com) need explicit `provider: avature`.
    if (!/\/careers\/(SearchJobs|JobDetail)\b/i.test(url.pathname)) return null;
    const resolved = resolveAvature(entry);
    return resolved ? { url: searchUrl(resolved, 0) } : null;
  },

  async fetch(entry, ctx) {
    const resolved = resolveAvature(entry);
    if (!resolved) throw new Error(`avature: cannot resolve careers origin for ${entry && entry.name} — set an https careers_url`);
    const { host } = resolved;

    const jobs = [];
    const seen = new Set();
    for (let page = 0; page < MAX_PAGES; page++) {
      const url = searchUrl(resolved, page * PER_PAGE);
      assertSameOrigin(url, host);
      // redirect:'error' + same-origin assert keeps the final host inside the tenant.
      const html = await ctx.fetchText(url, { redirect: 'error' });
      const batch = parseAvatureHtml(html, entry.name, host);
      let added = 0;
      for (const job of batch) {
        if (seen.has(job.url)) continue;
        seen.add(job.url);
        jobs.push(job);
        added++;
      }
      // Stop at the first empty/short page, or if a page contributes nothing new
      // (defensive cycle guard — Avature returns empty past the total, but never
      // loop forever if a tenant behaves differently).
      if (batch.length === 0 || batch.length < PER_PAGE || added === 0) break;
    }
    return jobs;
  },
};
