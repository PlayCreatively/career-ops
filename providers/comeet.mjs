// @ts-check
/** @typedef {import('./_types.js').Provider} Provider */

import { toIsoDate, normalizeWorkMode } from './_util.mjs';

// Comeet provider — the Israeli multi-tenant ATS behind Moon Active, SuperPlay,
// CrazyLabs and many other (often Tel Aviv-based) game studios. Each tenant has
// a public board at https://www.comeet.com/jobs/<slug>/<uid> rendered by an
// AngularJS app that pulls its positions from a clean public JSON endpoint:
//
//   https://www.comeet.com/careers-api/2.0/company/<uid>/positions?token=<token>
//
// The catch: that endpoint needs a per-company `token` we can't guess — but the
// board page embeds it verbatim as `"token": "<hex>"`. So we do two GETs per
// tenant: scrape the token off the board page, then fetch the JSON. Zero-token
// (LLM-wise), no per-job request. We scrape the token each run rather than
// pinning it in studios.yml, so a rotated token self-heals and no public secret
// lands in the tracked config.
//
// Auto-detects from a careers_url on comeet.com with a parseable /jobs/<slug>/<uid>
// path. The <uid> (e.g. 28.003) is Comeet's company id; the API rejects the
// human slug, so the path must carry it. Studios self-hosting the Comeet widget
// on their own domain are wired explicitly with their comeet.com board URL.

// /jobs/<slug>/<uid> — slug is the vanity name, uid is Comeet's company id.
const COMEET_RE = /(?:www\.)?comeet\.com\/jobs\/([^/?#]+)\/([^/?#]+)/i;

// The public API token the board page embeds (40-ish hex chars). The same page
// also has `"token": COMPANY_DATA.token` (no string literal), which this skips.
const TOKEN_RE = /"token"\s*:\s*"([A-Za-z0-9]{16,})"/;

function resolveTenant(entry) {
  const raw = typeof entry.careers_url === 'string' ? entry.careers_url : '';
  const m = raw.match(COMEET_RE);
  if (!m) return null;
  const slug = m[1];
  const uid = m[2];
  return {
    slug,
    uid,
    pageUrl: `https://www.comeet.com/jobs/${slug}/${uid}`,
    apiUrl: (token) =>
      `https://www.comeet.com/careers-api/2.0/company/${encodeURIComponent(uid)}/positions?token=${encodeURIComponent(token)}`,
  };
}

/**
 * Map Comeet's positions JSON into the scanner's job shape. Exported for unit
 * tests. Each record carries `name`, a `location` object, `department`,
 * `workplace_type` ('Remote'|'Hybrid'|'On-site'), `time_updated`, `uid`, and a
 * ready-made `url_comeet_hosted_page`. Records missing a name or a usable URL
 * are skipped.
 *
 * @param {Array<object>} positions
 * @param {string} companyName
 * @returns {Array<{title: string, url: string, company: string, location: string, postedDate?: string, workMode?: string, department?: string}>}
 */
export function mapComeetPositions(positions, companyName) {
  if (!Array.isArray(positions)) return [];
  const out = [];
  // A position linked to multiple locations is emitted once per location: the
  // canonical base record with uid `<base>` plus per-location variants uid
  // `<base>-<locUid>` (e.g. "A7.96E" + "A7.96E-96.508", same "Game Level
  // Designer"). Comeet uids are dot-joined hex groups; the `-` only ever joins a
  // location suffix, so the base uid is everything before the first `-`. Dedup on
  // that base, and let the canonical base record win over a location variant.
  const baseUid = (uid) => String(uid).split('-')[0];
  const seen = new Map(); // baseUid -> index in `out`
  for (const rec of positions) {
    if (!rec || typeof rec !== 'object') continue;
    const title = typeof rec.name === 'string' ? rec.name.trim() : '';
    const url = rec.url_comeet_hosted_page || rec.url_active_page || rec.position_url || '';
    if (!title || !url) continue;

    const loc = rec.location && typeof rec.location === 'object' ? rec.location : null;
    const location = loc && typeof loc.name === 'string' ? loc.name.trim() : '';
    // Prefer the structured workplace_type; fall back to the location's
    // is_remote flag when the field is absent.
    const workMode = normalizeWorkMode(rec.workplace_type) || (loc && loc.is_remote ? 'remote' : '');
    // Comeet exposes only time_updated (last edit), no created date — it's the
    // best freshness signal available.
    const postedDate = toIsoDate(rec.time_updated);
    const department = typeof rec.department === 'string' ? rec.department.trim() : '';

    const job = {
      title,
      url,
      company: companyName,
      location,
      ...(postedDate ? { postedDate } : {}),
      ...(workMode ? { workMode } : {}),
      ...(department ? { department } : {}),
    };

    if (rec.uid == null) {
      out.push(job); // no uid to key on — never drop, it can't be proven a dupe
      continue;
    }
    const base = baseUid(rec.uid);
    if (!seen.has(base)) {
      seen.set(base, out.length);
      out.push(job);
      continue;
    }
    // Already have this base. Keep the canonical base record (uid === base) over a
    // location-suffixed variant; otherwise the first-seen one stays.
    if (rec.uid === base) out[seen.get(base)] = job;
  }
  return out;
}

/** @type {Provider} */
export default {
  id: 'comeet',

  detect(entry) {
    const t = resolveTenant(entry);
    return t ? { url: t.pageUrl } : null;
  },

  async fetch(entry, ctx) {
    const t = resolveTenant(entry);
    if (!t) throw new Error(`comeet: cannot derive tenant from careers_url for ${entry.name}`);

    const html = await ctx.fetchText(t.pageUrl, { redirect: 'follow' });
    const tm = html.match(TOKEN_RE);
    if (!tm) throw new Error(`comeet: no API token found on board page for ${entry.name} (${t.pageUrl})`);

    const positions = await ctx.fetchJson(t.apiUrl(tm[1]), { redirect: 'follow' });
    if (!Array.isArray(positions)) {
      const msg = positions && positions.message ? positions.message : 'unexpected API response';
      throw new Error(`comeet: ${msg} for ${entry.name}`);
    }
    return mapComeetPositions(positions, entry.name);
  },
};
