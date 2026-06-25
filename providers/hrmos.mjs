// @ts-check
/** @typedef {import('./_types.js').Provider} Provider */

// HRMOS provider — Japanese multi-tenant ATS (hrmos.co), used by Cygames,
// Bandai Namco, GAME FREAK, Square Enix JP, Kojima Productions and other JP
// studios. The board at https://hrmos.co/pages/<slug>/jobs server-renders the
// full job list as HTML (no JSON API), so we parse the repeated
// <li class="… jsc-joblist-cassette"> cassettes. Zero-token: one HTML GET per
// tenant, no per-job request.
//
// Auto-detects from a careers_url matching hrmos.co/pages/<slug>. The <slug> is
// the tenant id (e.g. `cygames`, `gamefreak`, or a numeric id like Kojima's).

const HRMOS_SLUG_RE = /hrmos\.co\/pages\/([^/?#]+)/i;

function resolveListUrl(entry) {
  const raw = typeof entry.careers_url === 'string' ? entry.careers_url : '';
  const m = raw.match(HRMOS_SLUG_RE);
  if (!m) return null;
  return `https://hrmos.co/pages/${m[1]}/jobs`;
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
 * Parse an HRMOS listing page. Exported for unit tests.
 *
 * Each posting is a `<li class="pg-list-cassette jsc-joblist-cassette">` block
 * containing one `<a href>` (the posting URL), one `<h2>` (the title) and a
 * `<li class="sg-tag-location">` (the office address).
 *
 * HRMOS tenants are Japan-based and render locations in Japanese (e.g.
 * "東京都渋谷区…"), which won't match an English "Japan" location filter. We
 * append ", Japan" to non-remote locations so the user's existing location
 * filter behaves predictably — an onsite Tokyo role is recognisably Japanese,
 * while an explicitly remote posting still passes through untagged.
 *
 * @param {string} html
 * @param {string} companyName
 * @returns {Array<{title: string, url: string, company: string, location: string}>}
 */
export function parseHrmosHtml(html, companyName) {
  const out = [];
  const re = /<li\b[^>]*class="[^"]*jsc-joblist-cassette[^"]*"[^>]*>/gi;
  const starts = [];
  let m;
  while ((m = re.exec(html))) {
    starts.push(m.index);
    if (m.index === re.lastIndex) re.lastIndex++;
  }
  for (let i = 0; i < starts.length; i++) {
    const block = html.slice(starts[i], i + 1 < starts.length ? starts[i + 1] : html.length);

    const urlM = block.match(/<a\b[^>]*href="([^"]+)"/i);
    const url = urlM ? urlM[1].trim() : '';
    if (!url || !/\/jobs\//.test(url)) continue;

    const titleM = block.match(/<h2[^>]*>([\s\S]*?)<\/h2>/i);
    const title = titleM ? stripTags(titleM[1]) : '';
    if (!title) continue;

    const locM = block.match(/class="[^"]*sg-tag-location[^"]*"[^>]*>([\s\S]*?)<\/li>/i);
    let location = locM ? stripTags(locM[1]) : '';
    if (location && !/remote|リモート|在宅/i.test(location) && !/japan/i.test(location)) {
      location = `${location}, Japan`;
    }

    out.push({ title, url, company: companyName, location });
  }
  return out;
}

/** @type {Provider} */
export default {
  id: 'hrmos',

  detect(entry) {
    const url = resolveListUrl(entry);
    return url ? { url } : null;
  },

  async fetch(entry, ctx) {
    const url = resolveListUrl(entry);
    if (!url) throw new Error(`hrmos: cannot derive listing URL for ${entry.name}`);
    const html = await ctx.fetchText(url, { redirect: 'follow' });
    return parseHrmosHtml(html, entry.name);
  },
};
