// @ts-check
/** @typedef {import('./_types.js').Provider} Provider */

// Zoho Recruit provider — Zoho Recruit is a multi-tenant ATS whose hosted career
// site lives at {origin}/jobs/Careers. Tenants run EITHER on a shared subdomain
// ({slug}.zohorecruit.com, e.g. puzzle / spatial) OR on a fully white-labelled
// custom domain (careers.playsimple.in, jobs.bkom.com). There is therefore no
// single host suffix to allowlist, so — like the Avature provider — this one
// derives every endpoint from the entry's OWN careers_url origin and never
// leaves it (same-origin is the security boundary, enforced below).
//
// Surface: the career site server-renders the ENTIRE open-jobs list as one
// HTML-entity-encoded JSON array inside a hidden input:
//   <input type="hidden" id="jobs" value="[{&quot;Posting_Title&quot;:…}]">
// No XHR, no pagination — decode the entities, JSON.parse, done. Each job object
// carries Posting_Title / Job_Opening_Name, a numeric `id` (the apply URL is
// {origin}/jobs/Careers/{id}), City, Country, and Remote_Job (boolean). There is
// no per-job posted date in the island, so jobs from this provider have no
// postedDate. The island has no company field either — one tenant == one studio,
// so company is taken from the entry name (same as Avature).
//
// Routing: custom-domain tenants can't be auto-derived from the host, so pin the
// studio with explicit `provider: zohorecruit` (careers_url = the careers
// origin, e.g. https://jobs.bkom.com). As a convenience, any *.zohorecruit.com
// host, or a careers_url whose path already points at /jobs/Careers, is
// auto-detected.

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

// Decode the HTML entities Zoho emits inside the JSON island (it entity-encodes
// every quote as &#34; / &quot; plus the usual &amp; etc.). Numeric refs are
// resolved generically.
function decodeEntities(s) {
  return String(s == null ? '' : s)
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => safeCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => safeCodePoint(parseInt(d, 10)))
    .replace(/&([a-zA-Z]+);/g, (m, name) => (name in ENTITIES ? ENTITIES[name] : m));
}

function safeCodePoint(n) {
  if (!Number.isFinite(n) || n < 0 || n > 0x10ffff) return '';
  try {
    return String.fromCodePoint(n);
  } catch {
    return '';
  }
}

function clean(s) {
  return decodeEntities(s).replace(/\s+/g, ' ').trim();
}

// Resolve {origin, host} from a portal entry. Returns null when the careers_url
// is missing or not an https URL.
export function resolveZoho(entry) {
  let url;
  try {
    url = new URL(entry && entry.careers_url ? entry.careers_url : '');
  } catch {
    return null;
  }
  if (url.protocol !== 'https:') return null;
  return { origin: url.origin, host: url.hostname.toLowerCase() };
}

const careersUrl = (origin) => `${origin}/jobs/Careers`;

// Build a tenant-relative location string from the City/Country fields. Either
// may be missing/null (e.g. remote-only roles carry no City) — join the present
// ones with ", ".
function zohoLocation(job) {
  return [job && job.City, job && job.Country]
    .map((v) => (typeof v === 'string' ? v.trim() : ''))
    .filter(Boolean)
    .join(', ');
}

/**
 * Parse a Zoho Recruit career-site page into job rows. Exported for unit tests.
 * Extracts the `<input id="jobs" value="…">` JSON island, decodes the HTML
 * entities, JSON.parses it, and maps each posting. Job URLs are built on the
 * tenant origin ({origin}/jobs/Careers/{id}) — never fetched cross-origin.
 *
 * @param {string} html
 * @param {string} companyName — value written into job.company
 * @param {string} origin — the entry's careers origin (e.g. https://jobs.bkom.com)
 * @returns {Array<{title: string, url: string, company: string, location: string, workMode?: string}>}
 */
export function parseZohoHtml(html, companyName, origin) {
  if (typeof html !== 'string' || !html) return [];
  const tag = html.match(/<input[^>]*\bid="jobs"[^>]*>/i);
  if (!tag) return [];
  const valMatch = tag[0].match(/\bvalue="([^"]*)"/i);
  if (!valMatch) return [];
  let arr;
  try {
    arr = JSON.parse(decodeEntities(valMatch[1]));
  } catch {
    return [];
  }
  if (!Array.isArray(arr)) return [];

  const jobs = [];
  const seen = new Set();
  for (const job of arr) {
    if (!job || typeof job !== 'object') continue;
    // Only postings actually published to the career site.
    if (job.Publish === false) continue;
    const id = job.id != null ? String(job.id).trim() : '';
    if (!id || !/^[A-Za-z0-9]+$/.test(id)) continue; // numeric Zoho record id
    if (seen.has(id)) continue;
    seen.add(id);
    const title = clean(job.Posting_Title || job.Job_Opening_Name || '');
    if (!title) continue;
    const url = `${origin}/jobs/Careers/${id}`;
    const location = clean(zohoLocation(job));
    const workMode = job.Remote_Job === true ? 'remote' : '';
    jobs.push({
      title,
      url,
      company: companyName || '',
      location,
      ...(workMode ? { workMode } : {}),
    });
  }
  return jobs;
}

/** @type {Provider} */
export default {
  id: 'zohorecruit',

  detect(entry) {
    let url;
    try {
      url = new URL(entry && entry.careers_url ? entry.careers_url : '');
    } catch {
      return null;
    }
    if (url.protocol !== 'https:') return null;
    const host = url.hostname.toLowerCase();
    // Auto-claim shared-host tenants and any careers_url already pointing at the
    // hosted career site; bare custom-domain origins need explicit
    // `provider: zohorecruit`.
    if (host === 'zohorecruit.com' || host.endsWith('.zohorecruit.com') || /\/jobs\/Careers\b/i.test(url.pathname)) {
      const resolved = resolveZoho(entry);
      return resolved ? { url: careersUrl(resolved.origin) } : null;
    }
    return null;
  },

  async fetch(entry, ctx) {
    const resolved = resolveZoho(entry);
    if (!resolved) throw new Error(`zohorecruit: cannot resolve careers origin for ${entry && entry.name} — set an https careers_url`);
    const { origin } = resolved;
    // redirect:'error' keeps the final host inside the tenant origin.
    const html = await ctx.fetchText(careersUrl(origin), { redirect: 'error' });
    return parseZohoHtml(html, entry.name, origin);
  },
};
