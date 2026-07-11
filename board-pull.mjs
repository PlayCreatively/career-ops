// @ts-check
// board-pull — download the already-built board data from the LIVE published
// site into site/data/, so you can run the local board without scanning and
// without any IGDB credentials. The online board (GitHub Pages) rebuilds every
// day and enriches studios with IGDB context; this just mirrors that output.
//
//   node board-pull.mjs                 pull from your fork's Pages URL
//   node board-pull.mjs <base-url>      pull from an explicit .../data URL
//   BOARD_URL=... node board-pull.mjs   same, via env
//
// The base URL is derived from `git remote origin` as
//   https://<owner>.github.io/<repo>/data
// which is where board.yml deploys. Override it if your Pages URL differs
// (custom domain, org site, etc.).
//
// Every file is best-effort: a 404 (e.g. studios.json before the first enriched
// deploy) is skipped with a note, not a failure. After pulling, run
// `npm run board:dev` to serve the board locally.

import { execSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

// Files the board serves under /data. jobs + targeting are what the board needs
// to render; studios + misses are the IGDB context/negative-cache; health is the
// per-company failure tally. All optional — take whatever the live site has.
const FILES = ['jobs.json', 'targeting.json', 'studios.json', 'studio-misses.json', 'health.json'];

const DATA_DIR = fileURLToPath(new URL('./site/data/', import.meta.url));

function baseUrl() {
  const arg = process.argv[2];
  if (arg && !arg.startsWith('--')) return arg.replace(/\/+$/, '');
  if (process.env.BOARD_URL) return process.env.BOARD_URL.replace(/\/+$/, '');
  let origin;
  try {
    origin = execSync('git remote get-url origin', { encoding: 'utf8' }).trim();
  } catch {
    throw new Error('No git remote "origin" found. Pass the board data URL explicitly:\n  node board-pull.mjs https://<owner>.github.io/<repo>/data');
  }
  const m = origin.match(/github\.com[:/]([^/]+)\/([^/.]+)/);
  if (!m) throw new Error(`Could not parse a GitHub owner/repo from origin: ${origin}\nPass the URL explicitly:\n  node board-pull.mjs https://<owner>.github.io/<repo>/data`);
  const owner = m[1].toLowerCase(); // github.io subdomain is always lowercase
  const repo = m[2];
  return `https://${owner}.github.io/${repo}/data`;
}

function kb(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

async function main() {
  const base = baseUrl();
  console.log(`Pulling board data from ${base}\n`);
  await mkdir(DATA_DIR, { recursive: true });

  let got = 0, missing = 0;
  for (const f of FILES) {
    const url = `${base}/${f}`;
    let res;
    try {
      res = await fetch(url);
    } catch (e) {
      console.log(`  ✗ ${f.padEnd(20)} network error (${e.message}) — skipped`);
      missing++;
      continue;
    }
    if (res.status === 404) {
      console.log(`  – ${f.padEnd(20)} not published yet (404) — skipped`);
      missing++;
      continue;
    }
    if (!res.ok) {
      console.log(`  ✗ ${f.padEnd(20)} HTTP ${res.status} — skipped`);
      missing++;
      continue;
    }
    const buf = Buffer.from(await res.arrayBuffer());
    await writeFile(new URL(f, `file://${DATA_DIR}`), buf);
    console.log(`  ✓ ${f.padEnd(20)} ${kb(buf.length)}`);
    got++;
  }

  console.log(`\nPulled ${got} file(s)${missing ? `, ${missing} unavailable` : ''} → site/data/`);
  if (got) console.log('Run `npm run board:dev` to serve the board locally (no scan, no IGDB creds needed).');
  else console.log('Nothing pulled. Is GitHub Pages enabled for this repo, and has the board deployed at least once?');
}

main().catch((e) => { console.error(`\n  ${e.message}\n`); process.exit(1); });
