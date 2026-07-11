// @ts-check
// IGDB studio-context client — resolves a game studio's logo, founding year,
// country, official website and game catalogue in one place, so you don't have
// to google every company the board surfaces.
//
// IGDB is Twitch/Amazon's game database. It needs a free one-time Twitch dev
// signup for a client id + secret (client-credentials OAuth). See .env.example.
//
// This module is the ONLY place that knows IGDB's shape (apicalypse queries,
// image URLs, ISO country codes) — callers get back a plain normalized studio
// object or null. Same single-source rule the ATS providers follow.
//
// Every lookup is cached to data/studio-cache.json, misses included, so re-runs
// are free and IGDB's rate limit (4 req/s) is only ever paid once per studio.

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

const TOKEN_URL = 'https://id.twitch.tv/oauth2/token';
const API = 'https://api.igdb.com/v4';
const CACHE_PATH = fileURLToPath(new URL('../data/studio-cache.json', import.meta.url));

const DESC_CAP = 240;   // hard cap on the blurb we keep — a card subtitle, not the wiki
const MAX_GAMES = 10;   // catalogue chips stored/shown per studio (only these are kept)
const GAME_FETCH = 40;  // top-by-popularity games pulled per studio before filtering to MAX_GAMES

// IGDB `country` is an ISO 3166-1 numeric-3 code. We map the countries a game
// studio is realistically based in; anything unmapped just drops the field.
const COUNTRY = {
  36: 'Australia', 40: 'Austria', 56: 'Belgium', 76: 'Brazil', 124: 'Canada',
  156: 'China', 191: 'Croatia', 203: 'Czechia', 208: 'Denmark', 233: 'Estonia',
  246: 'Finland', 250: 'France', 276: 'Germany', 300: 'Greece', 344: 'Hong Kong',
  348: 'Hungary', 352: 'Iceland', 356: 'India', 372: 'Ireland', 376: 'Israel',
  380: 'Italy', 392: 'Japan', 410: 'South Korea', 428: 'Latvia', 440: 'Lithuania',
  442: 'Luxembourg', 458: 'Malaysia', 484: 'Mexico', 528: 'Netherlands',
  554: 'New Zealand', 578: 'Norway', 616: 'Poland', 620: 'Portugal', 642: 'Romania',
  643: 'Russia', 688: 'Serbia', 702: 'Singapore', 703: 'Slovakia', 705: 'Slovenia',
  710: 'South Africa', 724: 'Spain', 752: 'Sweden', 756: 'Switzerland', 158: 'Taiwan',
  764: 'Thailand', 792: 'Turkey', 804: 'Ukraine', 784: 'UAE', 826: 'United Kingdom',
  840: 'United States', 704: 'Vietnam',
};

// Free-text job location → one of the COUNTRY names above. A studio's dominant
// posting country is our best disambiguator when IGDB has several companies
// sharing a name: the namesake in the wrong country loses the scoring below.
// Built once from the country names plus common aliases and the game-hub cities
// that show up in postings *without* a country token ("Seoul", "Vancouver").
const LOC_ALIAS = (() => {
  const m = new Map();
  for (const name of new Set(Object.values(COUNTRY))) m.set(name.toLowerCase(), name);
  const add = (name, ...aliases) => { for (const a of aliases) m.set(a, name); };
  add('United States', 'usa', 'us', 'u.s.', 'u.s.a.', 'united states of america', 'america');
  add('United Kingdom', 'uk', 'u.k.', 'england', 'scotland', 'wales', 'northern ireland', 'britain', 'great britain');
  add('South Korea', 'korea', 'republic of korea');
  add('Czechia', 'czech republic', 'czech');
  add('UAE', 'united arab emirates', 'emirates');
  add('Russia', 'russian federation');
  add('Netherlands', 'the netherlands', 'holland');
  add('Vietnam', 'viet nam');
  // Bare-city → country (game hubs that appear without a country token).
  add('United States', 'new york', 'los angeles', 'san francisco', 'seattle', 'austin', 'boston', 'chicago', 'san jose', 'santa clara', 'san mateo', 'irvine', 'redmond', 'bellevue', 'san diego', 'atlanta', 'raleigh', 'salt lake city');
  add('Canada', 'vancouver', 'montreal', 'montréal', 'toronto', 'edmonton', 'quebec', 'québec', 'ottawa', 'calgary');
  add('United Kingdom', 'london', 'manchester', 'guildford', 'brighton', 'leamington', 'cambridge', 'oxford', 'edinburgh', 'dundee', 'sheffield', 'liverpool', 'leeds', 'newcastle', 'nottingham');
  add('Japan', 'tokyo', 'osaka', 'kyoto', 'yokohama', 'fukuoka');
  add('China', 'shanghai', 'beijing', 'shenzhen', 'guangzhou', 'chengdu', 'hangzhou');
  add('France', 'paris', 'lyon', 'bordeaux', 'montpellier', 'toulouse', 'lille', 'nantes');
  add('Germany', 'berlin', 'munich', 'münchen', 'hamburg', 'frankfurt', 'cologne', 'köln', 'hanover', 'hannover');
  add('Sweden', 'stockholm', 'malmö', 'malmo', 'gothenburg', 'göteborg', 'skövde', 'skovde', 'umeå', 'umea');
  add('Finland', 'helsinki', 'tampere', 'espoo', 'oulu');
  add('Poland', 'warsaw', 'warszawa', 'krakow', 'kraków', 'wroclaw', 'wrocław', 'poznań', 'poznan');
  add('Spain', 'madrid', 'barcelona', 'valencia', 'sevilla', 'seville');
  add('South Korea', 'seoul', 'pangyo', 'seongnam');
  add('Australia', 'sydney', 'melbourne', 'brisbane', 'adelaide', 'perth');
  add('Netherlands', 'amsterdam', 'utrecht', 'rotterdam', 'eindhoven', 'hilversum');
  add('Israel', 'tel aviv', 'tel-aviv', 'haifa', 'jerusalem', 'migdal ha‘emeq', 'migdal haemeq');
  add('India', 'bengaluru', 'bangalore', 'mumbai', 'pune', 'hyderabad', 'gurgaon', 'gurugram', 'delhi', 'new delhi');
  add('Ireland', 'dublin', 'cork', 'galway');
  add('Denmark', 'copenhagen', 'københavn', 'aarhus');
  add('Norway', 'oslo', 'bergen');
  add('Turkey', 'istanbul', 'ankara', 'izmir');
  add('Brazil', 'sao paulo', 'são paulo', 'rio de janeiro');
  add('Taiwan', 'taipei', 'hsinchu');
  add('Switzerland', 'zurich', 'zürich', 'geneva', 'lausanne');
  add('Singapore', 'singapore');
  return m;
})();

// Resolve a country name from a free-text location, or null. The country token
// is usually the last comma-separated part ("Vancouver, Canada"), so we scan
// right-to-left; then fall back to any alias appearing as a whole word.
export function countryOfLocation(loc) {
  if (!loc) return null;
  const parts = String(loc).toLowerCase().replace(/[^\p{L}\p{N}\s.,'`’-]/gu, ' ')
    .split(',').map((p) => p.replace(/\s+/g, ' ').trim()).filter(Boolean);
  for (let i = parts.length - 1; i >= 0; i--) {
    if (LOC_ALIAS.has(parts[i])) return LOC_ALIAS.get(parts[i]);
  }
  const whole = ' ' + parts.join(' ') + ' ';
  for (const [alias, name] of LOC_ALIAS) {
    if (whole.includes(' ' + alias + ' ')) return name;
  }
  return null;
}

let _cache = null; // lazily loaded { _token?, [nameKey]: studio|null }

function keyOf(name) {
  return String(name || '').toLowerCase().replace(/\s+/g, ' ').trim();
}

// The studio's own handle inside its ATS careers URL — a config-free identity
// signal that beats an ambiguous display name. Job boards drop suffixes ("Amber"
// for "Amber Studio"), which then collides with an unrelated IGDB namesake; but
// the ATS URL carries the studio's self-chosen slug ("amberstudiocareers",
// "turtlerockstudios", "cinnamonsoftware.teamtailor.com") which keeps the suffix.
// We normalize it to a bare alphanumeric string and, in scoring, prefer the
// candidate whose own name is embedded in it (see slugKeyOf + bestMatch).
//
// The slug lives in the subdomain (cinnamonsoftware.teamtailor.com) for some ATSes
// and the first path segment (jobvite.com/amberstudiocareers) for others; generic
// hosting labels ("jobs", "careers", "job-boards", country/lang codes) are skipped.
const SLUG_GENERIC = new Set([
  'www', 'jobs', 'job', 'careers', 'career', 'apply', 'boards', 'job-boards',
  'recruiting', 'recruitment', 'hire', 'hiring', 'talent', 'join', 'work', 'app',
  'en', 'us', 'uk', 'en-us', 'en_us', 'global', 'home', 'company', 'about',
]);
export function studioSlug(companyUrl) {
  if (!companyUrl) return null;
  let u;
  try { u = new URL(companyUrl); } catch { return null; }
  const labels = u.hostname.toLowerCase().split('.');
  // Distinctive subdomain (more than host+TLD, first label not generic hosting).
  if (labels.length > 2 && !SLUG_GENERIC.has(labels[0])) return labels[0];
  // Else the first meaningful path segment.
  const seg = u.pathname.split('/').map((s) => s.trim()).filter(Boolean)
    .find((s) => !SLUG_GENERIC.has(s.toLowerCase()));
  return seg || null;
}
// Bare alphanumerics, lowercased — the form we substring-test candidate names in.
function slugKeyOf(companyUrl) {
  const s = studioSlug(companyUrl);
  return s ? s.toLowerCase().replace(/[^a-z0-9]/g, '') : null;
}

async function loadCache() {
  if (_cache) return _cache;
  try {
    _cache = JSON.parse(await readFile(CACHE_PATH, 'utf8'));
  } catch {
    _cache = {};
  }
  return _cache;
}

async function saveCache() {
  if (!_cache) return;
  await mkdir(dirname(CACHE_PATH), { recursive: true }).catch(() => {});
  await writeFile(CACHE_PATH, JSON.stringify(_cache, null, 0));
}

// ── Auth ─────────────────────────────────────────────────────────────────────
// Client-credentials token, cached in the same file (Twitch tokens last ~60d).
async function getToken() {
  const cache = await loadCache();
  const now = Date.now();
  if (cache._token && cache._token.expires_at > now + 60_000) return cache._token.access_token;

  const id = process.env.IGDB_CLIENT_ID;
  const secret = process.env.IGDB_CLIENT_SECRET;
  if (!id || !secret) {
    throw new Error(
      'IGDB credentials missing. Set IGDB_CLIENT_ID and IGDB_CLIENT_SECRET in .env ' +
      '(free Twitch dev signup — see .env.example).',
    );
  }
  const body = new URLSearchParams({ client_id: id, client_secret: secret, grant_type: 'client_credentials' });
  const r = await fetch(`${TOKEN_URL}?${body}`, { method: 'POST' });
  if (!r.ok) throw new Error(`IGDB token request failed (${r.status}): ${await r.text()}`);
  const j = await r.json();
  cache._token = { access_token: j.access_token, expires_at: now + (j.expires_in || 5_000_000) * 1000 };
  await saveCache();
  return j.access_token;
}

// ── Query ────────────────────────────────────────────────────────────────────
// IGDB's hard limit is 4 requests/second. A lookup can fire two requests (exact
// then contains), and callers run several in parallel, so we can't rely on
// concurrency to stay under — instead every request passes through one global
// gate that spaces request *starts* ≥ MIN_INTERVAL apart (≈3.5/s), whatever the
// concurrency. This is what keeps a full-board enrich from tripping 429s.
const MIN_INTERVAL = 285; // ms between request starts → ~3.5 req/s, safely under 4
let _nextSlot = 0;
async function rateGate() {
  const now = Date.now();
  const wait = Math.max(0, _nextSlot - now);
  _nextSlot = Math.max(now, _nextSlot) + MIN_INTERVAL;
  if (wait) await sleep(wait);
}

async function apicalypse(endpoint, query, token) {
  for (let attempt = 0; attempt < 6; attempt++) {
    await rateGate();
    const r = await fetch(`${API}/${endpoint}`, {
      method: 'POST',
      headers: {
        'Client-ID': process.env.IGDB_CLIENT_ID,
        Authorization: `Bearer ${token}`,
        Accept: 'application/json',
      },
      body: query,
    });
    if (r.status === 429) { await sleep(500 * (attempt + 1)); continue; } // rate limited — back off, then re-gate
    if (!r.ok) throw new Error(`IGDB ${endpoint} failed (${r.status}): ${await r.text()}`);
    return r.json();
  }
  throw new Error(`IGDB ${endpoint} rate-limited after retries`);
}

const sleep = (ms) => new Promise((res) => setTimeout(res, ms));

function logoUrl(image_id) {
  return image_id ? `https://images.igdb.com/igdb/image/upload/t_logo_med/${image_id}.png` : null;
}

// Best official website among the expanded `websites` array (type 1 = official).
function officialSite(websites) {
  if (!Array.isArray(websites)) return null;
  const off = websites.find((w) => w.type === 1) || websites[0];
  return off ? off.url : null;
}

// Decide whether a game genuinely belongs on THIS studio's shelf, from each
// game's per-credit involved_companies (the "Main Developers / Porting
// Developers / Publishers" split IGDB shows on a game page). Two kinds of noise
// this filters out — both from games where our studio is only a *publisher*:
//   • Regional distribution — the game was self-published by a DIFFERENT company
//     (one credited as BOTH developer and publisher). That self-publisher is the
//     real owner; our studio just handled a regional release. This is why
//     "Electronic Arts" was showing Valve's Portal 2 / Half-Life 2: EA is a
//     publisher-of-record for the regional release only.
//   • Supporting / porting-only credits — our studio only helped or ported.
// A game we DEVELOPED is unquestionably ours; a game we PUBLISH is ours unless a
// third party self-published it. Returns the studio's role on the game, which the
// card shows as a tag, or null when the game doesn't belong on its shelf:
//   'developer' — credited as a developer (we made it)
//   'publisher' — publisher of record (no third party self-published it)
//   null        — regional distribution (someone else self-published) or a
//                 supporting/porting-only credit: not really our game
function gameRole(g, companyId) {
  const ics = g.involved_companies;
  if (!Array.isArray(ics) || !ics.length) return 'developer'; // matched our id but credits absent → treat as ours
  const ours = ics.find((ic) => ic.company === companyId);
  if (!ours) return 'developer';       // shouldn't happen (queried by our id)
  if (ours.developer) return 'developer';
  if (!ours.publisher) return null;    // supporting/porting-only → not ours
  // Publisher-only: drop if a different company self-published (dev && pub) —
  // then we're a regional distributor, not the publisher of record.
  if (ics.some((ic) => ic.company !== companyId && ic.developer && ic.publisher)) return null;
  return 'publisher';
}

// Pull a studio's games in ONE popularity-sorted query (IGDB's "Popular Games"
// ordering, total_rating_count), keep real games (game_type 0 = main game, or
// unknown), drop the regional-distribution / porting noise above, dedupe, and
// return up to MAX_GAMES. Fetching only the top GAME_FETCH — sorted server-side —
// means we never transfer a mega-publisher's whole 1500-game catalogue just to
// keep ten. Each title carries its cover *image id* (not a URL); the board builds
// the IGDB CDN URL on hover, so studios.json stays tiny.
async function fetchGames(companyId, token) {
  const rows = await apicalypse(
    'games',
    // version_parent = null drops editions/re-releases ("… Deluxe Edition") that
    // point at a base game — we want the base title, not every SKU of it.
    `${GAME_FIELDS} where involved_companies.company = ${companyId} & version_parent = null; sort total_rating_count desc; limit ${GAME_FETCH};`,
    token,
  );
  const byName = new Map(); // lowercased name → best entry (merges duplicates)
  for (const g of rows) {
    if (!g || !g.name) continue;
    if (g.game_type != null && g.game_type !== 0) continue; // drop DLC/bundles/mods
    const role = gameRole(g, companyId);
    if (!role) continue;                                    // regional distribution / porting → not ours
    const k = g.name.toLowerCase();
    const cover = (g.cover && g.cover.image_id) || null;
    const prev = byName.get(k);
    if (prev) {
      if (!prev.cover && cover) prev.cover = cover;
      if (role === 'developer') prev.role = 'developer';    // a developer credit outranks a publisher one on a dup
      prev.pop = Math.max(prev.pop, g.total_rating_count || 0);
      prev.rating = Math.max(prev.rating, g.total_rating || 0);
      prev.year = Math.max(prev.year, g.first_release_date || 0);
      continue;
    }
    byName.set(k, { name: g.name, cover, role, pop: g.total_rating_count || 0, rating: g.total_rating || 0, year: g.first_release_date || 0 });
  }
  const games = [...byName.values()];
  // Pick the shelf by notability (popularity, then rating), so a studio's
  // flagships make the cut over obscure recent titles. Display ORDER (e.g.
  // newest-first) is the board's job, done at render time from the `year` below —
  // it's presentation, not data, so it never needs a re-enrich.
  games.sort((a, b) => b.pop - a.pop || b.rating - a.rating || b.year - a.year);
  return games.slice(0, MAX_GAMES).map((g) => ({
    name: g.name,
    cover: g.cover,
    role: g.role,
    // Release year (from the unix first_release_date) — shown on hover and used by
    // the board to order the shelf. Null when IGDB had no date. (total_rating
    // still drives the shelf selection above, but we don't surface a score: it's
    // meaningless without the vote count behind it.)
    year: g.year ? new Date(g.year * 1000).getUTCFullYear() : null,
  }));
}

function normalize(company, games) {
  return {
    name: company.name,
    logo: logoUrl(company.logo && company.logo.image_id),
    founded: company.start_date ? new Date(company.start_date * 1000).getUTCFullYear() : null,
    country: COUNTRY[company.country] || null,
    website: officialSite(company.websites),
    url: company.url || null, // IGDB page
    description: company.description
      ? (company.description.length > DESC_CAP
        ? company.description.slice(0, DESC_CAP).replace(/\s+\S*$/, '') + '…'
        : company.description)
      : null,
    games,
  };
}

// Company match fields are lightweight: `developed`/`published` are left as bare
// id arrays (just counts, for nGames scoring) — the full game details come from a
// single popularity-sorted fetchGames() call for the WINNER only, not every
// candidate. That keeps the widen search (up to 50 companies) cheap.
const FIELDS =
  'fields id,name,description,country,start_date,url,logo.image_id,' +
  'developed,published,websites.url,websites.type;';

// Per-game fields for fetchGames: popularity (the sort), the bits normalize/
// dedupe need, and the involved_companies credits keepGame filters on. `company`
// on each involved_company is a bare id, matched against the studio's own id.
const GAME_FIELDS =
  'fields name,game_type,total_rating,total_rating_count,first_release_date,cover.image_id,' +
  'involved_companies.company,involved_companies.developer,involved_companies.publisher,involved_companies.porting;';

// Studio-suffix words that IGDB and job boards use inconsistently ("Bampot
// Studio" vs "Bampot Games"). Stripping the trailing one lets those still match.
const SUFFIX_RE = /\b(studios?|games?|interactive|entertainment|productions?|software|digital|media|works|limited|company|corporation|corp|inc|ltd|llc|co|gmbh|ab|oy|sa|bv|the)\b/gi;
// A studio written as a domain ("Wargaming.net", "thatgamecompany.com") is the
// same identity as its base — strip a trailing web TLD so it ties the plain name
// rather than reading as a distinct "contains-only" match.
const TLD_RE = /\.(net|com|io|gg|co|dev|games|studio|world|gl|ai|xyz|tv)$/;
function coreName(name) {
  const base = keyOf(name).replace(TLD_RE, '');
  const core = base.replace(SUFFIX_RE, ' ').replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
  return core || keyOf(name); // never strip a name down to nothing
}
function nGames(c) {
  return ((c.developed && c.developed.length) || 0) + ((c.published && c.published.length) || 0);
}

// Score one IGDB candidate against the name we searched for plus the country
// hint derived from the studio's job postings. The point is to beat "first
// result wins": a namesake in the right country with a real game catalogue
// should outrank a bare substring match from an unrelated company.
function scoreCandidate(c, want, core, hint) {
  let s = 0;
  const cn = keyOf(c.name);
  if (cn === want) s += 100;                       // exact name
  else if (core && coreName(c.name) === core) s += 55; // same core, different suffix
  else s += 5;                                     // contains-only: weak on its own
  const games = nGames(c);
  if (games) s += Math.min(30, 8 + games * 3);     // a real studio with a catalogue
  if (c.logo && c.logo.image_id) s += 12;
  if (c.start_date) s += 4;
  if (hint) {
    const cc = COUNTRY[c.country] || null;
    if (cc && cc === hint) s += 50;                // corroborated by location
    else if (cc && cc !== hint) s -= 12;           // soft: the hint can be noisy
  }
  return s;
}

// Pick the best-scoring candidate, then refuse it if the evidence is too thin —
// a wrong badge is worse than none (the miss ledger just retries weekly). The
// only hard reject is a contains-only hit with no name tie and no country+games
// corroboration: that's the substring garbage the old "first result" grabbed.
// A solid name tie is kept even when the (noisy) country hint disagrees.
function bestMatch(results, name, hint, slugKey) {
  if (!results || !results.length) return null;
  const want = keyOf(name);
  const core = coreName(name);

  // Slug-first: the studio's own ATS handle is stronger identity than a display
  // name a board may have truncated. Among candidates whose bare name is embedded
  // in the slug and that have a catalogue, take the MOST SPECIFIC (longest) — so
  // "amberstudiocareers" picks "Amber Studio" over the unrelated exact "Amber".
  // Guarded to length ≥ 5 so a two-letter name can't latch onto any slug.
  if (slugKey) {
    const bySlug = results
      .map((c) => ({ c, ck: keyOf(c.name).replace(/[^a-z0-9]/g, '') }))
      .filter(({ c, ck }) => ck.length >= 5 && slugKey.includes(ck) && nGames(c) > 0)
      .sort((a, b) => b.ck.length - a.ck.length || nGames(b.c) - nGames(a.c));
    if (bySlug.length) return bySlug[0].c;
  }

  let best = null, bestScore = -Infinity;
  for (const c of results) {
    const sc = scoreCandidate(c, want, core, hint);
    if (sc > bestScore) { bestScore = sc; best = c; }
  }
  const cc = COUNTRY[best.country] || null;
  const nameTie = keyOf(best.name) === want || coreName(best.name) === core;
  const games = nGames(best) > 0;
  if (!nameTie && !(hint && cc === hint && games)) return null; // weak contains-only match
  return best;
}

// Brand fallback: a bare brand name ("Ubisoft") often has no company of its own
// in IGDB, only regional sub-studios ("Ubisoft Vancouver"). When the strict
// matcher above rejects everything, show the sub-studio in the studio's dominant
// posting country — but ONLY when that country hint corroborates it. A brand's
// sub-studios are named "<brand> <place>" and one of them really is where the
// postings come from; a coincidental "<word> Something" (three unrelated indies
// called "Cinnamon Switch"/"Cinnamon Pupper"…) has no sub in the posting country,
// so it correctly gets no badge. Without a location hint we can't tell a real
// brand from a namesake pile-up, so we don't guess.
function brandFallback(results, name, hint) {
  if (!hint) return null; // no location evidence → a namesake guess is worse than no badge
  const want = keyOf(name);
  const subs = results.filter((c) =>
    keyOf(c.name).startsWith(want + ' ') &&
    (COUNTRY[c.country] || null) === hint &&      // the sub really is in the posting country
    nGames(c) > 0);                               // …and has a catalogue behind it
  if (!subs.length) return null;
  subs.sort((a, b) => nGames(b) - nGames(a));     // the flagship among the in-country subs
  return subs[0];
}

// A first-pass exact hit we can trust without widening the search: exact name
// and either no hint or the country agrees. Anything softer earns a contains
// pass so scoring can consider the full candidate set.
function isConfident(match, name, hint) {
  if (!match || keyOf(match.name) !== keyOf(name)) return false;
  return !hint || (COUNTRY[match.country] || null) === hint;
}

/**
 * Resolve one studio by company name. Returns a normalized studio object, or
 * null when IGDB has no match. Cached both ways (hit and miss).
 * @param {string} name
 * @param {{token?: string, refresh?: boolean, countryHint?: string|null, companyUrl?: string|null}} [opts]
 */
export async function lookupStudio(name, opts = {}) {
  const cache = await loadCache();
  const key = keyOf(name);
  if (!key) return null;
  if (!opts.refresh && Object.prototype.hasOwnProperty.call(cache, key)) return cache[key];

  const token = opts.token || (await getToken());
  const hint = opts.countryHint || null;
  // The studio's own ATS handle (from its careers URL) disambiguates truncated
  // display names ("Amber" → the "amberstudiocareers" slug prefers "Amber Studio").
  const slugKey = slugKeyOf(opts.companyUrl);
  // IGDB's inline `search` returns nothing on the companies endpoint — use the
  // `~` operator instead (case-insensitive). Escape quotes so a studio like
  // O"Brien can't break the query.
  const safe = String(name).replace(/"/g, '\\"');

  // Exact-ish name first (may return several namesakes → scored, not first-wins).
  let results = await apicalypse('companies', `${FIELDS} where name ~ "${safe}"; limit 10;`, token);
  let match = bestMatch(results, name, hint, slugKey);

  // Widen to a contains search when the exact set gave no confident winner (an
  // obscure studio, a namesake in the wrong country, or nothing) — or whenever we
  // have a slug, since the suffixed name it points to ("Amber Studio") never comes
  // back from an exact search on the truncated name. Merge + dedupe by id.
  if (!isConfident(match, name, hint) || slugKey) {
    // limit 50, not 20: a big brand ("Ubisoft") has 40+ sub-studios, and the one
    // in the posting country must be in this set for brandFallback to find it.
    const more = await apicalypse('companies', `${FIELDS} where name ~ *"${safe}"*; limit 50;`, token);
    const byId = new Map();
    for (const c of [...results, ...more]) if (c && c.id != null) byId.set(c.id, c);
    results = [...byId.values()];
    match = bestMatch(results, name, hint, slugKey);
  }

  // Nothing passed the strict matcher — try the brand → sub-studio fallback so an
  // umbrella name like "Ubisoft" still shows a sensible regional studio.
  if (!match) match = brandFallback(results, name, hint);

  // Second phase: fetch the winner's games only (top-by-popularity, filtered).
  const games = match ? await fetchGames(match.id, token) : [];
  const studio = match ? normalize(match, games) : null;
  cache[key] = studio;
  await saveCache();
  return studio;
}

export { getToken, keyOf };
