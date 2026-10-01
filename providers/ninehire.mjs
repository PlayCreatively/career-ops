// @ts-check
/** @typedef {import('./_types.js').Provider} Provider */

import { toIsoDate } from './_util.mjs';

// Ninehire (나인하이어) provider — a Korean multi-tenant ATS. MadNgine (Night Crow)
// moved here from Greeting in mid-2026. Every tenant gets a hosted board at
// https://<site>.ninehire.site, often fronted by the studio's own domain
// (MadNgine: recruit.madngine.com → madngine.ninehire.site).
//
// The board is a Next.js app whose openings list loads client-side from a
// public, keyless JSON API on a fixed host:
//
//   GET https://api.ninehire.com/identity-access/homepage/information?siteUrl=<site>
//       → { companyId, companyName, ... }
//   GET https://api.ninehire.com/identity-access/homepage/recruitments
//         ?companyId=<uuid>&page=<n>&countPerPage=<k>
//       → { count, results: [{ recruitmentId, addressKey, externalTitle, status,
//                               isPrivate, jobLocations[], jobGroup, createdAt, ... }] }
//
// Both calls are pinned to api.ninehire.com; the careers_url only selects the
// <site> slug, never the host (SSRF-safe). Configure with the hosted board URL:
//
//   - name: MadNgine
//     provider: ninehire
//     careers_url: https://madngine.ninehire.site
//
// Job URLs are <board>/job_posting/<addressKey>; they resolve on the hosted
// *.ninehire.site origin as well as on the studio's custom domain.

const API = 'https://api.ninehire.com/identity-access/homepage';
const PAGE_SIZE = 100;
const MAX_PAGES = 20;

// Talent-pool / referral pins carry no real vacancy (same convention as the
// Greeting provider — Korean boards pin these alongside real openings).
const NON_JOB_RE = /인재\s*풀|talent\s*pool|추천\s*제도|사외\s*추천|임직원\s*추천|referral/i;

/**
 * Resolve the tenant's site slug from careers_url (https://<site>.ninehire.site).
 * Exported for unit tests.
 *
 * @param {{careers_url?: string}} entry
 * @returns {{site: string, origin: string} | null}
 */
export function resolveNinehire(entry) {
  const raw = typeof entry?.careers_url === 'string' ? entry.careers_url.trim() : '';
  if (!raw) return null;
  let u;
  try { u = new URL(raw); } catch { return null; }
  if (u.protocol !== 'https:') return null;
  const m = u.hostname.toLowerCase().match(/^([a-z0-9-]+)\.ninehire\.site$/);
  if (!m) return null;
  return { site: m[1], origin: `https://${m[1]}.ninehire.site` };
}

/**
 * Map Ninehire recruitment records into the scanner's job shape. Exported for
 * unit tests. Skips private, non-running, untitled, duplicate, and talent-pool
 * records. Locations are Korean street addresses ("대한민국 경기도 성남시 …"), so
 * ", South Korea" is appended to make an English country filter match —
 * mirroring the Greeting/HRMOS handling.
 *
 * @param {Array<object>} results
 * @param {string} companyName
 * @param {string} origin  Board origin used to build job URLs.
 * @returns {Array<{title: string, url: string, company: string, location: string, postedDate?: string, department?: string}>}
 */
export function mapNinehireRecruitments(results, companyName, origin) {
  if (!Array.isArray(results)) return [];
  const out = [];
  const seen = new Set();
  for (const rec of results) {
    if (!rec || typeof rec !== 'object') continue;
    if (rec.isPrivate === true) continue;
    if (rec.status && rec.status !== 'in_progress') continue;
    const title = String(rec.externalTitle || rec.title || '').trim();
    if (!title || NON_JOB_RE.test(title)) continue;
    const key = typeof rec.addressKey === 'string' ? rec.addressKey.trim() : '';
    if (!key || seen.has(key)) continue;
    seen.add(key);

    const loc0 = Array.isArray(rec.jobLocations) ? rec.jobLocations[0] : null;
    let location = typeof loc0?.addressName === 'string' ? loc0.addressName.trim() : '';
    if (location && !/korea/i.test(location)) location = `${location}, South Korea`;
    const department = typeof rec.jobGroup?.title === 'string' ? rec.jobGroup.title.trim() : '';
    const postedDate = toIsoDate(rec.createdAt);

    out.push({
      title,
      url: `${origin}/job_posting/${encodeURIComponent(key)}`,
      company: companyName,
      location,
      ...(postedDate ? { postedDate } : {}),
      ...(department ? { department } : {}),
    });
  }
  return out;
}

/** @type {Provider} */
export default {
  id: 'ninehire',

  detect(entry) {
    const t = resolveNinehire(entry);
    return t ? { url: t.origin } : null;
  },

  // url→identity for the rehm miner: <site>.ninehire.site/job_posting/<key> → site.
  mineUrl(jobUrl) {
    const t = resolveNinehire({ careers_url: jobUrl });
    return t ? { slug: t.site, careers_url: t.origin } : null;
  },

  async fetch(entry, ctx) {
    const t = resolveNinehire(entry);
    if (!t) throw new Error(`ninehire: careers_url must be https://<site>.ninehire.site for ${entry.name}`);

    const info = /** @type {any} */ (await ctx.fetchJson(`${API}/information?siteUrl=${encodeURIComponent(t.site)}`));
    const companyId = info?.companyId;
    if (typeof companyId !== 'string' || !companyId) {
      throw new Error(`ninehire: no companyId for site "${t.site}" (${entry.name})`);
    }

    const all = [];
    for (let page = 1; page <= MAX_PAGES; page++) {
      const q = `companyId=${encodeURIComponent(companyId)}&page=${page}&countPerPage=${PAGE_SIZE}`;
      const res = /** @type {any} */ (await ctx.fetchJson(`${API}/recruitments?${q}`));
      const batch = Array.isArray(res?.results) ? res.results : null;
      if (!batch) throw new Error(`ninehire: unexpected recruitments shape for ${entry.name}`);
      all.push(...batch);
      if (batch.length < PAGE_SIZE || all.length >= (Number(res.count) || 0)) break;
    }
    return mapNinehireRecruitments(all, entry.name, t.origin);
  },
};
