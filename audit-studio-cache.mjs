// @ts-check
// audit-studio-cache — find studio badges whose IGDB name has nothing to do with
// the company we looked up.
//
//   node audit-studio-cache.mjs            list the bad matches
//   node audit-studio-cache.mjs --purge    drop them so the next enrich re-resolves
//
// Why this exists: IGDB's widen query is a raw substring match, so a short
// company name could land mid-word in an unrelated company ("HP" matched
// Sout(hP)eak Interactive) and win on catalogue size plus a country hint. The
// matcher in providers/igdb.mjs now refuses those, but entries resolved before
// the fix are still sitting in the cache — this finds and clears them.

import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { nameLooksRelated } from './providers/igdb.mjs';

const CACHE_PATH = fileURLToPath(new URL('./data/studio-cache.json', import.meta.url));
const STUDIOS_PATH = fileURLToPath(new URL('./site/data/studios.json', import.meta.url));

const purge = process.argv.includes('--purge');

async function readJson(path) {
  try { return JSON.parse(await readFile(path, 'utf8')); } catch { return null; }
}

const cache = (await readJson(CACHE_PATH)) || {};
const studios = (await readJson(STUDIOS_PATH)) || {};

// Every key we have an opinion about, from both files.
const keys = new Set([...Object.keys(cache), ...Object.keys(studios)].filter((k) => k !== '_token'));

const bad = [];
for (const key of keys) {
  const s = cache[key] || studios[key];
  if (!s || !s.name) continue;                       // a remembered miss is fine
  if (nameLooksRelated(s.name, key)) continue;
  bad.push({ key, matched: s.name, country: s.country || '?', games: (s.games || []).length });
}

bad.sort((a, b) => a.key.length - b.key.length || a.key.localeCompare(b.key));

if (!bad.length) {
  console.log(`\nChecked ${keys.size} cached studios. No unrelated matches.\n`);
} else {
  console.log(`\n${bad.length} unrelated match(es) out of ${keys.size} cached studios:\n`);
  for (const b of bad) {
    console.log(`  "${b.key}"  ->  ${b.matched}  (${b.country}, ${b.games} games)`);
  }
  if (purge) {
    for (const b of bad) { delete cache[b.key]; delete studios[b.key]; }
    await writeFile(CACHE_PATH, JSON.stringify(cache, null, 0));
    await writeFile(STUDIOS_PATH, JSON.stringify(studios, null, 0));
    console.log(`\nPurged ${bad.length} from the cache and the board.`);
    console.log('Re-resolve with: node studio-info.mjs --board\n');
  } else {
    console.log('\nRun with --purge to drop these, then re-run node studio-info.mjs --board\n');
  }
}
