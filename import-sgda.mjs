#!/usr/bin/env node

/**
 * import-sgda.mjs — Tokenless import of Swiss game studios from the SGDA (Swiss
 * Game Developers Association) public members page into studios.yml as
 * `status: unresolved` backlog entries (deduped). Zero LLM tokens: an HTML fetch
 * + regex over the member-list anchors.
 *
 *   Source: https://www.sgda.ch/members/
 *
 * Switzerland has no Game-Developer-Index-style report (no census PDF, no API),
 * so the SGDA members directory is the authoritative active-studio list — but
 * it's names-only (the member website links are JS-hydrated and absent from the
 * static HTML). We therefore import bare names; the `resolve` pass finds each
 * studio's site + ATS. ~48 members as of 2026.
 *
 * Usage:
 *   node import-sgda.mjs --dry-run       # fetch + print, write nothing
 *   node import-sgda.mjs                 # append new studios to studios.yml
 *   node import-sgda.mjs --html F.html   # use a local saved page (skip fetch)
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import yaml from 'js-yaml';

const MEMBERS_URL = 'https://www.sgda.ch/members/';
const STUDIOS = process.env.CAREER_OPS_STUDIOS || 'studios.yml';
const DRY = process.argv.includes('--dry-run');
const htmlFlag = process.argv.indexOf('--html');
const localHtml = htmlFlag !== -1 ? process.argv[htmlFlag + 1] : null;

function norm(s) {
  return String(s || '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .replace(/\b(ag|sa|sarl|sagl|gmbh|klg|llc|ltd|inc|studios?|games?|interactive|entertainment|group|the|productions?|media)\b/g, '')
    .replace(/[^a-z0-9]+/g, '');
}

function decodeEntities(s) {
  return s
    .replace(/&#0?39;/g, "'").replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&').replace(/&quot;/g, '"')
    .replace(/&#8211;/g, '–').replace(/&nbsp;/g, ' ').trim();
}

async function getHtml() {
  if (localHtml) {
    if (!existsSync(localHtml)) throw new Error(`HTML not found: ${localHtml}`);
    return readFileSync(localHtml, 'utf-8');
  }
  console.error(`Fetching ${MEMBERS_URL} ...`);
  const r = await fetch(MEMBERS_URL, { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(60000) });
  if (!r.ok) throw new Error(`fetch failed: ${r.status}`);
  return r.text();
}

function extractNames(html) {
  const re = /class="companyLink"[^>]*>([^<]+)<\/a>/g;
  const names = new Map(); // norm -> display
  let m;
  while ((m = re.exec(html))) {
    const name = decodeEntities(m[1]);
    const key = norm(name);
    if (key && !names.has(key)) names.set(key, name);
  }
  return names;
}

function loadExistingKeys() {
  const keys = new Set();
  if (!existsSync(STUDIOS)) return keys;
  const doc = yaml.load(readFileSync(STUDIOS, 'utf-8')) || {};
  for (const c of doc.tracked_companies || []) {
    if (c && c.name) keys.add(norm(c.name));
  }
  return keys;
}

function main(html) {
  const found = extractNames(html);
  const existing = loadExistingKeys();

  const fresh = [];
  let dupes = 0;
  for (const [key, name] of found) {
    if (existing.has(key)) { dupes++; continue; }
    fresh.push(name);
  }
  fresh.sort((a, b) => a.localeCompare(b));

  console.error(`\nSGDA members import (Swiss Game Developers Association)`);
  console.error(`  extracted (unique): ${found.size}`);
  console.error(`  already tracked:    ${dupes}`);
  console.error(`  NEW to add:         ${fresh.length}`);

  if (DRY) {
    console.log(fresh.join('\n'));
    console.error('\n(dry run — nothing written. Re-run without --dry-run to append.)');
    return;
  }
  if (fresh.length === 0) { console.error('Nothing new to add.'); return; }

  // Quote anything that isn't a plain-safe YAML scalar (leading &, *, ! etc.
  // are YAML sigils and must be quoted).
  const yamlStr = (s) => (/^[A-Za-z0-9][\w .,&'()/+-]*$/.test(s) ? s : JSON.stringify(s));
  const block = '\n  # ── SGDA import (Swiss Game Developers Association members) ──────────\n' +
    '  # Swiss active-studio directory, names-only (member site links are JS-only).\n' +
    '  # status: unresolved → scan.mjs skips; `resolve` finds site + ATS.\n' +
    fresh.map(n =>
      `  - name: ${yamlStr(n)}\n    country: CH\n    status: unresolved\n    notes: "SGDA member (Swiss Game Developers Association)."`
    ).join('\n') + '\n';

  let file = readFileSync(STUDIOS, 'utf-8');
  if (!file.endsWith('\n')) file += '\n';
  writeFileSync(STUDIOS, file + block, 'utf-8');
  console.error(`Appended ${fresh.length} studios to ${STUDIOS}.`);
}

main(await getHtml());
