// @ts-check
// studio-info — quick studio context (logo, previous games, founding, site)
// so you stop googling every company the board surfaces.
//
//   node studio-info.mjs "Studio Name"      one lookup, printed to the terminal
//   node studio-info.mjs --board            enrich every studio on the board →
//                                           site/data/studios.json (cached)
//
// Flags for --board:
//   --limit N     only enrich the first N uncached studios (a quick taste)
//   --refresh     ignore the cache and re-fetch
//
// Source is IGDB (see providers/igdb.mjs and .env.example for the free signup).

import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { lookupStudio, getToken, keyOf, countryOfLocation } from './providers/igdb.mjs';

// dotenv is optional — fall back to process.env if it isn't installed.
try { const { config } = await import('dotenv'); config(); } catch {}

const JOBS_PATH = fileURLToPath(new URL('./site/data/jobs.json', import.meta.url));
const STUDIOS_PATH = fileURLToPath(new URL('./site/data/studios.json', import.meta.url));
// Bare keys IGDB had nothing useful for (no match, or a match with no context).
// No studio data, no token — safe to publish, so it rides the board artifact and
// lets the next (stateless CI) run skip re-asking about the same blanks.
const MISSES_PATH = fileURLToPath(new URL('./site/data/studio-misses.json', import.meta.url));

const args = process.argv.slice(2);

// A match is only worth putting on the board when it carries something to show.
// IGDB sometimes returns a bare name + page link (thin or wrong matches like
// "AMD"/"Corsair"); those would render a badge that opens an empty popover.
// Keep this in sync with studioHasContext() in site/index.html.
function hasContext(s) {
  return !!(s && (s.logo || (s.games && s.games.length) || s.founded || s.country || s.description || s.website));
}

function fmtStudio(s, name) {
  if (!s) return `No IGDB match for "${name}".`;
  const L = [];
  L.push(`\n  ${s.name}${s.founded ? `  ·  est. ${s.founded}` : ''}${s.country ? `  ·  ${s.country}` : ''}`);
  if (s.website) L.push(`  ${s.website}`);
  if (s.logo) L.push(`  logo: ${s.logo}`);
  if (s.games && s.games.length) L.push(`  games: ${s.games.map((g) => {
    if (typeof g === 'string') return g;
    const tag = g.role === 'developer' ? ' (dev)' : g.role === 'publisher' ? ' (pub)' : '';
    return g.name + tag;
  }).join(', ')}`);
  if (s.description) L.push(`\n  ${s.description}`);
  if (s.url) L.push(`\n  IGDB: ${s.url}`);
  return L.join('\n');
}

async function single(name) {
  let studio;
  try {
    studio = await lookupStudio(name);
  } catch (e) {
    console.error(`\n  ${e.message}\n`);
    process.exit(1);
  }
  console.log(fmtStudio(studio, name));
}

// Unique studios on the board, each with the country that dominates its
// postings — the hint IGDB uses to disambiguate namesakes. First-seen order.
async function boardCompanies() {
  const raw = JSON.parse(await readFile(JOBS_PATH, 'utf8'));
  const jobs = Array.isArray(raw) ? raw : raw.jobs || raw.data || [];
  const seen = new Map(); // key -> { name, counts: Map<country, n>, companyUrl }
  for (const j of jobs) {
    const name = (j && j.company) || '';
    const k = keyOf(name);
    if (!k) continue;
    let e = seen.get(k);
    if (!e) { e = { name: name.trim(), counts: new Map(), companyUrl: null }; seen.set(k, e); }
    const cc = countryOfLocation(j && j.location);
    if (cc) e.counts.set(cc, (e.counts.get(cc) || 0) + 1);
    // First ATS careers URL we see for this studio — carries its self-chosen slug,
    // which disambiguates a truncated display name (see studioSlug in igdb.mjs).
    if (!e.companyUrl && j && j.companyUrl) e.companyUrl = j.companyUrl;
  }
  return [...seen.values()].map((e) => {
    let hint = null, best = 0;
    for (const [c, n] of e.counts) if (n > best) { best = n; hint = c; }
    return { name: e.name, countryHint: hint, companyUrl: e.companyUrl };
  });
}

// Run `fn` over `items` with at most `size` in flight (IGDB allows ~4/s, 8 conc).
async function pool(items, size, fn) {
  let i = 0;
  const workers = Array.from({ length: size }, async () => {
    while (i < items.length) {
      const idx = i++;
      await fn(items[idx], idx);
    }
  });
  await Promise.all(workers);
}

async function board() {
  const limit = flagNum('--limit');
  const refresh = args.includes('--refresh');

  let token;
  try {
    token = await getToken(); // fail fast + loud if creds are missing
  } catch (e) {
    console.error(`\n  ${e.message}\n`);
    process.exit(1);
  }

  const companies = await boardCompanies();
  console.log(`Board has ${companies.length} unique studios.`);

  // Existing output — so a re-run only appends newly resolved studios.
  let out = {};
  try { out = JSON.parse(await readFile(STUDIOS_PATH, 'utf8')); } catch {}

  // Negative ledger. Without this, a context-less studio is absent from `out`
  // and so lands back in `todo` every run — free locally (studio-cache.json
  // remembers the miss) but a real IGDB call every time on a stateless CI
  // checkout. --refresh ignores the ledger and re-checks everyone (a studio not
  // in IGDB today may be added later).
  let misses = new Set();
  if (!refresh) {
    try { misses = new Set(JSON.parse(await readFile(MISSES_PATH, 'utf8'))); } catch {}
  }

  const todo = refresh
    ? companies
    : companies.filter((c) => { const k = keyOf(c.name); return !(k in out) && !misses.has(k); });
  const work = limit ? todo.slice(0, limit) : todo;
  console.log(`Enriching ${work.length} studio(s)${limit ? ` (--limit ${limit})` : ''} via IGDB…\n`);

  let done = 0, hits = 0;
  await pool(work, 4, async ({ name, countryHint, companyUrl }) => {
    const k = keyOf(name);
    try {
      const s = await lookupStudio(name, { token, refresh, countryHint, companyUrl });
      if (hasContext(s)) { out[k] = s; misses.delete(k); hits++; }
      else { delete out[k]; misses.add(k); } // no context → remember so we don't re-ask
    } catch (e) {
      console.error(`  ! ${name}: ${e.message}`); // transient error: leave it unrecorded so it retries
    }
    if (++done % 25 === 0 || done === work.length) {
      process.stdout.write(`\r  ${done}/${work.length} processed, ${hits} matched`);
    }
  });

  // Prune any context-less entries a previous run may have written before this
  // filter existed, and remember them so they're not re-asked next run.
  let pruned = 0;
  for (const k of Object.keys(out)) if (!hasContext(out[k])) { delete out[k]; misses.add(k); pruned++; }

  await writeFile(STUDIOS_PATH, JSON.stringify(out, null, 0));
  await writeFile(MISSES_PATH, JSON.stringify([...misses]));
  console.log(`\n\nWrote ${Object.keys(out).length} studios → site/data/studios.json${pruned ? ` (pruned ${pruned} empty)` : ''}`);
  console.log(`Remembered ${misses.size} context-less studios → site/data/studio-misses.json (skipped daily; --refresh re-checks all).`);
}

function flagNum(flag) {
  const i = args.indexOf(flag);
  if (i === -1) return 0;
  const n = parseInt(args[i + 1], 10);
  return Number.isFinite(n) ? n : 0;
}

// ── dispatch ──────────────────────────────────────────────────────────────────
if (args.includes('--board')) {
  await board();
} else if (args.length && !args[0].startsWith('--')) {
  await single(args.join(' '));
} else {
  console.log(`\nUsage:\n  node studio-info.mjs "Studio Name"     one lookup\n  node studio-info.mjs --board            enrich the whole board (--limit N, --refresh)\n`);
}
