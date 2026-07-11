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

const DESC_CAP = 240; // hard cap on the blurb we keep — a card subtitle, not the wiki
const MAX_GAMES = 8;  // catalogue chips shown per studio

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

// Dedupe developed + published, keep real games (game_type 0 = main game, or
// unknown), sort by rating then recency, and return up to MAX_GAMES titles.
// Each title carries its cover *image id* (not a URL) — the board builds the
// IGDB CDN URL on hover, so studios.json stays tiny.
function pickGames(company) {
  const all = [...(company.developed || []), ...(company.published || [])];
  const byName = new Map(); // lowercased name → best entry (merges dev/pub dups)
  for (const g of all) {
    if (!g || !g.name) continue;
    if (g.game_type != null && g.game_type !== 0) continue; // drop DLC/bundles/mods
    const k = g.name.toLowerCase();
    const cover = (g.cover && g.cover.image_id) || null;
    const prev = byName.get(k);
    if (prev) {
      if (!prev.cover && cover) prev.cover = cover; // a dup may carry the cover the first lacked
      prev.rating = Math.max(prev.rating, g.total_rating || 0);
      prev.year = Math.max(prev.year, g.first_release_date || 0);
      continue;
    }
    byName.set(k, { name: g.name, cover, rating: g.total_rating || 0, year: g.first_release_date || 0 });
  }
  const games = [...byName.values()];
  games.sort((a, b) => b.rating - a.rating || b.year - a.year);
  return games.slice(0, MAX_GAMES).map((g) => ({ name: g.name, cover: g.cover }));
}

function normalize(company) {
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
    games: pickGames(company),
  };
}

const FIELDS =
  'fields id,name,description,country,start_date,url,logo.image_id,' +
  'developed.name,developed.game_type,developed.total_rating,developed.first_release_date,developed.cover.image_id,' +
  'published.name,published.game_type,published.total_rating,published.first_release_date,published.cover.image_id,' +
  'websites.url,websites.type;';

// Studio-suffix words that IGDB and job boards use inconsistently ("Bampot
// Studio" vs "Bampot Games"). Stripping the trailing one lets those still match.
const SUFFIX_RE = /\b(studios?|games?|interactive|entertainment|productions?|software|digital|media|works|limited|company|corporation|corp|inc|ltd|llc|co|gmbh|ab|oy|sa|bv|the)\b/gi;
function coreName(name) {
  const core = keyOf(name).replace(SUFFIX_RE, ' ').replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
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
function bestMatch(results, name, hint) {
  if (!results || !results.length) return null;
  const want = keyOf(name);
  const core = coreName(name);
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
// matcher above rejects everything, show the sub-studio that best fits — one in
// the studio's dominant posting country if we know it, else the one with the
// biggest catalogue — but only if it carries real evidence, so a lone mislabeled
// "<name> Something" with nothing behind it still shows no badge.
function brandFallback(results, name, hint) {
  const want = keyOf(name);
  const subs = results.filter((c) => keyOf(c.name).startsWith(want + ' '));
  if (!subs.length) return null;
  subs.sort((a, b) => {
    const ac = hint && (COUNTRY[a.country] || null) === hint ? 1 : 0;
    const bc = hint && (COUNTRY[b.country] || null) === hint ? 1 : 0;
    if (ac !== bc) return bc - ac;                  // prefer the posting-country one
    return nGames(b) - nGames(a);                   // then the flagship (most games)
  });
  const best = subs[0];
  const strong = (hint && (COUNTRY[best.country] || null) === hint) || nGames(best) >= 3;
  return strong ? best : null;
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
 * @param {{token?: string, refresh?: boolean, countryHint?: string|null}} [opts]
 */
export async function lookupStudio(name, opts = {}) {
  const cache = await loadCache();
  const key = keyOf(name);
  if (!key) return null;
  if (!opts.refresh && Object.prototype.hasOwnProperty.call(cache, key)) return cache[key];

  const token = opts.token || (await getToken());
  const hint = opts.countryHint || null;
  // IGDB's inline `search` returns nothing on the companies endpoint — use the
  // `~` operator instead (case-insensitive). Escape quotes so a studio like
  // O"Brien can't break the query.
  const safe = String(name).replace(/"/g, '\\"');

  // Exact-ish name first (may return several namesakes → scored, not first-wins).
  let results = await apicalypse('companies', `${FIELDS} where name ~ "${safe}"; limit 10;`, token);
  let match = bestMatch(results, name, hint);

  // Widen to a contains search only when the exact set gave no confident winner
  // (an obscure studio, a namesake in the wrong country, or nothing). Merge and
  // dedupe by id so scoring weighs every candidate together.
  if (!isConfident(match, name, hint)) {
    const more = await apicalypse('companies', `${FIELDS} where name ~ *"${safe}"*; limit 20;`, token);
    const byId = new Map();
    for (const c of [...results, ...more]) if (c && c.id != null) byId.set(c.id, c);
    results = [...byId.values()];
    match = bestMatch(results, name, hint);
  }

  // Nothing passed the strict matcher — try the brand → sub-studio fallback so an
  // umbrella name like "Ubisoft" still shows a sensible regional studio.
  if (!match) match = brandFallback(results, name, hint);

  const studio = match ? normalize(match) : null;
  cache[key] = studio;
  await saveCache();
  return studio;
}

export { getToken, keyOf };
