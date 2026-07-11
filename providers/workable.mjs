// @ts-check
/** @typedef {import('./_types.js').Provider} Provider */

import { toIsoDate, stripHtml, attachDetail } from './_util.mjs';

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

  // url→identity (inverse of probe): mine apply.workable.com/{slug} or {slug}.workable.com
  // to { slug, careers_url } (the apply.workable.com form fetch() accepts).
  mineUrl(jobUrl) {
    let u; try { u = new URL(jobUrl); } catch { return null; }
    const h = u.hostname.toLowerCase();
    let slug = null;
    if (h === 'apply.workable.com') slug = u.pathname.split('/').filter(Boolean)[0];
    else if (h.endsWith('.workable.com')) {
      const sub = h.split('.')[0];
      if (sub && sub !== 'apply' && sub !== 'www') slug = sub;
    }
    return slug ? { slug, careers_url: `https://apply.workable.com/${slug}` } : null;
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

  // PAID detail (markdown path): the /jobs.md list carries no description, but
  // every per-job page has a clean markdown twin at `{job.url}.md`. One fetch per
  // job, gated by --extra-fetch (on by default) and the enrich cap/concurrency.
  // Widget-fallback jobs already carry description inline (see parseWorkableWidget),
  // so this only fires for the markdown listing — and never for off-domain URLs.
  async fetchDetail(job, ctx) {
    const url = typeof job?.url === 'string' ? job.url : '';
    if (!url) return null;
    // Guard: only the apply.workable.com job-view pages have a `.md` twin.
    let mdUrl;
    try {
      const u = new URL(url);
      if (u.protocol !== 'https:' || u.hostname !== 'apply.workable.com') return null;
      mdUrl = `${u.href.replace(/\.md$/i, '')}.md`;
    } catch {
      return null;
    }
    assertWorkableUrl(mdUrl);
    const md = await ctx.fetchText(mdUrl, { redirect: 'error' });
    const text = markdownToText(md);
    return text ? { text } : null;
  },
};

// Flatten Workable's per-job markdown to plain prose for the sponsorship
// enricher. Strips emphasis/heading/blockquote/code markers and link syntax so a
// bolded phrase ("cannot **sponsor**") can't hide a match behind `**`.
function markdownToText(md) {
  if (typeof md !== 'string' || !md) return '';
  return md
    .replace(/```[\s\S]*?```/g, ' ')           // fenced code blocks
    .replace(/`([^`]*)`/g, '$1')               // inline code
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')     // images
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')   // links → link text
    .replace(/[*_~]{1,3}/g, '')                // bold/italic/strike markers
    .replace(/^#{1,6}\s*/gm, '')               // ATX headings
    .replace(/^\s{0,3}>\s?/gm, '')             // blockquotes
    .replace(/\s+/g, ' ')
    .trim();
}

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
    // FREE inline detail: the widget's details=true payload already carries the
    // (HTML) description, so widget-sourced jobs skip the per-job fetchDetail.
    jobs.push(attachDetail({
      title,
      url,
      location,
      company: companyName,
      ...(postedDate ? { postedDate } : {}),
      ...(department ? { department } : {}),
    }, { text: stripHtml(j.description) }));
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
 * Columns are anchored from the RIGHT, not the left. Some accounts inject a
 * variable number of extra location-facet cells between Title and Department
 * (e.g. `| Title | North America | Canada | Europe | Fully Remote | Dept | … |`),
 * which shifts every left-counted field and would otherwise surface a region
 * name as the department (no role tag) and drop the real remote location. The
 * Details cell (holding the [View] link) is always last, and the six trailing
 * columns are fixed: … | Department | Location | Type | Salary | Posted | Details.
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
    const title = cols[1];
    if (!title || title === 'Title') continue;
    // Right-anchor on the Details cell (see docstring): extra facet cells can be
    // injected after Title, so counting fields from the left mislabels them.
    const viewIdx = cols.findIndex(c => c.includes('[View]'));
    if (viewIdx < 7) continue;  // need Title + the 6 fixed trailing columns
    const department = cols[viewIdx - 5] || '';
    const location = cols[viewIdx - 4] || '';
    const postedDate = toIsoDate(cols[viewIdx - 1]);  // 'Posted' column; '' if unparseable
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
