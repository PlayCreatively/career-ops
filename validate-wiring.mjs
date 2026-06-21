#!/usr/bin/env node
// @ts-check
// validate-wiring.mjs — tokenless audit of the EXISTING studios.yml wiring.
//
// resolve-batch.mjs resolves studios we HAVEN'T wired yet. This does the opposite:
// it checks the studios we already wired are still pointed at the right GAME feed.
// CIG taught us a wired entry can silently rot — pointed at an empty namesake slug
// while the real jobs live on another host. This catches three failure shapes,
// all tokenlessly (pure HTTP, zero LLM):
//
//   dead     — the feed errors / 404s / unreachable → the wiring is broken.
//   empty    — feed is live but returns 0 jobs (could be legit, e.g. Yager; low
//              priority, but worth a glance).
//   suspect  — feed is live and returns jobs, but NONE look like game-industry
//              roles → likely a same-named NON-game company (the CIG signature).
//
// Flagged studios (suspect + dead [+ empty]) are written to a list the Haiku
// re-checker (resolve-batch.mjs --from-audit) reads, so an LLM only ever looks at
// the entries the free pass couldn't clear.
//
// Usage:
//   node validate-wiring.mjs                 # audit all wired studios, print + write report
//   node validate-wiring.mjs --company "X"   # just one
//   node validate-wiring.mjs --limit 50      # cap how many (debug)
//   node validate-wiring.mjs --json          # machine output to stdout
//   node validate-wiring.mjs --include-empty # also flag 0-job feeds for recheck
//
// Outputs:
//   data/wiring-audit.jsonl    one verdict per studio (always)
//   data/wiring-flagged.txt    newline-separated studio names to re-check (always)

import { readFileSync, writeFileSync, appendFileSync, existsSync, mkdirSync, readdirSync } from 'node:fs';
import { pathToFileURL, fileURLToPath } from 'node:url';
import path from 'node:path';
import yaml from 'js-yaml';

import { makeHttpCtx, classifyFetchError } from './providers/_http.mjs';

const ROOT = process.cwd();
const STUDIOS = path.join(ROOT, 'studios.yml');
const PROVIDERS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'providers');
const AUDIT = path.join(ROOT, 'data', 'wiring-audit.jsonl');
const FLAGGED = path.join(ROOT, 'data', 'wiring-flagged.txt');
const CONCURRENCY = 10;

// ── args ──────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const JSON_OUT = argv.includes('--json');
const INCLUDE_EMPTY = argv.includes('--include-empty');
const companyIdx = argv.indexOf('--company');
const ONLY = companyIdx >= 0 ? argv[companyIdx + 1] : null;
const limitIdx = argv.indexOf('--limit');
const LIMIT = limitIdx >= 0 ? parseInt(argv[limitIdx + 1], 10) : Infinity;

// ── game-industry vocabulary ────────────────────────────────────────────────
// Deliberately GENEROUS (fail-safe per user pref: don't over-flag real studios).
// A correctly-wired game studio almost always has ≥1 title hitting one of these;
// a wrongly-wired non-game namesake (insurer/clinic/agency) hits zero. Substring,
// case-insensitive. Generic words that even a non-game firm shares (manager,
// designer, marketing) are intentionally EXCLUDED so they can't mask a namesake.
const GAME_TERMS = [
  'game', 'gameplay', 'engine', 'unreal', 'unity', 'godot', 'level design',
  'narrative', 'quest', 'encounter', 'combat', 'character art', 'concept art',
  'environment art', '3d artist', '2d artist', 'character artist', 'vfx',
  'technical artist', 'tech artist', 'rigging', 'rigger', 'animator', 'animation',
  'gameplay programmer', 'gameplay engineer', 'graphics programmer', 'shader',
  'rendering', 'physics programmer', 'netcode', 'multiplayer', 'gameplay designer',
  'systems designer', 'level designer', 'world builder', 'game designer',
  'game writer', 'game producer', 'gameplay', 'playtest', 'qa tester', 'game qa',
  'live ops', 'liveops', 'monetization', 'esports', 'game audio', 'sound designer',
  'technical designer', 'ui artist', 'ux artist', 'pipeline td', 'build engineer',
];

function looksGame(title) {
  const t = (title || '').toLowerCase();
  return GAME_TERMS.some((k) => t.includes(k));
}

// A real studio with only 1-2 business roles open (Finance, External Dev Manager)
// looks identical to a wrong-company namesake if you only check "zero game titles".
// The namesake signature is zero-game AT VOLUME (an insurer with 30 corporate
// roles). So we only call it "suspect" once the feed has enough jobs that an
// all-non-game result is meaningful; below that it's "lean" — live, just thinly /
// non-game hiring right now — and NOT flagged (fail-safe: don't re-spend LLM on
// correctly-wired studios). Override with --suspect-min N.
const sMinIdx = process.argv.indexOf('--suspect-min');
const SUSPECT_MIN = sMinIdx >= 0 ? parseInt(process.argv[sMinIdx + 1], 10) : 5;

// ── provider loading (minimal mirror of scan.mjs, kept standalone) ───────────
async function loadProviders(dir) {
  const providers = new Map();
  if (!existsSync(dir)) return providers;
  const files = readdirSync(dir).filter((f) => f.endsWith('.mjs') && !f.startsWith('_')).sort();
  for (const file of files) {
    let mod;
    try { mod = await import(pathToFileURL(path.join(dir, file)).href); } catch { continue; }
    const p = mod.default;
    if (p && typeof p.fetch === 'function' && p.id && !providers.has(p.id)) providers.set(p.id, p);
  }
  return providers;
}

// Resolve the provider for one studio entry. We skip local-parser here: it shells
// out to the user's own script, which isn't a "wiring" concern this audit can or
// should validate over HTTP.
function resolveProvider(entry, providers) {
  if (entry.provider) {
    const p = providers.get(entry.provider);
    return p ? { provider: p } : { error: `unknown provider: ${entry.provider}` };
  }
  for (const p of providers.values()) {
    if (p.id === 'local-parser') continue;
    let hit;
    try { hit = p.detect?.(entry); } catch { hit = null; }
    if (hit) return { provider: p };
  }
  return null;
}

// ── parallel pool ────────────────────────────────────────────────────────────
async function parallel(tasks, limit) {
  const out = [];
  let i = 0;
  async function next() { while (i < tasks.length) { const t = tasks[i++]; out.push(await t()); } }
  await Promise.all(Array.from({ length: Math.min(limit, tasks.length) }, next));
  return out;
}

// ── classify one studio's feed ───────────────────────────────────────────────
async function audit(entry, providers) {
  const resolved = resolveProvider(entry, providers);
  if (!resolved) return { name: entry.name, status: 'no-provider', note: 'wired with recipe/parser or nothing this audit can poll' };
  if (resolved.error) return { name: entry.name, status: 'no-provider', note: resolved.error };

  const provider = resolved.provider;
  const ctx = makeHttpCtx();
  let jobs;
  try {
    jobs = await provider.fetch(entry, ctx);
  } catch (err) {
    const kind = classifyFetchError(err);
    // throttled/blocked are transient/edge — NOT broken wiring; surface separately
    // so a rate-limit wave doesn't masquerade as dead feeds.
    const status = (kind === 'throttled' || kind === 'blocked') ? kind : 'dead';
    return { name: entry.name, provider: provider.id, status, kind, note: String(err.message || err).slice(0, 140) };
  }
  if (!Array.isArray(jobs)) return { name: entry.name, provider: provider.id, status: 'dead', note: 'fetch() did not return an array' };

  const n = jobs.length;
  if (n === 0) return { name: entry.name, provider: provider.id, status: 'empty', jobs: 0 };

  const samples = jobs.slice(0, 5).map((j) => j.title);
  // Teamtailor trial/unconfigured accounts serve placeholder jobs all titled
  // "DEMO – …". That's a CERTAIN wrong-slug, not a maybe-namesake — surface it as
  // such so it's an obvious fix, no LLM needed to diagnose.
  if (jobs.every((j) => /^\s*DEMO\b/i.test(j.title || ''))) {
    return { name: entry.name, provider: provider.id, status: 'suspect', jobs: n, gameHits: 0, samples,
      note: `placeholder DEMO board (${n} demo jobs) — wired to an unconfigured/trial ATS slug` };
  }

  const gameHits = jobs.filter((j) => looksGame(j.title)).length;
  if (gameHits === 0) {
    if (n >= SUSPECT_MIN) {
      return { name: entry.name, provider: provider.id, status: 'suspect', jobs: n, gameHits, samples,
        note: `feed live, ${n} jobs, zero game-shaped — likely wrong-company (namesake) wiring` };
    }
    return { name: entry.name, provider: provider.id, status: 'lean', jobs: n, gameHits, samples,
      note: 'live but only a few non-game roles right now — probably fine' };
  }
  return { name: entry.name, provider: provider.id, status: 'ok', jobs: n, gameHits, samples };
}

// ── main ─────────────────────────────────────────────────────────────────────
async function main() {
  if (!existsSync(STUDIOS)) { console.error('studios.yml not found in cwd'); process.exit(1); }
  const doc = yaml.load(readFileSync(STUDIOS, 'utf8')) || {};
  const companies = Array.isArray(doc.tracked_companies) ? doc.tracked_companies : [];

  const providers = await loadProviders(PROVIDERS_DIR);
  if (providers.size === 0) { console.error('no providers loaded from providers/'); process.exit(1); }

  // "Wired" = has something a provider can resolve (explicit provider or a
  // detectable careers_url). Backlog entries with no feed are resolve-batch's job.
  let wired = companies.filter((c) => c && typeof c.name === 'string' && c.enabled !== false && resolveProvider(c, providers));
  if (ONLY) wired = wired.filter((c) => c.name.toLowerCase() === ONLY.toLowerCase());
  if (Number.isFinite(LIMIT)) wired = wired.slice(0, LIMIT);

  if (wired.length === 0) { console.log('No wired studios match.'); return; }

  if (!JSON_OUT) console.log(`\n  validate-wiring — auditing ${wired.length} wired studio(s) tokenlessly…\n`);

  const results = await parallel(wired.map((c) => () => audit(c, providers)), CONCURRENCY);

  // write sidecar
  mkdirSync(path.dirname(AUDIT), { recursive: true });
  const stamp = new Date().toISOString().slice(0, 10);
  writeFileSync(AUDIT, results.map((r) => JSON.stringify({ at: stamp, ...r })).join('\n') + '\n');

  // flagged set for Haiku recheck
  const flagStatuses = new Set(['suspect', 'dead', ...(INCLUDE_EMPTY ? ['empty'] : [])]);
  const flagged = results.filter((r) => flagStatuses.has(r.status));
  writeFileSync(FLAGGED, flagged.map((r) => r.name).join('\n') + (flagged.length ? '\n' : ''));

  if (JSON_OUT) {
    console.log(JSON.stringify({ at: stamp, total: results.length, results, flagged: flagged.map((r) => r.name) }, null, 2));
    return;
  }

  // human report — lead with the flagged ones (the actionable part)
  const by = {};
  for (const r of results) by[r.status] = (by[r.status] || 0) + 1;

  const print = (r) => {
    const head = `  ${ICON[r.status] || '·'} ${r.name}${r.provider ? ` [${r.provider}]` : ''}`;
    if (r.status === 'suspect') {
      console.log(`${head} — ${r.note || `${r.jobs} jobs, 0 game-shaped`}`);
      console.log(`      e.g. ${(r.samples || []).slice(0, 3).map((s) => `“${s}”`).join(', ')}`);
    } else if (r.status === 'dead') {
      console.log(`${head} — ${r.note}`);
    } else if (r.status === 'empty') {
      console.log(`${head} — feed live, 0 jobs`);
    } else if (r.status === 'lean') {
      console.log(`${head} — ${r.jobs} non-game role(s): ${(r.samples || []).slice(0, 2).map((s) => `“${s}”`).join(', ')}`);
    } else if (r.status === 'ok') {
      console.log(`${head} — ${r.jobs} jobs (${r.gameHits} game-shaped)`);
    } else {
      console.log(`${head} — ${r.note || r.status}`);
    }
  };

  for (const status of ['suspect', 'dead', 'empty', 'blocked', 'throttled', 'lean', 'no-provider', 'ok']) {
    const group = results.filter((r) => r.status === status);
    if (!group.length) continue;
    if (status === 'ok') { console.log(`\n  ✅ ok: ${group.length} studios feed live with game roles`); continue; }
    if (status === 'lean') { console.log(`\n  ── lean (${group.length}) — live, few non-game roles, not flagged ──`); for (const r of group) print(r); continue; }
    console.log(`\n  ── ${status} (${group.length}) ──`);
    for (const r of group) print(r);
  }

  console.log(`\n  ── summary ──`);
  console.log('  ' + Object.entries(by).map(([k, n]) => `${k}: ${n}`).join('  ·  '));
  console.log(`  flagged for recheck: ${flagged.length}  → data/wiring-flagged.txt`);
  console.log(`  full audit: data/wiring-audit.jsonl`);
  console.log(`  next: node resolve-batch.mjs --from-audit   (Haiku re-checks only the flagged)\n`);
}

const ICON = { suspect: '🟠', dead: '🔴', empty: '⚪', blocked: '🚫', throttled: '🟡', lean: '🟢', 'no-provider': '·', ok: '✅' };

main().catch((e) => { console.error(e); process.exit(1); });
