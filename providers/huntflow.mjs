// @ts-check
/** @typedef {import('./_types.js').Provider} Provider */

// Huntflow provider — Huntflow is a multi-tenant recruiting ATS whose hosted
// career sites live on huntflow.io subdomains, in two shapes:
//   {slug}.global.huntflow.io   (e.g. saygameshr.global.huntflow.io)
//   {slug}.huntflow.io          (e.g. saberjobs.huntflow.io)
// There is no single host suffix below .huntflow.io to key on and no shared
// host, so — like the Avature/Zoho providers — this one derives every endpoint
// from the entry's OWN careers_url origin and never leaves it.
//
// Surface: the career frontend is a Nuxt SPA, but it reads its data from a plain
// JSON API on the SAME origin (no auth, no CSRF for GET):
//   GET {origin}/api/vacancy?count=50&page=N&preview=false
//     → { total, page, items: [ {id, slug, position, money, division,
//                                city, archived_at}, … ] }
// `total` is the PAGE COUNT (ceil(records / count)), NOT the record count, and
// `count` is capped server-side (~50; count=100 → 404), so we request 50 per
// page and walk page=1..total. The server-rendered HTML only carries the first
// page, which is why we hit the API instead of scraping anchors.
//
// Each item: apply URL = {origin}/vacancy/{slug}; title = position; division →
// department (sub-studio label, often null); city → location (sometimes carries
// "Remote …"). There is no company field (one tenant == one studio, so company
// is the entry name), no per-job posted date, and no explicit remote flag —
// workMode is inferred from the city string. `archived_at != null` means the
// posting is closed → dropped.
//
// Routing: any *.huntflow.io careers_url auto-detects; everything is still
// pinned with explicit `provider: huntflow` in studios.yml for clarity.

const PAGE_SIZE = 50; // server caps `count` (~50); 100 → 404
const MAX_PAGES = 25; // safety stop (1250 openings) so a bad `total` can't loop

// Resolve {origin, host} from a portal entry. Returns null when the careers_url
// is missing or not an https URL.
export function resolveHuntflow(entry) {
  let url;
  try {
    url = new URL(entry && entry.careers_url ? entry.careers_url : '');
  } catch {
    return null;
  }
  if (url.protocol !== 'https:') return null;
  return { origin: url.origin, host: url.hostname.toLowerCase() };
}

const apiUrl = (origin, page) =>
  `${origin}/api/vacancy?count=${PAGE_SIZE}&page=${page}&preview=false`;

function clean(s) {
  return String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
}

/**
 * Map one Huntflow API page (`{ items: [...] }`) into job rows. Exported for
 * unit tests — pure, no I/O. Job URLs are built on the tenant origin
 * ({origin}/vacancy/{slug}); archived postings and rows without a usable slug
 * are dropped (fail-safe: a malformed page yields [] rather than throwing).
 *
 * @param {{items?: any[]}|null} payload — a parsed /api/vacancy response
 * @param {string} companyName — value written into job.company
 * @param {string} origin — the entry's careers origin
 * @param {Set<string>} [seen] — dedup set shared across pages
 * @returns {Array<{title:string,url:string,company:string,location:string,department?:string,workMode?:string}>}
 */
export function parseHuntflowPage(payload, companyName, origin, seen = new Set()) {
  const items = payload && Array.isArray(payload.items) ? payload.items : [];
  const jobs = [];
  for (const it of items) {
    if (!it || typeof it !== 'object') continue;
    if (it.archived_at != null) continue; // closed posting
    const slug = it.slug != null ? String(it.slug).trim() : '';
    if (!slug || !/^[A-Za-z0-9._-]+$/.test(slug)) continue;
    if (seen.has(slug)) continue;
    seen.add(slug);
    const title = clean(it.position);
    if (!title) continue;
    const location = clean(it.city);
    const department = clean(it.division);
    const workMode = /\bremote\b/i.test(location) ? 'remote' : '';
    jobs.push({
      title,
      url: `${origin}/vacancy/${slug}`,
      company: companyName || '',
      location,
      ...(department ? { department } : {}),
      ...(workMode ? { workMode } : {}),
    });
  }
  return jobs;
}

/** @type {Provider} */
export default {
  id: 'huntflow',

  detect(entry) {
    let url;
    try {
      url = new URL(entry && entry.careers_url ? entry.careers_url : '');
    } catch {
      return null;
    }
    if (url.protocol !== 'https:') return null;
    const host = url.hostname.toLowerCase();
    if (host === 'huntflow.io' || host.endsWith('.huntflow.io')) {
      return { url: apiUrl(url.origin, 1) };
    }
    return null;
  },

  async fetch(entry, ctx) {
    const resolved = resolveHuntflow(entry);
    if (!resolved) {
      throw new Error(
        `huntflow: cannot resolve careers origin for ${entry && entry.name} — set an https careers_url`,
      );
    }
    const { origin } = resolved;
    const seen = new Set();
    const out = [];
    // First page tells us how many pages exist (`total` = page count).
    const first = await ctx.fetchJson(apiUrl(origin, 1), {
      headers: { accept: 'application/json' },
      redirect: 'error',
    });
    out.push(...parseHuntflowPage(first, entry.name, origin, seen));
    const totalPages = Number(first && first.total);
    const pages = Number.isFinite(totalPages) ? Math.min(totalPages, MAX_PAGES) : 1;
    for (let page = 2; page <= pages; page++) {
      const data = await ctx.fetchJson(apiUrl(origin, page), {
        headers: { accept: 'application/json' },
        redirect: 'error',
      });
      out.push(...parseHuntflowPage(data, entry.name, origin, seen));
    }
    return out;
  },
};
