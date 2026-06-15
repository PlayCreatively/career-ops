#!/usr/bin/env node

/**
 * import-gdi.mjs — Tokenless bulk-import of Swedish studios from the
 * Dataspelsbranschen "Game Developer Index 2025" PDF company directory into
 * studios.yml as `status: unresolved` backlog entries (deduped). Zero LLM tokens:
 * pure pdftotext + string heuristics.
 *
 * Requires `pdftotext` (poppler) on PATH.
 *
 * Usage:
 *   node import-gdi.mjs --dry-run      # extract + print, write nothing
 *   node import-gdi.mjs                # append new studios to studios.yml
 *   node import-gdi.mjs --pdf F.pdf    # use a local PDF (skip download)
 *
 * The directory is a multi-column, region-grouped list. We split each line into
 * cells (runs of 2+ spaces) and keep cells that look like a company name —
 * precision over recall: better to miss a bare-name studio (addable later) than
 * pollute the list with Swedish city/county headers or prose.
 */

import { readFileSync, writeFileSync, existsSync, mkdtempSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import yaml from 'js-yaml';

const PDF_URL = 'https://www.dataspelsbranschen.se/wp-content/uploads/2026/01/Game-Developer-Index-2025-ENG-WEB.pdf';
const STUDIOS = process.env.CAREER_OPS_STUDIOS || 'studios.yml';
const DRY = process.argv.includes('--dry-run');
const pdfFlag = process.argv.indexOf('--pdf');
const localPdf = pdfFlag !== -1 ? process.argv[pdfFlag + 1] : null;

// Accept ONLY cells carrying a legal-form suffix (AB / Aktiebolag / …). In the
// GDI this is the directory's signal: ~976 such cells, all inside the company
// index (lines ~1189–1929), zero in the surrounding magazine prose. A keyword
// rule (Games/Studio/…) was tried and rejected — it pulled headings/captions
// ("Published by The Swedish Games Industry", "by Hazelight Studios"). Precision
// over recall: a handful of suffix-less studios (Grapefrukt, Confoxing) are
// missed and can be added by hand later.
const LEGAL = /\s+(AB|Aktiebolag|HB|AS|ApS|Oy|Ltd|Inc|LLC|GmbH)\.?$/i;

// Same normalisation track-check.mjs / probe-studios.mjs use, so dedup agrees.
function norm(s) {
  return String(s || '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .replace(/\b(ab|aktiebolag|inc|ltd|llc|gmbh|hb|as|aps|oy|studios?|games?|interactive|entertainment|group|the|productions?|media)\b/g, '')
    .replace(/[^a-z0-9]+/g, '');
}

function looksLikeCompany(cell) {
  const c = cell.trim();
  if (c.length < 3 || c.length > 45) return false;
  if (c.includes('�')) return false;          // corrupted Swedish glyph — skip
  if (/[.,;:!?()/]/.test(c)) return false;          // prose / addresses
  if (/\d/.test(c)) return false;                   // county headers carry page numbers
  if (c === c.toUpperCase()) return false;          // ALL-CAPS county header
  if (c.split(/\s+/).length > 6) return false;      // a sentence, not a name
  return LEGAL.test(c);
}

function cleanName(cell) {
  let n = cell.trim();
  n = n.split(/\s+[–—-]\s+/)[0];   // "Studio – Game Title" → drop the title
  n = n.split(/\s+&\s+/)[0];       // "A & B" merged columns → first company
  n = n.split(/\s+och\s+/i)[0];    // Swedish "and"
  return n.replace(LEGAL, '').replace(/\s+/g, ' ').trim();
}

function getPdfText() {
  let pdfPath = localPdf;
  const dir = mkdtempSync(join(tmpdir(), 'gdi-'));
  if (!pdfPath) {
    // Node fetch → temp file (download once).
    pdfPath = join(dir, 'gdi.pdf');
    console.error(`Downloading ${PDF_URL} ...`);
    const buf = execFileSync(process.execPath, ['--input-type=module', '-e',
      `const r=await fetch(${JSON.stringify(PDF_URL)},{headers:{'User-Agent':'Mozilla/5.0'}});` +
      `process.stdout.write(Buffer.from(await r.arrayBuffer()));`],
      { maxBuffer: 64 * 1024 * 1024 });
    writeFileSync(pdfPath, buf);
  }
  if (!existsSync(pdfPath)) throw new Error(`PDF not found: ${pdfPath}`);
  const txt = join(dir, 'gdi.txt');
  execFileSync('pdftotext', ['-layout', '-enc', 'UTF-8', pdfPath, txt]);
  return readFileSync(txt, 'utf-8');
}

function extractCompanies(text) {
  const found = new Map(); // norm -> display name
  for (const line of text.split('\n')) {
    for (const cell of line.split(/\s{2,}/)) {
      if (!looksLikeCompany(cell)) continue;
      const name = cleanName(cell);
      if (name.length < 3) continue;
      const key = norm(name);
      if (key && !found.has(key)) found.set(key, name);
    }
  }
  return found;
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

function main() {
  const text = getPdfText();
  const found = extractCompanies(text);
  const existing = loadExistingKeys();

  const fresh = [];
  let dupes = 0;
  for (const [key, name] of found) {
    if (existing.has(key)) { dupes++; continue; }
    fresh.push(name);
  }
  fresh.sort((a, b) => a.localeCompare(b));

  console.error(`\nGDI 2025 import`);
  console.error(`  extracted (unique): ${found.size}`);
  console.error(`  already tracked:    ${dupes}`);
  console.error(`  NEW to add:         ${fresh.length}`);

  if (DRY) {
    console.log(fresh.join('\n'));
    console.error('\n(dry run — nothing written. Re-run without --dry-run to append.)');
    return;
  }
  if (fresh.length === 0) { console.error('Nothing new to add.'); return; }

  const block = '\n  # ── GDI 2025 import (Dataspelsbranschen Game Developer Index) ──────\n' +
    '  # Swedish-industry directory, bulk-imported tokenlessly (import-gdi.mjs).\n' +
    '  # status: unresolved → scan.mjs skips; /career-ops resolve walks them.\n' +
    fresh.map(n =>
      `  - name: ${/[:#]/.test(n) ? JSON.stringify(n) : n}\n    country: SE\n    status: unresolved\n    notes: "GDI 2025 (Dataspelsbranschen)."`
    ).join('\n') + '\n';

  let file = readFileSync(STUDIOS, 'utf-8');
  if (!file.endsWith('\n')) file += '\n';
  writeFileSync(STUDIOS, file + block, 'utf-8');
  console.error(`Appended ${fresh.length} studios to ${STUDIOS}.`);
}

main();
