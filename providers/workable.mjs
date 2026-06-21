// @ts-check
/** @typedef {import('./_types.js').Provider} Provider */

import { toIsoDate } from './_util.mjs';

// Workable provider — hits the public markdown feed at /<slug>/jobs.md.
// Workable's documented JSON API requires an auth token; the markdown feed
// is the only no-auth public surface. Auto-detects from careers_url pattern
// `https://apply.workable.com/<slug>`. A tracked_companies entry can also
// set `provider: workable` explicitly to bypass detection.
//
// Empty-shell accounts: some studios (e.g. Side, Keywords Studios) publish via
// an embedded widget and leave the markdown export at /<slug>/jobs.md empty,
// even though the account carries hundreds of live roles. The keyless widget
// JSON at /api/v1/widget/accounts/<slug>?details=true still returns the full
// list, so when the markdown feed parses to zero rows we fall back to it.

const ALLOWED_WORKABLE_HOSTS = new Set(['apply.workable.com']);

function assertWorkableUrl(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`workable: invalid URL: ${url}`);
  }
  if (parsed.protocol !== 'https:') throw new Error(`workable: URL must use HTTPS: ${url}`);
  if (!ALLOWED_WORKABLE_HOSTS.has(parsed.hostname)) {
    throw new Error(`workable: untrusted hostname "${parsed.hostname}" — must be one of: ${[...ALLOWED_WORKABLE_HOSTS].join(', ')}`);
  }
  return url;
}

function resolveSlug(entry) {
  const raw = typeof entry.careers_url === 'string' ? entry.careers_url : '';
  if (!raw) return null;
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'https:') return null;
  if (parsed.hostname !== 'apply.workable.com') return null;
  const slug = parsed.pathname.split('/').filter(Boolean)[0];
  return slug || null;
}

function resolveFeedUrl(entry) {
  const slug = resolveSlug(entry);
  return slug ? `https://apply.workable.com/${slug}/jobs.md` : null;
}

function widgetUrl(slug) {
  return `https://apply.workable.com/api/v1/widget/accounts/${slug}?details=true`;
}

/** @type {import('./_types.js').Probe} */
export const probe = {
  // DocPlanner is a long-lived Workable tenant; the widget API returns its
  // account metadata ({name, jobs:[]}) — a clean 200 there proves the host
  // isn't throttling/banning us (a soft-block returns 403/429, not valid JSON).
  canary: 'docplanner',
  endpoints: [{
    kind: 'slug',
    // The widget account API is the keyless discovery surface (the provider
    // itself reads the markdown feed; the widget API is better for slug probing).
    url: (s) => `https://apply.workable.com/api/v1/widget/accounts/${s}?details=true`,
    where: (s) => `apply.workable.com/${s}`,
    careersUrl: (s) => `https://apply.workable.com/${s}`,
    parse: (d) => (d && Array.isArray(d.jobs)) ? { count: d.jobs.length, loc: d.jobs[0]?.location?.location_str || '' } : null,
  }],
};

/** @type {Provider} */
export default {
  id: 'workable',

  detect(entry) {
    const feedUrl = resolveFeedUrl(entry);
    return feedUrl ? { url: feedUrl } : null;
  },

  async fetch(entry, ctx) {
    const slug = resolveSlug(entry);
    if (!slug) throw new Error(`workable: cannot derive feed URL for ${entry.name}`);
    const feedUrl = `https://apply.workable.com/${slug}/jobs.md`;
    assertWorkableUrl(feedUrl);
    // redirect:'error' prevents SSRF via server-side redirects; combined with
    // assertWorkableUrl above it guarantees the final hostname stays in the allowlist.
    const text = await ctx.fetchText(feedUrl, { redirect: 'error' });
    const jobs = parseWorkableMarkdown(text, entry.name);
    if (jobs.length > 0) return jobs;

    // Empty markdown export — the account may publish via an embedded widget.
    // Fall back to the keyless widget JSON, which carries the full live list.
    const wUrl = widgetUrl(slug);
    assertWorkableUrl(wUrl);
    const data = await ctx.fetchJson(wUrl, { redirect: 'error' });
    return parseWorkableWidget(data, entry.name);
  },
};

/**
 * Parse Workable's keyless widget JSON
 * (/api/v1/widget/accounts/<slug>?details=true). Used as a fallback when the
 * markdown export is empty. Each job carries title, shortcode, url, location
 * fields (city/state/country), department, and published_on. URLs are
 * validated against `https://apply.workable.com/` like the markdown path.
 *
 * @param {unknown} data — parsed widget JSON
 * @param {string} companyName — value to write into job.company
 * @returns {Array<{title: string, url: string, company: string, location: string}>}
 */
export function parseWorkableWidget(data, companyName) {
  const jobs = [];
  const list = (data && typeof data === 'object' && Array.isArray(/** @type {any} */ (data).jobs))
    ? /** @type {any} */ (data).jobs : [];
  for (const j of list) {
    if (!j || typeof j !== 'object') continue;
    const title = typeof j.title === 'string' ? j.title.trim() : '';
    if (!title) continue;
    let url = typeof j.url === 'string' ? j.url
      : (j.shortcode ? `https://apply.workable.com/j/${j.shortcode}` : '');
    if (!url) continue;
    try {
      const parsedUrl = new URL(url);
      if (parsedUrl.protocol !== 'https:' || parsedUrl.hostname !== 'apply.workable.com') continue;
      url = parsedUrl.href;
    } catch {
      continue;
    }
    const location = [j.city, j.state, j.country].filter(s => typeof s === 'string' && s.trim()).join(', ');
    const postedDate = toIsoDate(typeof j.published_on === 'string' ? j.published_on : '');
    const department = typeof j.department === 'string' ? j.department.trim() : '';
    jobs.push({
      title,
      url,
      location,
      company: companyName,
      ...(postedDate ? { postedDate } : {}),
      ...(department ? { department } : {}),
    });
  }
  return jobs;
}

/**
 * Parse Workable's public markdown feed. Exported as a named export for unit
 * tests. The feed exposes a table:
 *   | Title | Department | Location | Type | Salary | Posted | Details |
 * where `Details` holds a markdown link
 *   [View](https://apply.workable.com/<slug>/jobs/view/<id>.md)
 * URLs are validated against `https://apply.workable.com/` — off-domain or
 * non-HTTPS [View] links are skipped (not emitted).
 *
 * @param {string} text — markdown body
 * @param {string} companyName — value to write into job.company
 * @returns {Array<{title: string, url: string, company: string, location: string}>}
 */
export function parseWorkableMarkdown(text, companyName) {
  if (typeof text !== 'string') return [];
  const jobs = [];
  for (const line of text.split('\n')) {
    if (!line.startsWith('|') || !line.includes('[View]')) continue;
    const cols = line.split('|').map(c => c.trim());
    // Cols: ['', title, dept, location, type, salary, posted, '[View](url.md)', '']
    if (cols.length < 8) continue;
    const title = cols[1];
    if (!title || title === 'Title') continue;
    const department = cols[2] || '';
    const location = cols[3] || '';
    const postedDate = toIsoDate(cols[6]);  // 'Posted' column; '' if unparseable
    const urlMatch = line.match(/\[View\]\(([^)]+)\)/);
    let url = urlMatch ? urlMatch[1] : '';
    if (url.endsWith('.md')) url = url.slice(0, -3);
    if (!url) continue;  // skip rows with no resolvable URL (e.g., malformed [View] link)

    // Validate the extracted URL — must parse as https://apply.workable.com/...
    try {
      const parsedUrl = new URL(url);
      if (parsedUrl.protocol !== 'https:' || parsedUrl.hostname !== 'apply.workable.com') continue;
      url = parsedUrl.href;
    } catch {
      continue;
    }

    jobs.push({
      title,
      url,
      location,
      company: companyName,
      ...(postedDate ? { postedDate } : {}),
      ...(department && department !== 'Department' ? { department } : {}),
    });
  }
  return jobs;
}
