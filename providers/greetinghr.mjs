// @ts-check
/** @typedef {import('./_types.js').Provider} Provider */

import { toIsoDate } from './_util.mjs';

// Greeting (그리팅) provider — the Korean multi-tenant ATS (greetinghr.com,
// built by Doodlin) behind a wave of Pangyo/Seoul game studios: Aimed,
// MadNgine (Night Crow), BigFire Games, AButton and many more. Each tenant has
// a public board at https://<slug>.career.greetinghr.com (a Next.js app; some
// studios front it with their own domain, e.g. careers.abutton.com).
//
// The board server-renders the full openings list into the page's
// `__NEXT_DATA__` react-query cache under the query key ["openings"], so we do
// ONE GET of the board origin (it 301s to the tenant's canonical landing page —
// /ko/home, /ko/recruit, /ko/intro, … — which is irrelevant: the openings query
// is hydrated on every page) and read the list straight out of the embedded
// JSON. Zero-token, no per-job request, no API token to scrape.
//
// We deliberately do NOT call the api.greetinghr.com backend: the openings list
// is fetched server-side (it isn't a public client route — the obvious guesses
// 404 / "no static resource"), whereas the hydrated __NEXT_DATA__ is stable and
// locale-independent. Auto-detects from a careers_url on *.career.greetinghr.com.

// <slug>.career.greetinghr.com — slug is the tenant id (e.g. `aimed`).
const GREETING_RE = /([a-z0-9-]+)\.career\.greetinghr\.com/i;

// Generic non-postings tenants pin to the board: "talent pools" (상시 인재풀)
// and referral-program promos (사외 추천 제도). They carry no real vacancy — and
// crucially the `fixed` flag can't tell them apart (studios pin real jobs too),
// so we match the title instead.
const NON_JOB_RE = /인재\s*풀|talent\s*pool|추천\s*제도|사외\s*추천|임직원\s*추천|referral/i;

function resolveTenant(entry) {
  const raw = typeof entry.careers_url === 'string' ? entry.careers_url : '';
  const m = raw.match(GREETING_RE);
  if (!m) return null;
  const slug = m[1];
  return {
    slug,
    // Bare origin; the server redirects to whatever page the tenant configured.
    pageUrl: `https://${slug}.career.greetinghr.com/`,
    jobUrl: (id) => `https://${slug}.career.greetinghr.com/o/${encodeURIComponent(id)}`,
  };
}

function extractNextData(html) {
  const m = String(html).match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
  if (!m) return null;
  try {
    return JSON.parse(m[1]);
  } catch {
    return null;
  }
}

/**
 * Map Greeting's hydrated openings list into the scanner's job shape. Exported
 * for unit tests. Each record carries `openingId`, `title`, `deploy` (published
 * flag), `openDate`, and a nested `openingJobPosition.openingJobPositions[]`
 * whose first entry holds the occupation (department) and `workspacePlace`
 * (a Korean street address + a `workFromHome` flag). Records that are unpublished,
 * untitled, duplicated, or generic non-postings (talent pool / referral) are skipped.
 *
 * Greeting tenants are Korea-based and render locations as Korean street
 * addresses (e.g. "경기도 성남시 분당구…"), which won't match an English "Korea"
 * location filter, so we append ", South Korea" to non-remote places — mirroring
 * the HRMOS provider's ", Japan" handling.
 *
 * @param {Array<object>} openings
 * @param {string} companyName
 * @param {(id: string|number) => string} jobUrl
 * @returns {Array<{title: string, url: string, company: string, location: string, postedDate?: string, workMode?: string, department?: string}>}
 */
export function mapGreetingOpenings(openings, companyName, jobUrl) {
  if (!Array.isArray(openings)) return [];
  const out = [];
  const seen = new Set();
  for (const rec of openings) {
    if (!rec || typeof rec !== 'object') continue;
    if (rec.deploy === false) continue;
    const title = typeof rec.title === 'string' ? rec.title.trim() : '';
    if (!title || NON_JOB_RE.test(title)) continue;
    const id = rec.openingId;
    if (id == null) continue;
    if (seen.has(id)) continue;
    seen.add(id);

    const pos =
      (rec.openingJobPosition &&
        Array.isArray(rec.openingJobPosition.openingJobPositions) &&
        rec.openingJobPosition.openingJobPositions[0]) ||
      {};
    const place = pos.workspacePlace && typeof pos.workspacePlace === 'object' ? pos.workspacePlace : {};
    // Prefer the street address; fall back to the office's display name.
    const addr =
      typeof place.place === 'string' && place.place.trim()
        ? place.place.trim()
        : typeof place.location === 'string'
        ? place.location.trim()
        : '';
    const wfh = place.workFromHome === true;
    let location = addr;
    if (location && !/korea/i.test(location)) location = `${location}, South Korea`;
    const workMode = wfh ? 'remote' : addr ? 'onsite' : '';
    const department =
      typeof pos.workspaceOccupation?.occupation === 'string' ? pos.workspaceOccupation.occupation.trim() : '';
    // Greeting exposes openDate (often null) — the only freshness signal.
    const postedDate = toIsoDate(rec.openDate);

    out.push({
      title,
      url: jobUrl(id),
      company: companyName,
      location,
      ...(postedDate ? { postedDate } : {}),
      ...(workMode ? { workMode } : {}),
      ...(department ? { department } : {}),
    });
  }
  return out;
}

/** @type {Provider} */
export default {
  id: 'greetinghr',

  detect(entry) {
    const t = resolveTenant(entry);
    return t ? { url: t.pageUrl } : null;
  },

  async fetch(entry, ctx) {
    const t = resolveTenant(entry);
    if (!t) throw new Error(`greetinghr: cannot derive tenant from careers_url for ${entry.name}`);

    const html = await ctx.fetchText(t.pageUrl, { redirect: 'follow' });
    const nd = extractNextData(html);
    if (!nd) throw new Error(`greetinghr: no __NEXT_DATA__ on board page for ${entry.name} (${t.pageUrl})`);

    const queries = nd?.props?.pageProps?.dehydratedState?.queries;
    if (!Array.isArray(queries)) throw new Error(`greetinghr: unexpected page shape for ${entry.name}`);
    const op = queries.find((q) => JSON.stringify(q.queryKey) === '["openings"]');
    const openings = op?.state?.data;
    if (!Array.isArray(openings)) throw new Error(`greetinghr: openings list not hydrated for ${entry.name}`);

    return mapGreetingOpenings(openings, entry.name, t.jobUrl);
  },
};
