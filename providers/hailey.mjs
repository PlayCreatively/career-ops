// @ts-check
/** @typedef {import('./_types.js').Provider} Provider */

// Hailey HR provider — per-company career sites at {slug}.careers.haileyhr.app.
//
// Hailey HR offers no clean public REST feed: its documented /JobAd API needs a
// per-company Bearer token, and the career-page SPA fetches jobs server-side.
// BUT the career page is a Next.js App Router app that SERVER-RENDERS the job
// list into the initial HTML — the RSC "flight" payload carries a structured
// `"jobAds":[{ jobAdId, title, link, locationName, ... }]` array. We fetch the
// page HTML and parse that array: no auth, no browser, no scraping of rendered
// DOM. (Verified against live Hailey career pages, 2026.)
//
// Per-company like greenhouse/lever/teamtailor — one entry per studio:
//
//   - name: Thunderful Games
//     provider: hailey
//     careers_url: https://thunderfulgames.careers.haileyhr.app
//
// A site with zero open roles simply yields an empty jobAds array (no error).

// Pull the first string value of `field` from a bounded slice of flight text.
// The flight is escaped JSON embedded in JS, so we read fields directly rather
// than JSON.parse the (non-standard, $undefined-laden) RSC envelope.
function field(slice, name) {
  const m = slice.match(new RegExp(`"${name}":"((?:[^"\\\\]|\\\\.)*)"`));
  return m ? m[1].replace(/\\"/g, '"').replace(/\\\\/g, '\\') : '';
}

export function parseHaileyHtml(html, origin, fallbackCompany) {
  // Unescape the flight payload(s) so the embedded JSON fields are readable.
  const flight = [...html.matchAll(/self\.__next_f\.push\(\[\d+,"([\s\S]*?)"\]\)/g)]
    .map(m => m[1]).join('').replace(/\\"/g, '"');

  // Split on each job-ad object boundary; the first split is pre-amble.
  const parts = flight.split('"jobAdId":"');
  const jobs = [];
  const seen = new Set();
  for (let i = 1; i < parts.length; i++) {
    // Bound each record so a later object's fields can't bleed in.
    const slice = '"jobAdId":"' + parts[i].slice(0, 1200);
    const title = field(slice, 'title');
    const link = field(slice, 'link');
    if (!title || !link) continue;
    const url = link.startsWith('http') ? link : origin + link;
    if (seen.has(url)) continue;
    seen.add(url);
    jobs.push({
      title,
      url,
      company: fallbackCompany || '',
      location: field(slice, 'locationName'),
    });
  }
  return jobs;
}

/** @type {Provider} */
export default {
  id: 'hailey',

  detect(entry) {
    let host;
    try {
      host = new URL(entry.careers_url || '').hostname.toLowerCase();
    } catch {
      return null;
    }
    return host.endsWith('.careers.haileyhr.app')
      ? { url: entry.careers_url }
      : null;
  },

  async fetch(entry, ctx) {
    let origin;
    try {
      origin = new URL(entry.careers_url || '').origin;
    } catch {
      throw new Error(`hailey: invalid careers_url for ${entry.name}`);
    }
    if (!origin.startsWith('https:')) throw new Error(`hailey: careers_url must be https for ${entry.name}`);
    const html = await ctx.fetchText(origin + '/', { redirect: 'error' });
    return parseHaileyHtml(html, origin, entry.name);
  },
};
