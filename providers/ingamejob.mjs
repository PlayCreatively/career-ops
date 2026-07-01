// @ts-check
/** @typedef {import('./_types.js').Provider} Provider */

import { splitLocationMode } from './_util.mjs';

// InGame Job provider — an AGGREGATOR board (like Hitmarker / Work With Indies /
// Games Jobs Direct), not a single company. One tracked_companies entry yields
// postings across many studios. ingamejob.com is games-industry-only and heavy
// on Unity/C# roles, which is exactly the gap the big-studio (mostly Unreal) ATS
// feeds leave open.
//
// Like Games Jobs Direct it's a server-rendered site with no public feed or JSON
// API (the `/en/jobs/rss` path just returns the SPA shell, not RSS; job detail
// pages carry no JSON-LD). Its `/en/jobs` listing — and every profession filter
// under `/en/jobs/p/{profession}` — is server-rendered and paginated 30 postings
// per page via `?page=N`. We walk those pages and parse the listing cards out of
// the HTML — no browser, pure HTTP + regex, zero Claude tokens.
//
// SCOPING VIA `queries`. The board is whole-industry and mobile/hypercasual
// heavy, so scanning the entire `/en/jobs` firehose drags in a lot of noise. The
// site exposes 47 profession filters (`/en/jobs/p/unity-developer`,
// `/en/jobs/p/c-developer`, `/en/jobs/p/technical-artist`, `/en/jobs/p/game-designer`,
// …), so scope the feed to the professions you care about with `queries` — the
// same idea as Hitmarker's `filter_by`, but as URL path segments. Each query is
// walked independently and the results are merged and de-duplicated by URL.
//
// Configure it explicitly in studios.yml:
//
//   - name: InGame Job
//     provider: ingame-job
//     queries:                 # optional — listing paths under /en/jobs/ to walk.
//       - p/unity-developer    #   Default: [''] → the whole /en/jobs board.
//       - p/c-developer
//       - p/technical-artist
//     host: ingamejob.com      # optional — regional subdomain (e.g. gb.ingamejob.com,
//                              #   is.ingamejob.com). Default: the global ingamejob.com.
//     pages: 10                # optional — cap pages walked PER query (default: walk
//                              #   until an empty page, hard-capped at 50 = ~1500/query).
//
// Each card is a `<div class="employer-job-listing-single …">` holding an
// `<h5><a href="…/en/job/{slug}">{title}</a></h5>`, a `la-building-o` company
// line, a `la-map-marker` location line, and a `la-clock-o` "Posted {N} {unit}
// ago" line. The posted date is RELATIVE, so we convert it to an absolute
// ISO-8601 stamp at fetch time. If a card breaks that shape we keep whatever
// parsed (fail-safe: a posting is never dropped just because one field was
// missing), and skip only cards with no usable title or URL.

const DEFAULT_HOST = 'ingamejob.com';
const MAX_PAGES = 50;  // hard per-query cap (~1500 jobs) so a layout change can't loop forever

function decodeEntities(s) {
  return String(s == null ? '' : s)
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

// Text after a Line Awesome icon, e.g. `<i class="la la-map-marker"></i> Remote`.
// The icon may carry extra classes (`text-muted la la-map-marker`) and the value
// runs until the next tag. Returns '' when the icon isn't present in the block.
function pickAfterIcon(block, iconClass) {
  const m = block.match(new RegExp(`class="[^"]*\\b${iconClass}\\b[^"]*"[^>]*></i>\\s*([^<]*)`));
  if (!m) return '';
  return decodeEntities(m[1]).replace(/\s+/g, ' ').trim();
}

// Convert InGame Job's relative "Posted {N} {unit} ago" line into an absolute
// ISO-8601 stamp, anchored to `now` (defaults to the current time). Handles
// "just now" / "today", the "a/an {unit} ago" wording, and minute→year units.
// Returns '' for anything it can't read, so the caller can spread it
// conditionally and never emits a bogus date.
export function parseRelativePostedDate(text, now = Date.now()) {
  const s = String(text == null ? '' : text).toLowerCase().replace(/^posted\s*/, '').trim();
  if (!s) return '';
  if (/^(just now|today|moments? ago)\b/.test(s)) return new Date(now).toISOString();
  if (/^yesterday\b/.test(s)) return new Date(now - 864e5).toISOString();
  const m = s.match(/^(?:(\d+)|an?)\s+(minute|hour|day|week|month|year)s?\s+ago/);
  if (!m) return '';
  const n = m[1] ? parseInt(m[1], 10) : 1;
  if (!Number.isFinite(n)) return '';
  const MS = {
    minute: 60e3,
    hour: 3600e3,
    day: 864e5,
    week: 7 * 864e5,
    month: 30 * 864e5,   // calendar-approximate; the board only reports coarse ages
    year: 365 * 864e5,
  };
  return new Date(now - n * MS[m[2]]).toISOString();
}

export function parseIngameJobPage(html, now = Date.now()) {
  if (typeof html !== 'string') return [];
  // Each posting is a `employer-job-listing-single` card; split on the class and
  // process each segment (the first split chunk is the pre-listing page chrome).
  const segments = html.split(/<div class="employer-job-listing-single/).slice(1);
  const jobs = [];
  for (const seg of segments) {
    // Title + URL live in the card's first `<a href="…/en/job/…">{title}</a>`.
    const a = seg.match(/<a\s+href="([^"]*\/en\/job\/[^"]+)"[^>]*>([\s\S]*?)<\/a>/);
    if (!a) continue;
    const url = decodeEntities(a[1]).trim();
    const title = decodeEntities(a[2].replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();
    if (!url || !title) continue;

    const company = pickAfterIcon(seg, 'la-building-o');
    const rawLocation = pickAfterIcon(seg, 'la-map-marker');
    // "Remote", "Remote, Warsaw", "Relocate, Vietnam", "Kyiv" — lift the work
    // mode out of the text so location stays place-only.
    const { location, workMode } = splitLocationMode(rawLocation);
    const postedDate = parseRelativePostedDate(pickAfterIcon(seg, 'la-clock-o'), now);

    jobs.push({
      title,
      url,
      company,
      location,
      ...(workMode ? { workMode } : {}),
      ...(postedDate ? { postedDate } : {}),
    });
  }
  return jobs;
}

// Normalise the configured host to a bare ingamejob.com hostname. Accepts a bare
// host ("gb.ingamejob.com"), a full URL, or nothing (→ global default). Anything
// that isn't an ingamejob.com host falls back to the default, so a typo can never
// point the walker at an unrelated site.
function resolveHost(raw) {
  const fallback = DEFAULT_HOST;
  if (typeof raw !== 'string' || !raw.trim()) return fallback;
  let h = raw.trim().toLowerCase();
  try { if (h.includes('/')) h = new URL(h.includes('://') ? h : `https://${h}`).hostname; } catch { return fallback; }
  h = h.replace(/^www\./, '');
  return h === DEFAULT_HOST || h.endsWith('.' + DEFAULT_HOST) ? h : fallback;
}

// Normalise the `queries` config into a clean list of path segments under
// /en/jobs/. Empty string means the whole board. Defaults to [''] (whole board).
function resolveQueries(raw) {
  if (!Array.isArray(raw)) return [''];
  const out = raw
    .filter((q) => typeof q === 'string')
    .map((q) => q.trim().replace(/^\/+|\/+$/g, ''));   // tolerate leading/trailing slashes
  return out.length ? [...new Set(out)] : [''];
}

/** @type {Provider} */
export default {
  id: 'ingame-job',

  // Opt-in via `provider: ingame-job`, but also claim entries whose careers_url
  // points at ingamejob.com (or a regional subdomain) so a pasted board URL routes
  // here.
  detect(entry) {
    let host;
    try {
      host = new URL(entry.careers_url || '').hostname.toLowerCase().replace(/^www\./, '');
    } catch {
      return null;
    }
    return host === DEFAULT_HOST || host.endsWith('.' + DEFAULT_HOST)
      ? { url: `https://${host}/en/jobs` }
      : null;
  },

  async fetch(entry, ctx) {
    const host = resolveHost(entry.host);
    const queries = resolveQueries(entry.queries);
    const requested = Number.isInteger(entry.pages) && entry.pages > 0 ? entry.pages : MAX_PAGES;
    const pages = Math.min(requested, MAX_PAGES);

    const jobs = [];
    const seen = new Set();
    for (const q of queries) {
      const path = q ? `/en/jobs/${q}` : '/en/jobs';
      for (let page = 1; page <= pages; page++) {
        const sep = path.includes('?') ? '&' : '?';
        const html = await ctx.fetchText(`https://${host}${path}${sep}page=${page}`, { redirect: 'error' });
        const batch = parseIngameJobPage(html);
        // An empty page is the only reliable end-of-listing signal — stop walking
        // this query (a full page is 30, so a short-but-nonempty page can still
        // be the last one, but an empty one definitely is).
        if (batch.length === 0) break;
        for (const job of batch) {
          // The same role surfaces under multiple profession queries; dedupe by
          // URL across the whole fetch so the snapshot doesn't double-count.
          if (seen.has(job.url)) continue;
          seen.add(job.url);
          jobs.push(job);
        }
      }
    }
    return jobs;
  },
};
