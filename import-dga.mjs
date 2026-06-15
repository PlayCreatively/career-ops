#!/usr/bin/env node

/**
 * import-dga.mjs — Tokenless bulk-import of Dutch game studios from the Dutch
 * Games Association "Dutch Game Industry Directory" JSON API into studios.yml as
 * `status: unresolved` backlog entries (deduped). Zero LLM tokens: a plain JSON
 * fetch + field mapping. The Netherlands analogue to import-gdi.mjs (Sweden),
 * except the source is a clean API rather than a PDF.
 *
 *   Source: https://www.dutchgamesindustry.nl/api/companies  (no auth, ~506 rows)
 *   Docs:   https://www.dutchgamesindustry.nl/api/docs.html
 *
 * Each row carries name, city, province, size (headcount band), startYear,
 * endYear (defunct marker), websiteURL and (sometimes) a jobs page. We import
 * only ACTIVE studios (no endYear) and attach the company's OWN domain as a
 * `careers_url` hint so probe-studios.mjs can sweep it for a custom-domain ATS
 * (teamtailor/recruitee/personio on the studio's own host). We deliberately do
 * NOT use the directory's jobs link as careers_url: many point at a parent's
 * shared ATS board (e.g. a Focus Entertainment Recruitee board), which scan.mjs
 * would then pull wholesale under the wrong studio name. The real jobs page is
 * preserved in notes for the resolve pass.
 *
 * Because each entry is `status: unresolved`, scan.mjs skips it (no provider
 * resolves) and probe-studios/`resolve` walk it later — same lifecycle as the
 * GDI backlog.
 *
 * Usage:
 *   node import-dga.mjs --dry-run        # fetch + print, write nothing
 *   node import-dga.mjs                  # append new studios to studios.yml
 *   node import-dga.mjs --json F.json    # use a local API dump (skip fetch)
 *   node import-dga.mjs --all            # include defunct studios too (rare)
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import yaml from 'js-yaml';

const API_URL = 'https://www.dutchgamesindustry.nl/api/companies';
const STUDIOS = process.env.CAREER_OPS_STUDIOS || 'studios.yml';
const DRY = process.argv.includes('--dry-run');
const INCLUDE_DEFUNCT = process.argv.includes('--all');
const jsonFlag = process.argv.indexOf('--json');
const localJson = jsonFlag !== -1 ? process.argv[jsonFlag + 1] : null;

// Same normalisation track-check.mjs / probe-studios.mjs use, so dedup agrees.
function norm(s) {
  return String(s || '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .replace(/\b(ab|aktiebolag|inc|ltd|llc|gmbh|bv|hb|as|aps|oy|studios?|games?|interactive|entertainment|group|the|productions?|media)\b/g, '')
    .replace(/[^a-z0-9]+/g, '');
}

// Shared/portfolio hosts that are NOT a studio's own domain — attaching them as
// a careers_url hint would point the resolver at the wrong place. Solo devs in
// the directory often list one of these instead of an owned domain.
const SHARED_HOSTS = new Set([
  'artstation.com', 'itch.io', 'github.com', 'github.io', 'behance.net',
  'wixsite.com', 'linktr.ee', 'carrd.co', 'notion.site', 'ruhosting.nl',
  'courage.events', 'google.com', 'sites.google.com', 'facebook.com',
  'linkedin.com', 'gumroad.com', 'patreon.com', 'youtube.com',
]);

function registrableHost(url) {
  try {
    const h = new URL(url).hostname.toLowerCase().replace(/^www\./, '');
    if (SHARED_HOSTS.has(h)) return '';
    // also drop *.wixsite.com / *.github.io style subdomains
    if (/\.(wixsite\.com|github\.io|itch\.io|notion\.site)$/.test(h)) return '';
    return h;
  } catch { return ''; }
}

async function getRows() {
  if (localJson) {
    if (!existsSync(localJson)) throw new Error(`JSON not found: ${localJson}`);
    return JSON.parse(readFileSync(localJson, 'utf-8'));
  }
  console.error(`Fetching ${API_URL} ...`);
  const r = await fetch(API_URL, { headers: { 'User-Agent': 'Mozilla/5.0', accept: 'application/json' }, signal: AbortSignal.timeout(60000) });
  if (!r.ok) throw new Error(`fetch failed: ${r.status}`);
  return r.json();
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

function main(rows) {
  const arr = Array.isArray(rows) ? rows : (rows.companies || rows.data || []);
  const active = arr.filter(c => c && c.name && (INCLUDE_DEFUNCT || !c.endYear));
  const existing = loadExistingKeys();

  const fresh = [];
  const seen = new Set();
  let dupes = 0;
  for (const c of active) {
    const key = norm(c.name);
    if (!key) continue;
    if (existing.has(key) || seen.has(key)) { dupes++; continue; }
    seen.add(key);
    // Own-domain hint for the resolver; jobs page (if any) kept for context.
    const ownHost = registrableHost(c.websiteURL);
    fresh.push({
      name: String(c.name).trim(),
      careers_url: ownHost ? `https://${ownHost}/` : '',
      city: c.city || '',
      size: c.size || '',
      jobs: c.jobsURL || '',
    });
  }
  fresh.sort((a, b) => a.name.localeCompare(b.name));

  console.error(`\nDGA directory import (Dutch Game Industry Directory)`);
  console.error(`  rows in API:        ${arr.length}`);
  console.error(`  active:             ${active.length}`);
  console.error(`  already tracked:    ${dupes}`);
  console.error(`  NEW to add:         ${fresh.length}`);
  console.error(`  with domain hint:   ${fresh.filter(f => f.careers_url).length}`);

  if (DRY) {
    for (const f of fresh) console.log(`${f.name}${f.careers_url ? '  ·  ' + f.careers_url : ''}${f.city ? '  ·  ' + f.city : ''}`);
    console.error('\n(dry run — nothing written. Re-run without --dry-run to append.)');
    return;
  }
  if (fresh.length === 0) { console.error('Nothing new to add.'); return; }

  // Quote anything that isn't a plain-safe YAML scalar. Names starting with
  // &, *, !, etc. are YAML sigils (anchor/alias/tag) and MUST be quoted —
  // "&ranj" parsed as a null-valued anchor before this guard.
  const yamlStr = (s) => (/^[A-Za-z0-9][\w .,&'()/+-]*$/.test(s) ? s : JSON.stringify(s));
  const block = '\n  # ── DGA import (Dutch Game Industry Directory, dutchgamesassociation.nl) ──\n' +
    '  # Active NL studios, bulk-imported tokenlessly (import-dga.mjs).\n' +
    '  # status: unresolved → scan.mjs skips; careers_url = own domain hint for\n' +
    '  # probe-studios/`resolve`. Real jobs page (when known) is in notes.\n' +
    fresh.map(f => {
      const note = [
        'DGA directory',
        f.city ? f.city : null,
        f.size ? `~${f.size}` : null,
        f.jobs ? `jobs: ${f.jobs}` : null,
      ].filter(Boolean).join(' · ');
      let entry = `  - name: ${yamlStr(f.name)}\n    country: NL\n    status: unresolved\n`;
      if (f.careers_url) entry += `    careers_url: ${f.careers_url}\n`;
      entry += `    notes: ${JSON.stringify(note)}`;
      return entry;
    }).join('\n') + '\n';

  let file = readFileSync(STUDIOS, 'utf-8');
  if (!file.endsWith('\n')) file += '\n';
  writeFileSync(STUDIOS, file + block, 'utf-8');
  console.error(`Appended ${fresh.length} studios to ${STUDIOS}.`);
}

main(await getRows());
