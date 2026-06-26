// @ts-check
/** @typedef {import('./_types.js').Provider} Provider */

// Personio provider — hits the public XML job feed every Personio career site
// ships at `{site-origin}/xml` (the documented, keyless "workzag-jobs" feed used
// for syndication). No auth, no scraping. Per-company like greenhouse/lever:
// one tracked_companies entry per studio.
//
// Personio career sites live at `{slug}.jobs.personio.de` (or `.com`/`.es`), and
// sometimes on a custom domain. Routing is via detect() on the *.jobs.personio.*
// host, or an explicit `provider: personio` for custom domains:
//
//   - name: Yager
//     provider: personio
//     careers_url: https://yager.jobs.personio.de
//
// careers_url may be the site root or any page on it — the feed and per-job URLs
// are derived from its origin. An empty board yields an empty <workzag-jobs/> (no
// error). Each <position> public URL is `{origin}/job/{id}`.

// Derive the XML feed URL from any URL on a Personio career site. An explicit
// `feed_url` wins so an unusual deployment can be pinned by hand.
function resolveFeedUrl(entry) {
  if (typeof entry.feed_url === 'string' && entry.feed_url.trim()) return entry.feed_url.trim();
  const raw = entry.careers_url || '';
  let origin;
  try {
    origin = new URL(raw).origin;
  } catch {
    return null;
  }
  if (!origin.startsWith('https:')) return null;
  return `${origin}/xml`;
}

function originOf(entry) {
  try { return new URL(entry.feed_url || entry.careers_url || '').origin; } catch { return ''; }
}

// Read the first value of <tag> from a position block, unwrapping CDATA and
// decoding the handful of XML entities Personio emits. The feed is small and
// regex-parsed (house style — cf. hailey/teamtailor) rather than pulling an XML dep.
function tag(block, name) {
  const m = block.match(new RegExp(`<${name}>([\\s\\S]*?)</${name}>`, 'i'));
  if (!m) return '';
  let v = m[1].trim();
  const cdata = v.match(/^<!\[CDATA\[([\s\S]*?)\]\]>$/);
  if (cdata) v = cdata[1];
  return v
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#0?39;|&apos;/g, "'")
    .replace(/\s+/g, ' ').trim();
}

// Modern Personio career sites (newer tenants) no longer serve the legacy
// `/xml` workzag feed — it 404s — but expose the same openings as JSON at
// `{origin}/search.json?language=en` (the data the React board hydrates from).
// Each record carries id, name, office (headline city), department. Per-job URL
// is the same `{origin}/job/{id}`. Exported for unit tests.
export function parsePersonioSearchJson(text, origin, fallbackCompany) {
  let arr;
  try { arr = JSON.parse(text); } catch { return []; }
  if (!Array.isArray(arr)) return [];
  const jobs = [];
  const seen = new Set();
  for (const rec of arr) {
    if (!rec || typeof rec !== 'object') continue;
    const id = rec.id != null ? String(rec.id) : '';
    const title = typeof rec.name === 'string' ? rec.name.trim() : '';
    if (!id || !title) continue;
    const url = origin ? `${origin}/job/${id}` : '';
    if (!url || seen.has(url)) continue;
    seen.add(url);
    const location = typeof rec.office === 'string' ? rec.office.trim() : '';
    const department = typeof rec.department === 'string' ? rec.department.trim() : '';
    jobs.push({ title, url, company: fallbackCompany || '', location, ...(department ? { department } : {}) });
  }
  return jobs;
}

export function parsePersonioFeed(xml, origin, fallbackCompany) {
  const jobs = [];
  const seen = new Set();
  for (const m of String(xml).matchAll(/<position>([\s\S]*?)<\/position>/gi)) {
    const block = m[1];
    const id = tag(block, 'id');
    const title = tag(block, 'name');
    if (!id || !title) continue;
    const url = origin ? `${origin}/job/${id}` : '';
    if (!url || seen.has(url)) continue;
    seen.add(url);
    // office is the canonical location field; some feeds also carry an <office>
    // per jobDescription, but the position-level one is the headline city.
    const location = tag(block, 'office');
    jobs.push({ title, url, company: fallbackCompany || '', location });
  }
  return jobs;
}

/** @type {Provider} */
export default {
  id: 'personio',

  detect(entry) {
    let host;
    try {
      host = new URL(entry.careers_url || '').hostname.toLowerCase();
    } catch {
      return null;
    }
    // *.jobs.personio.de / .com / .es etc. Custom domains route via explicit provider.
    if (!/\.jobs\.personio\.[a-z]+$/.test(host)) return null;
    const feedUrl = resolveFeedUrl(entry);
    return feedUrl ? { url: feedUrl } : null;
  },

  // url→identity (inverse of probe): mine a {slug}.jobs.personio.{tld} link to
  // { slug, careers_url }; careers_url is the site origin (tld preserved).
  mineUrl(jobUrl) {
    let u; try { u = new URL(jobUrl); } catch { return null; }
    if (!/\.jobs\.personio\.[a-z]+$/.test(u.hostname.toLowerCase())) return null;
    const slug = u.hostname.split('.')[0];
    return slug ? { slug, careers_url: u.origin } : null;
  },

  async fetch(entry, ctx) {
    const origin = originOf(entry);
    const feedUrl = resolveFeedUrl(entry);
    if (!feedUrl) throw new Error(`personio: cannot derive feed URL for ${entry.name} — set careers_url (https) or feed_url`);

    // An explicit feed_url ending in .json pins the modern endpoint directly.
    const isJsonFeed = /\.json(\?|$)/i.test(feedUrl);

    // Legacy `/xml` feed first (still live on many tenants, cheapest, has the
    // richest location data). A 404 (newer tenant) or an empty board falls
    // through to the modern search.json feed.
    if (!isJsonFeed) {
      try {
        const xml = await ctx.fetchText(feedUrl, { redirect: 'error' });
        const jobs = parsePersonioFeed(xml, origin, entry.name);
        if (jobs.length) return jobs;
      } catch { /* legacy feed gone — fall through to search.json */ }
    }

    const searchUrl = isJsonFeed ? feedUrl : (origin ? `${origin}/search.json?language=en` : '');
    if (!searchUrl) throw new Error(`personio: cannot derive search.json URL for ${entry.name}`);
    const text = await ctx.fetchText(searchUrl, { redirect: 'follow' });
    return parsePersonioSearchJson(text, origin, entry.name);
  },
};
