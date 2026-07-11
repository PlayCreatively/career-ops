// @ts-check
// Shared helpers for normalising optional provider metadata fields.
//
// Files prefixed with _ are never loaded as providers by scan.mjs.

/**
 * Symbol key a provider's fetch() can hang an INLINE detail payload off a Job:
 * `job[DETAIL] = { text }`. It's a Symbol so it never leaks into the JSON
 * snapshot (`{...job}` spread and JSON.stringify both ignore symbol keys) and
 * never collides with a real field. scan.mjs's enrich phase reads it, runs the
 * enrichers over it with ZERO extra requests (the description already came back
 * in the list response), then deletes it. This is the "free tier": ATSes whose
 * list endpoint already carries the description (greenhouse ?content=true, lever
 * descriptionPlain, ashby, recruitee, teamtailor, personio XML) attach it here
 * instead of paying a per-job fetchDetail. See scan.mjs enrichJobs.
 */
export const DETAIL = Symbol('careerops.detail');

/**
 * Hang an inline DetailPayload off a job (free tier — see DETAIL). Defined
 * NON-enumerable so it stays invisible to the JSON snapshot, `{...job}` spread,
 * and `assert.deepStrictEqual` in the parser unit tests, yet `job[DETAIL]` reads
 * it and `delete job[DETAIL]` (scan.mjs, after consuming) removes it. No-op when
 * there's nothing to attach. Returns the job for chaining.
 *
 * @template {object} J
 * @param {J} job
 * @param {{text?: string, overlay?: object, drop?: boolean}} payload
 * @returns {J}
 */
export function attachDetail(job, payload) {
  if (job && payload && (payload.text || payload.overlay || payload.drop)) {
    Object.defineProperty(job, DETAIL, { value: payload, enumerable: false, configurable: true, writable: true });
  }
  return job;
}

/**
 * Decode the handful of HTML entities ATS payloads emit, in ONE pass (so a
 * double-escaped `&amp;nbsp;` decodes to `&nbsp;`, not a space — stripHtml then
 * finishes it). Handles the named set plus numeric (`&#39;` / `&#x2019;`).
 * `&amp;` is decoded LAST so it can't cascade into the others. Used by providers
 * whose "description" field is entity-escaped HTML (greenhouse `content`) before
 * stripHtml removes the tags. Never throws; returns '' for non-strings.
 *
 * @param {unknown} s
 * @returns {string}
 */
export function decodeEntities(s) {
  if (typeof s !== 'string' || !s) return '';
  const cp = (n) => {
    try { return Number.isFinite(n) && n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : ''; }
    catch { return ''; }
  };
  return s
    .replace(/&nbsp;/gi, ' ')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#0*39;|&apos;/gi, "'")
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => cp(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => cp(parseInt(d, 10)))
    .replace(/&amp;/gi, '&');
}

/**
 * Normalise a posting date from the many shapes ATS APIs use — ISO-8601 string
 * (greenhouse `first_published`, ashby `publishedAt`, smartrecruiters
 * `releasedDate`, teamtailor `date_published`), epoch milliseconds (lever
 * `createdAt`), epoch seconds (hitmarker `postDate`), or a loose
 * "YYYY-MM-DD HH:mm:ss UTC" string (recruitee `published_at`) — into a single
 * ISO-8601 string. Returns '' when the input is missing or unparseable, so the
 * caller can spread it conditionally and keep jobs.json lean.
 *
 * @param {unknown} input
 * @returns {string} ISO-8601 (e.g. 2026-01-13T11:37:03.790Z) or ''
 */
export function toIsoDate(input) {
  if (input == null || input === '') return '';
  let d;
  if (typeof input === 'number') {
    if (!Number.isFinite(input)) return '';
    // Epoch heuristic: < 1e12 is seconds (10-digit), else milliseconds (13-digit).
    d = new Date(input < 1e12 ? input * 1000 : input);
  } else if (input instanceof Date) {
    d = input;
  } else if (typeof input === 'string') {
    const s = input.trim();
    if (!s) return '';
    // Some feeds stringify the epoch; treat a bare 10–13 digit run as one.
    if (/^\d{10,13}$/.test(s)) {
      const n = Number(s);
      d = new Date(n < 1e12 ? n * 1000 : n);
    } else {
      d = new Date(s);
    }
  } else {
    return '';
  }
  return Number.isNaN(d.getTime()) ? '' : d.toISOString();
}

/**
 * Slugify a job title the way studios that mirror their ATS board on their own
 * domain do: lowercase, drop punctuation (keep letters/digits/spaces), then
 * collapse whitespace runs to single hyphens. Deliberately does NOT trim leading
 * or trailing hyphens — the observed convention (Supercell) keeps a trailing
 * hyphen when the title has trailing whitespace, and the canonical URL only
 * resolves with the exact slug. Used by job_url_template (see providers/ashby.mjs).
 *
 * Examples (verified against supercell.com, 33/33):
 *   "Head of R&D, Clash Royale"        -> "head-of-rd-clash-royale"
 *   "Product Lead, Project R.I.S.E"    -> "product-lead-project-rise"
 *   "Senior Server Engineer, Tech "    -> "senior-server-engineer-tech-"
 *
 * @param {unknown} title
 * @returns {string}
 */
export function slugifyTitle(title) {
  return String(title == null ? '' : title)
    .toLowerCase()
    .normalize('NFKD').replace(/[̀-ͯ]/g, '') // strip combining accents
    .replace(/[^a-z0-9\s]/g, '')
    .replace(/\s+/g, '-');
}

/**
 * Strip HTML to readable plain text — for detail-phase enrichers that scan a
 * posting's description prose (e.g. sponsorship detection) rather than render it.
 * Drops <script>/<style> bodies wholesale, turns block-ish tags into spaces so
 * words don't fuse across tag boundaries, unescapes the common entities, and
 * collapses whitespace. Best-effort and never throws; returns '' for non-strings.
 *
 * @param {unknown} html
 * @returns {string}
 */
export function stripHtml(html) {
  if (typeof html !== 'string' || !html) return '';
  return html
    .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&quot;/gi, '"')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Normalise an ATS work-arrangement value into one of four tokens:
 * 'remote' | 'hybrid' | 'onsite' | 'anywhere'. Returns '' for anything
 * unrecognised or absent (ATS values like Lever's 'unspecified'), so the field
 * stays a clean enum and callers can spread it conditionally.
 *
 * 'anywhere' is the most permissive mode — geography-free remote ("Anywhere",
 * "Distributed", "Work from anywhere"). It's distinct from 'remote' because most
 * "remote" postings still pin a country/timezone, whereas "anywhere" advertises
 * no location constraint at all.
 *
 * Sources vary: ashby/lever `workplaceType` ('OnSite'|'Hybrid'|'Remote' /
 * lowercase, sometimes 'on-site'); recruitee exposes three booleans instead
 * (handle those at the call site and pass the resolved word here).
 *
 * @param {unknown} raw
 * @returns {('remote'|'hybrid'|'onsite'|'anywhere'|'')}
 */
export function normalizeWorkMode(raw) {
  const s = String(raw == null ? '' : raw).trim().toLowerCase().replace(/[\s_-]+/g, '');
  if (s === 'anywhere' || s === 'any' || s === 'anylocation' || s === 'distributed' || s === 'workfromanywhere') return 'anywhere';
  if (s === 'remote' || s === 'fullyremote') return 'remote';
  if (s === 'hybrid') return 'hybrid';
  if (s === 'onsite' || s === 'inoffice' || s === 'office') return 'onsite';
  return '';
}

// Work-mode tokens an ATS commonly bakes into the location string. Word-bounded
// so "Remoteville" or a hyphenated place won't false-match (and "any" can't fire
// inside "Germany"/"Albany"/"company" — no word boundary before its 'a'). Order
// doesn't matter for resolution (priority below) but DOES for matching: the
// longer alternatives ("anywhere", "any location") precede bare "any" so the
// engine consumes the full phrase, not just the "any" prefix.
// "anywhere"/"any"/"any location"/"distributed" → the geography-free 'anywhere'.
const LOCATION_MODE_RE =
  /\b(?:work[\s-]+from[\s-]+anywhere|anywhere|any[\s-]+locations?|any|distributed|fully[\s-]+remote|remote|hybrid|on[-\s]?site|in[-\s]?office|work[\s-]+from[\s-]+home|wfh)\b/gi;

/**
 * Many postings carry the work arrangement INSIDE the location string —
 * "United States, Remote", "Remote (US)", "New York - Remote", "Hybrid". When
 * the board also shows a work-mode badge, that duplicates. This reads the
 * location text, derives a `workMode` token from it, and strips the token
 * (tidying the punctuation the removal leaves behind) so location stays
 * place-only. Returns the original string untouched when no token is present.
 *
 * Resolution priority when several appear (e.g. "Remote or Hybrid"): anywhere >
 * remote > hybrid > onsite (most permissive wins). The caller decides precedence
 * vs. a structured workMode (we prefer the structured value and use this only to
 * fill/clean).
 *
 * @param {unknown} rawLocation
 * @returns {{ location: string, workMode: ('remote'|'hybrid'|'onsite'|'anywhere'|'') }}
 */
export function splitLocationMode(rawLocation) {
  const input = typeof rawLocation === 'string' ? rawLocation : '';
  if (!input) return { location: '', workMode: '' };

  const found = input.match(LOCATION_MODE_RE);
  if (!found) return { location: input, workMode: '' };

  const lc = found.map((s) => s.toLowerCase());
  let workMode = '';
  if (lc.some((s) => s.includes('anywhere') || s.includes('distributed') || /^any\b/.test(s))) workMode = 'anywhere';
  else if (lc.some((s) => s.includes('remote') || s.includes('home') || s === 'wfh')) workMode = 'remote';
  else if (lc.some((s) => s.includes('hybrid'))) workMode = 'hybrid';
  else if (lc.some((s) => s.includes('site') || s.includes('office'))) workMode = 'onsite';

  // Strip the token(s), then tidy the separators/parens the removal leaves.
  let loc = input.replace(LOCATION_MODE_RE, ' ')
    .replace(/\(\s*\)/g, ' ')                          // empty "()" from "(Remote)"
    .replace(/\(\s*\(/g, '(').replace(/\)\s*\)/g, ')') // collapse "( (" / ") )"
    .replace(/\(\s*\)/g, ' ')
    .replace(/\bor\b\s*(?=[,;)(\]]|$)/gi, ' ')         // dangling "… or" (before ,;)( or end)
    .replace(/(^|[,;])\s*\bor\b\s*/gi, '$1 ')          // leading "or …"
    .replace(/(^|\s)[-–—/|](\s|$)/g, ' ')              // stray separators
    .replace(/\s+([,;])/g, '$1')                       // space before , or ;
    .replace(/([,;])\s*(?=[,;]|$)/g, ' ')              // doubled / trailing , ;
    .replace(/\s{2,}/g, ' ')
    .replace(/^[\s,;/|–—-]+/, '')                      // leading junk
    .replace(/[\s,;/|–—-]+$/, '')                      // trailing junk
    .trim();
  // If the whole remainder is a single parenthetical region, unwrap it.
  const wrapped = loc.match(/^\((.+)\)$/);
  if (wrapped) loc = wrapped[1].trim();

  return { location: loc, workMode };
}
