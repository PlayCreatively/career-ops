// @ts-check
/** @typedef {import('./_types.js').Provider} Provider */

import { normalizeWorkMode } from './_util.mjs';

// HERP careers provider — HERP (herp.co.jp) is a Japanese multi-tenant ATS. Every
// customer's public board lives on ONE shared host with the tenant slug in the
// path (like greenhouse/lever, unlike avature/hibob's per-tenant domains):
//
//   https://herp.careers/v1/<tenant>            (server-rendered HTML board)
//   https://herp.careers/v1/<tenant>/<jobId>    (server-rendered job page)
//
// The board is plain server-rendered HTML — no JS execution, no auth, no
// pagination (every published role is in the one page; verified the card count
// matches the tenant's live total on PlatinumGames 31 / ON Inc. 27 / DeNA 1).
// Each role is a `<a class="… requisition-list-card__header-anchor" href="/v1/
// <tenant>/<jobId>"><h2 class="requisition-list-card__header …">Title</h2></a>`
// card; category links use a different class (career-page-group-name-tag-…) so
// they're excluded by keying on the header-anchor class.
//
// HERP serves Japanese studios, so there is no clean per-job location field on
// the board (the job page buries a multi-site address blob); we set location to
// "Japan". Work mode is encoded in the title tag (【ハイブリッド勤務】 etc.) and
// parsed out. The board carries no posting date, so jobs have no postedDate.
//
// Routing is host-auto-detected: any https://herp.careers/v1/<tenant> careers_url
// claims this provider, so studios need no explicit `provider:` line. Every
// endpoint is derived from the entry's OWN origin + tenant and never leaves the
// host (same-origin is the security boundary — see assertSameOrigin).

const HERP_HOST = 'herp.careers';

// Parse {origin, host, tenant} from a portal entry's careers_url. The tenant is
// the first path segment after /v1. Returns null when the URL is missing, not
// https, not the herp.careers host, or has no /v1/<tenant> path.
export function resolveHerp(entry) {
  let url;
  try {
    url = new URL(entry && entry.careers_url ? entry.careers_url : '');
  } catch {
    return null;
  }
  if (url.protocol !== 'https:') return null;
  const host = url.hostname.toLowerCase();
  if (host !== HERP_HOST && !host.endsWith(`.${HERP_HOST}`)) return null;
  const segments = url.pathname.split('/').filter(Boolean);
  // Expect /v1/<tenant>[/...]; tenant must not be the requisition-groups subpath.
  if (segments[0] !== 'v1' || !segments[1] || segments[1] === 'requisition-groups') return null;
  return { origin: url.origin, host, tenant: segments[1] };
}

function boardUrl({ origin, tenant }) {
  return `${origin}/v1/${tenant}`;
}

// Guard a URL to the tenant board: https-only, exact host match, and the path
// must stay under this tenant's /v1/<tenant>/ namespace. Keeps the provider from
// being steered to another tenant or off-host.
function assertSameTenant(url, host, tenant) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`herp: invalid URL: ${url}`);
  }
  if (parsed.protocol !== 'https:') throw new Error(`herp: URL must use HTTPS: ${url}`);
  if (parsed.hostname.toLowerCase() !== host) {
    throw new Error(`herp: URL host "${parsed.hostname}" must match careers host "${host}"`);
  }
  if (!parsed.pathname.startsWith(`/v1/${tenant}`)) {
    throw new Error(`herp: URL path "${parsed.pathname}" must stay under /v1/${tenant}`);
  }
  return url;
}

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

function safeCodePoint(n) {
  if (!Number.isFinite(n) || n < 0 || n > 0x10ffff) return '';
  try {
    return String.fromCodePoint(n);
  } catch {
    return '';
  }
}

function decodeEntities(s) {
  return String(s == null ? '' : s)
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => safeCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => safeCodePoint(parseInt(d, 10)))
    .replace(/&([a-zA-Z]+);/g, (m, name) => (name in ENTITIES ? ENTITIES[name] : m));
}

function clean(s) {
  return decodeEntities(String(s == null ? '' : s).replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();
}

// Derive a work-mode token from the title text. HERP studios encode it in a
// leading 【…】 tag (【ハイブリッド勤務】, 【フルリモート】, 【出社】) or inline.
// Hybrid is checked first so "ハイブリッド勤務（一部リモート）" resolves to hybrid.
function herpWorkMode(text) {
  const t = String(text == null ? '' : text);
  if (/ハイブリッド|hybrid/i.test(t)) return normalizeWorkMode('hybrid');
  if (/フルリモート|テレワーク|在宅|リモート|remote|wfh|work\s*from\s*home/i.test(t)) return normalizeWorkMode('remote');
  if (/出社|常駐|オフィス勤務|on[\s-]?site|in[\s-]?office/i.test(t)) return normalizeWorkMode('onsite');
  return '';
}

// Strip the board's bookkeeping prefix ("01-14-02.") and the leading work-mode
// tag (【ハイブリッド勤務】) from a title, leaving the human-readable role name.
// Falls back to the un-stripped clean title if stripping empties it.
function cleanTitle(rawTitle) {
  const base = clean(rawTitle);
  const stripped = base
    .replace(/^\s*\d+(?:-\d+)*\.\s*/, '')
    .replace(/^【[^】]*】\s*/, '')
    .trim();
  return stripped || base;
}

/**
 * Parse a HERP board HTML page into job rows. Exported for unit tests. Keys on
 * the header-anchor class (one per card) so category-tag links are ignored;
 * job URLs are validated to the tenant's own /v1/<tenant>/ namespace and deduped.
 * Location is "Japan" (HERP serves Japanese studios; the board has no clean
 * per-job location). Work mode is parsed from the title tag.
 *
 * @param {string} html
 * @param {string} companyName — value written into job.company
 * @param {string} origin — e.g. https://herp.careers
 * @param {string} tenant — the path tenant slug, e.g. pgrecruit
 * @returns {Array<{title: string, url: string, company: string, location: string, workMode?: string}>}
 */
export function parseHerpList(html, companyName, origin, tenant) {
  if (typeof html !== 'string' || !html || !tenant) return [];
  const host = (() => { try { return new URL(origin).hostname.toLowerCase(); } catch { return ''; } })();
  // Order-tolerant: match the header-anchor card, then pull href from its attrs.
  const anchorRe = /<a\b([^>]*\brequisition-list-card__header-anchor\b[^>]*)>\s*<h2\b[^>]*>([\s\S]*?)<\/h2>\s*<\/a>/g;
  const jobs = [];
  const seen = new Set();
  let m;
  while ((m = anchorRe.exec(html)) !== null) {
    const attrs = m[1];
    const titleRaw = m[2];
    const hrefMatch = attrs.match(/\bhref="([^"]+)"/);
    if (!hrefMatch) continue;
    let href = decodeEntities(hrefMatch[1]);
    // Resolve relative hrefs against the tenant origin; reject category links.
    let url;
    try {
      url = new URL(href, origin);
    } catch {
      continue;
    }
    if (url.protocol !== 'https:' || url.hostname.toLowerCase() !== host) continue;
    if (!url.pathname.startsWith(`/v1/${tenant}/`)) continue;
    if (url.pathname.includes('/requisition-groups/')) continue;
    const finalUrl = url.href;
    if (seen.has(finalUrl)) continue;

    const title = cleanTitle(titleRaw);
    if (!title) continue;
    seen.add(finalUrl);

    const workMode = herpWorkMode(clean(titleRaw));
    jobs.push({
      title,
      url: finalUrl,
      company: companyName || '',
      location: 'Japan',
      ...(workMode ? { workMode } : {}),
    });
  }
  return jobs;
}

/** @type {Provider} */
export default {
  id: 'herp',

  detect(entry) {
    const resolved = resolveHerp(entry);
    return resolved ? { url: boardUrl(resolved) } : null;
  },

  // url→identity (inverse of probe): mine a herp.careers/v1/<tenant>/<jobId>
  // link to { slug, careers_url }. Lets the rehm miner resolve HERP studios.
  mineUrl(jobUrl) {
    let u;
    try {
      u = new URL(jobUrl);
    } catch {
      return null;
    }
    const h = u.hostname.toLowerCase();
    if (h !== HERP_HOST && !h.endsWith(`.${HERP_HOST}`)) return null;
    const segs = u.pathname.split('/').filter(Boolean);
    if (segs[0] !== 'v1' || !segs[1] || segs[1] === 'requisition-groups') return null;
    return { slug: segs[1], careers_url: `https://${HERP_HOST}/v1/${segs[1]}` };
  },

  async fetch(entry, ctx) {
    const resolved = resolveHerp(entry);
    if (!resolved) {
      throw new Error(`herp: cannot resolve tenant for ${entry && entry.name} — set careers_url to https://herp.careers/v1/<tenant>`);
    }
    const { origin, host, tenant } = resolved;
    const url = boardUrl(resolved);
    assertSameTenant(url, host, tenant);
    // redirect:'error' guards against redirect-based SSRF; the canonical no-slash
    // board URL returns 200 directly (a trailing slash 302s to this same URL).
    const html = await ctx.fetchText(url, { redirect: 'error' });
    return parseHerpList(html, entry.name, origin, tenant);
  },
};
