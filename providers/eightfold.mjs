// @ts-check
/** @typedef {import('./_types.js').Provider} Provider */

import { toIsoDate, normalizeWorkMode } from './_util.mjs';

// Eightfold provider — the multi-tenant "Talent Intelligence" ATS (eightfold.ai,
// branded PCSX = Personalized Career Site Experience) behind Netflix's games
// studio, Hasbro and many large enterprises. Each tenant exposes a public JSON
// search endpoint on its own careersite host:
//
//   https://<host>/api/apply/v2/jobs?domain=<domain>&start=<n>&num=<k>
//
// where <host> is the careersite (e.g. explore.jobs.netflix.net) and <domain> is
// the tenant key (e.g. netflix.com). The response carries `count` (total hits)
// and a `positions[]` array (name / location / department / business_unit /
// t_create / t_update / work_location_option / canonicalPositionUrl). Zero-token,
// no per-job request — we page through with start/num until we've seen `count`.
//
// The <domain> key isn't derivable from the host, but every careersite embeds it
// verbatim as `"domain": "<domain>"`, so if a studio doesn't pin `eightfold_domain`
// we scrape it off the /careers page (one extra GET, self-heals if it changes).
//
// Enterprise tenants (Netflix) list their WHOLE company, so a bare fetch would
// drag in hundreds of non-game roles. eightfold filters server-side on the
// "Teams" facet, so a studio can pin `teams: [...]` to pull ONLY its games orgs
// (e.g. "Netflix Games Studio"). With no `teams:` we fetch everything and lean on
// the scanner's title_filter. Some tenants (Hasbro) disable the public PCSX API
// ("Not authorized for PCSX") — those simply aren't wireable here.
//
// Wired explicitly via `provider: eightfold` (custom careersite domains can't be
// host-auto-detected); detect() also recognises bare *.eightfold.ai hosts.

const PAGE_SIZE = 100;
const MAX_PAGES = 30; // safety cap: 3000 jobs/team — far past any real board
const DOMAIN_RE = /"domain"\s*:\s*"([^"]+)"/;

function hostOf(url) {
  try {
    return new URL(url).host;
  } catch {
    return '';
  }
}

function resolveTenant(entry) {
  const raw = typeof entry.careers_url === 'string' ? entry.careers_url : '';
  const host = hostOf(raw);
  if (!host) return null;
  // Prefer the configured careers page for the domain scrape; else the canonical
  // /careers landing on the same host.
  const careersPageUrl = /\/careers(\/|$|\?)/.test(raw) ? raw : `https://${host}/careers`;
  return {
    host,
    careersPageUrl,
    apiUrl: ({ domain, team, start }) => {
      const p = new URLSearchParams({
        domain,
        start: String(start),
        num: String(PAGE_SIZE),
        sort_by: 'relevance',
      });
      if (team) p.set('Teams', team);
      return `https://${host}/api/apply/v2/jobs?${p.toString()}`;
    },
  };
}

/** Normalize a studio's `teams` config into a list of facet values (or [null] = no filter). */
function teamsOf(entry) {
  const t = entry.teams;
  if (Array.isArray(t)) {
    const list = t.map((x) => String(x).trim()).filter(Boolean);
    return list.length ? list : [null];
  }
  if (typeof t === 'string' && t.trim()) return [t.trim()];
  return [null];
}

/**
 * Map eightfold's positions list into the scanner's job shape. Exported for unit
 * tests. Dedups across team queries by canonical URL (falling back to id), since
 * a role can sit under more than one team and eightfold also repeats rows across
 * locales. Records missing a title or URL are skipped.
 *
 * @param {Array<object>} positions
 * @param {string} companyName
 * @param {Set<string>} [seen] shared dedup set across paged/team calls
 * @returns {Array<{title: string, url: string, company: string, location: string, postedDate?: string, workMode?: string, department?: string}>}
 */
export function mapEightfoldPositions(positions, companyName, seen = new Set()) {
  if (!Array.isArray(positions)) return [];
  const out = [];
  for (const rec of positions) {
    if (!rec || typeof rec !== 'object') continue;
    const title = typeof rec.name === 'string' ? rec.name.trim() : '';
    const url = rec.canonicalPositionUrl || rec.positionUrl || '';
    if (!title || !url) continue;
    const key = String(url || rec.id);
    if (seen.has(key)) continue;
    seen.add(key);

    const location = typeof rec.location === 'string' ? rec.location.trim() : '';
    const workMode = normalizeWorkMode(rec.work_location_option || rec.location_flexibility || '');
    // t_update is the freshest signal; t_create is the original post date.
    const postedDate = toIsoDate(rec.t_create || rec.t_update);
    const department =
      (typeof rec.department === 'string' && rec.department.trim()) ||
      (typeof rec.business_unit === 'string' && rec.business_unit.trim()) ||
      '';

    out.push({
      title,
      url,
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
  id: 'eightfold',

  detect(entry) {
    const host = hostOf(typeof entry.careers_url === 'string' ? entry.careers_url : '');
    // Only auto-claim the unambiguous *.eightfold.ai hosts; custom-domain tenants
    // (Netflix, Hasbro) must opt in with `provider: eightfold`.
    if (!/(^|\.)eightfold\.ai$/i.test(host)) return null;
    const t = resolveTenant(entry);
    return t ? { url: t.careersPageUrl } : null;
  },

  async fetch(entry, ctx) {
    const t = resolveTenant(entry);
    if (!t) throw new Error(`eightfold: cannot derive host from careers_url for ${entry.name}`);

    let domain = typeof entry.eightfold_domain === 'string' ? entry.eightfold_domain.trim() : '';
    if (!domain) {
      const html = await ctx.fetchText(t.careersPageUrl, { redirect: 'follow' });
      // The careersite embeds its config JSON HTML-entity-encoded (`&#34;` / `&quot;`),
      // so decode the quote entities before matching the "domain" key.
      const decoded = html.replace(/&#34;|&quot;/g, '"');
      const m = decoded.match(DOMAIN_RE);
      if (!m) {
        throw new Error(
          `eightfold: no "domain" config on careers page for ${entry.name} (${t.careersPageUrl}); pin eightfold_domain`
        );
      }
      domain = m[1];
    }

    const seen = new Set();
    const out = [];
    for (const team of teamsOf(entry)) {
      let start = 0;
      for (let page = 0; page < MAX_PAGES; page++) {
        const data = await ctx.fetchJson(t.apiUrl({ domain, team, start }), { redirect: 'follow' });
        if (!data || typeof data !== 'object' || !Array.isArray(data.positions)) {
          const msg = data && data.message ? data.message : 'unexpected API response';
          throw new Error(`eightfold: ${msg} for ${entry.name} (domain=${domain})`);
        }
        out.push(...mapEightfoldPositions(data.positions, entry.name, seen));
        start += data.positions.length;
        const count = Number(data.count) || 0;
        if (data.positions.length === 0 || start >= count) break;
      }
    }
    return out;
  },
};
