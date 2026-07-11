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
  'fields name,description,country,start_date,url,logo.image_id,' +
  'developed.name,developed.game_type,developed.total_rating,developed.first_release_date,developed.cover.image_id,' +
  'published.name,published.game_type,published.total_rating,published.first_release_date,published.cover.image_id,' +
  'websites.url,websites.type;';

// Pick the IGDB result that best matches the name we searched for: exact
// (case-insensitive) wins, otherwise IGDB's own relevance order (first result).
function bestMatch(results, name) {
  if (!results || !results.length) return null;
  const want = keyOf(name);
  return results.find((c) => keyOf(c.name) === want) || results[0];
}

/**
 * Resolve one studio by company name. Returns a normalized studio object, or
 * null when IGDB has no match. Cached both ways (hit and miss).
 * @param {string} name
 * @param {{token?: string, refresh?: boolean}} [opts]
 */
export async function lookupStudio(name, opts = {}) {
  const cache = await loadCache();
  const key = keyOf(name);
  if (!key) return null;
  if (!opts.refresh && Object.prototype.hasOwnProperty.call(cache, key)) return cache[key];

  const token = opts.token || (await getToken());
  // IGDB's inline `search` returns nothing on the companies endpoint — use the
  // `~` operator instead (case-insensitive). Try an exact name match first, then
  // fall back to a contains match. Escape quotes so a studio like O"Brien can't
  // break the query.
  const safe = String(name).replace(/"/g, '\\"');
  let results = await apicalypse('companies', `${FIELDS} where name ~ "${safe}"; limit 5;`, token);
  if (!results.length) {
    results = await apicalypse('companies', `${FIELDS} where name ~ *"${safe}"*; limit 15;`, token);
  }
  const match = bestMatch(results, name);
  const studio = match ? normalize(match) : null;

  cache[key] = studio;
  await saveCache();
  return studio;
}

export { getToken, keyOf };
