// @ts-check
/** @typedef {import('./_types.js').Provider} Provider */
/** @typedef {import('./_types.js').DetailPayload} DetailPayload */

import { normalizeWorkMode, stripHtml } from './_util.mjs';

// Rippling ATS provider — the recruiting board behind a growing number of UK/EU
// studios (Kinetic Games, …). The public board page at
// https://ats.rippling.com/<slug>/jobs is a React app; the data comes from a
// clean public JSON API on a DIFFERENT host:
//
//   list:   https://api.rippling.com/platform/api/ats/v1/board/<slug>/jobs
//   detail: https://api.rippling.com/platform/api/ats/v1/board/<slug>/jobs/<uuid>
//
// (ats.rippling.com itself sits behind Cloudflare and 404s the API path — the
// api.rippling.com host is the one that answers.) The list gives title, url,
// department and a single workLocation label; company/location/title are all
// present, so Rippling needs NO detail fetch to be usable. The ONLY thing the
// detail adds is the description prose — which is where a posting states its visa
// stance ("we are unable to provide visa sponsorship. Applicants must have the
// right to work in the UK."). So detail is OPT-IN (runs under --enrich, not on
// every scan) and low-concurrency, since it's the throttle-prone extra hop.
//
// Wire a studio in studios.yml with its board URL:
//
//   - name: Kinetic Games
//     careers_url: https://ats.rippling.com/kinetic-games-careers/jobs
//     provider: rippling            # optional — detect() also claims the host

const API_BASE = 'https://api.rippling.com/platform/api/ats/v1/board';

// The board slug is the first path segment of an ats.rippling.com URL
// (e.g. .../kinetic-games-careers/jobs → "kinetic-games-careers").
function slugFrom(url) {
  try {
    const u = new URL(url);
    if (!/(^|\.)rippling\.com$/i.test(u.hostname)) return '';
    const seg = u.pathname.split('/').filter(Boolean);
    return seg[0] || '';
  } catch {
    return '';
  }
}

// A job page URL → { slug, uuid } for the detail endpoint. Path is
// /<slug>/jobs/<uuid>. Returns null when it doesn't fit.
function detailRefFrom(url) {
  try {
    const seg = new URL(url).pathname.split('/').filter(Boolean);
    const i = seg.indexOf('jobs');
    if (i === -1 || !seg[0] || !seg[i + 1]) return null;
    return { slug: seg[0], uuid: seg[i + 1] };
  } catch {
    return null;
  }
}

// Rippling encodes work mode INTO the location label as "Mode (Place)" —
// "Hybrid (Southampton, England, GB)", "Remote (United States)", or occasionally
// a bare "Remote". Split it into a clean place string + a normalized workMode.
// Fail-safe: a label that doesn't fit the pattern is kept whole as the location
// with no mode. Exported for unit tests.
export function parseWorkLocationLabel(label) {
  const raw = (label == null ? '' : String(label)).trim();
  if (!raw) return { location: '', workMode: '' };
  const m = raw.match(/^(hybrid|remote|on-?site|in-office|in-person|onsite)\s*\((.+)\)\s*$/i);
  if (m) return { location: m[2].trim(), workMode: normalizeWorkMode(m[1]) };
  // Bare mode word with no parenthesised place.
  const bare = normalizeWorkMode(raw);
  if (bare) return { location: '', workMode: bare };
  return { location: raw, workMode: '' };
}

/**
 * Map Rippling's board list JSON into the scanner's job shape. Exported for unit
 * tests. Each record has `name`, `url`, an optional `department.label` and a
 * `workLocation.label` (or, defensively, a `workLocations[0]`). Records without a
 * name or url are skipped.
 *
 * @param {Array<object>} list
 * @param {string} companyName
 * @returns {Array<{title:string,url:string,company:string,location:string,workMode?:string,department?:string}>}
 */
export function mapRipplingJobs(list, companyName) {
  if (!Array.isArray(list)) return [];
  const out = [];
  for (const rec of list) {
    if (!rec || typeof rec !== 'object') continue;
    const title = typeof rec.name === 'string' ? rec.name.trim() : '';
    const url = typeof rec.url === 'string' ? rec.url.trim() : '';
    if (!title || !url) continue;

    const label = rec.workLocation && typeof rec.workLocation === 'object'
      ? rec.workLocation.label
      : Array.isArray(rec.workLocations) ? rec.workLocations[0] : '';
    const { location, workMode } = parseWorkLocationLabel(label);
    const department = rec.department && typeof rec.department === 'object' && typeof rec.department.label === 'string'
      ? rec.department.label.trim()
      : '';

    out.push({
      title,
      url,
      company: companyName,
      location,
      ...(workMode ? { workMode } : {}),
      ...(department ? { department } : {}),
    });
  }
  return out;
}

/** @type {Provider} */
export default {
  id: 'rippling',

  detect(entry) {
    const slug = slugFrom(entry.careers_url || '');
    return slug ? { url: `${API_BASE}/${encodeURIComponent(slug)}/jobs` } : null;
  },

  async fetch(entry, ctx) {
    const slug = slugFrom(entry.careers_url || '');
    if (!slug) throw new Error(`rippling: cannot derive board slug from careers_url for ${entry.name}`);
    const list = await ctx.fetchJson(`${API_BASE}/${encodeURIComponent(slug)}/jobs`, { redirect: 'follow' });
    if (!Array.isArray(list)) {
      const msg = list && list.message ? list.message : 'unexpected API response';
      throw new Error(`rippling: ${msg} for ${entry.name}`);
    }
    return mapRipplingJobs(list, entry.name);
  },

  // Optional (runs only under --enrich). The list is already complete; the detail
  // exists solely to hand the description prose to enrichers (sponsorship). Keep
  // concurrency low — this is the extra hop most likely to be throttled, and a
  // per-job failure only costs that job's detail, never the posting.
  detailConcurrency: 2,
  async fetchDetail(job, ctx) {
    const ref = detailRefFrom(job.url);
    if (!ref) return null;
    const d = await ctx.fetchJson(
      `${API_BASE}/${encodeURIComponent(ref.slug)}/jobs/${encodeURIComponent(ref.uuid)}`,
      { redirect: 'follow' },
    );
    const desc = d && typeof d.description === 'object' ? d.description : {};
    const text = [desc.role, desc.company].map(stripHtml).filter(Boolean).join(' ');
    return text ? { text } : null;
  },
};
