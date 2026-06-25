// @ts-check
/** @typedef {import('./_types.js').Provider} Provider */

// JazzHR provider — multi-tenant ATS served at <slug>.applytojob.com, used by
// Obsidian, Next Level Games, Certain Affinity, Sago Mini and others. The board
// root server-renders the job list as HTML (the RSS feed path 404s), so we
// parse the repeated `<li class="list-group-item">` rows. Zero-token: one HTML
// GET per tenant.
//
// Auto-detects from a careers_url matching <slug>.applytojob.com.

const JAZZHR_SLUG_RE = /([a-z0-9][a-z0-9-]*)\.applytojob\.com/i;

function resolveBoardUrl(entry) {
  const raw = typeof entry.careers_url === 'string' ? entry.careers_url : '';
  const m = raw.match(JAZZHR_SLUG_RE);
  if (!m) return null;
  return `https://${m[1].toLowerCase()}.applytojob.com/`;
}

function stripTags(s) {
  return String(s)
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Parse a JazzHR board page. Exported for unit tests.
 *
 * Each posting is a `<li class="list-group-item">` row with a heading anchor
 * `<h3 class="list-group-item-heading"><a href>…</a></h3>` and a location in the
 * first `<i class="fa fa-map-marker">` sibling. Only rows whose anchor points at
 * an `/apply/` path are real postings (the markup is also used for filters).
 *
 * @param {string} html
 * @param {string} companyName
 * @returns {Array<{title: string, url: string, company: string, location: string}>}
 */
export function parseJazzhrHtml(html, companyName) {
  const out = [];
  const re = /<li\b[^>]*class="[^"]*\blist-group-item\b[^"]*"[^>]*>/gi;
  const starts = [];
  let m;
  while ((m = re.exec(html))) {
    starts.push(m.index);
    if (m.index === re.lastIndex) re.lastIndex++;
  }
  for (let i = 0; i < starts.length; i++) {
    const block = html.slice(starts[i], i + 1 < starts.length ? starts[i + 1] : html.length);

    const aM = block.match(/<a\b[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i);
    if (!aM) continue;
    const url = aM[1].trim();
    if (!/\/apply\//.test(url)) continue;
    const title = stripTags(aM[2]);
    if (!title) continue;

    const locM = block.match(/fa-map-marker[^>]*>\s*<\/i>\s*([^<]+)/i);
    const location = locM ? stripTags(locM[1]) : '';

    out.push({ title, url, company: companyName, location });
  }
  return out;
}

/** @type {Provider} */
export default {
  id: 'jazzhr',

  detect(entry) {
    const url = resolveBoardUrl(entry);
    return url ? { url } : null;
  },

  async fetch(entry, ctx) {
    const url = resolveBoardUrl(entry);
    if (!url) throw new Error(`jazzhr: cannot derive board URL for ${entry.name}`);
    const html = await ctx.fetchText(url, { redirect: 'follow' });
    return parseJazzhrHtml(html, entry.name);
  },
};
