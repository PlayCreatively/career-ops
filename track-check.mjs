#!/usr/bin/env node

/**
 * track-check.mjs — Zero-token "do we already track this company?" lookup.
 *
 * Before the agent spends tokens researching a company (in scan / resolve /
 * pipeline), it asks this script. Pure string matching over studios.yml +
 * data/ats-research.md — no LLM, no network.
 *
 * Usage:
 *   node track-check.mjs "Naughty Dog"
 *   node track-check.mjs "Some Studio" --url somestudio.com
 *   node track-check.mjs --json "Riot Games"     # machine output (default is also JSON)
 *
 * Output (JSON to stdout):
 *   {
 *     "query": "naughty dog",
 *     "tracked": true,                # true = already scannable in studios.yml
 *     "status": "tracked"|"backlog"|"unknown",
 *     "matches": [ { name, source, provider, kind, scannable } ],
 *     "suggestion": "..."             # what the agent should do next
 *   }
 *
 * Exit code: 0 always (a "not found" is a valid answer, not an error).
 */

import { readFileSync, existsSync } from 'fs';
import { fileURLToPath } from 'url';
import yaml from 'js-yaml';

const STUDIOS_PATH = process.env.CAREER_OPS_STUDIOS || 'studios.yml';
const RESEARCH_PATH = 'data/ats-research.md';

const SCANNABLE_RECIPE_KINDS = new Set(['json', 'html']);
const TAG_RECIPE_KINDS = new Set(['blocked', 'browser', 'unresolved']);

// Company-name suffixes that don't help identity matching. "Naughty Dog" and
// "Naughty Dog Studios" should collide; so should "CD Projekt" / "CD Projekt Red".
const NAME_NOISE = new Set([
  'studio', 'studios', 'games', 'game', 'interactive', 'entertainment', 'entertaiment',
  'inc', 'llc', 'ltd', 'limited', 'corp', 'company', 'co', 'gmbh', 'ab', 'oy', 'as',
  'bv', 'sa', 'srl', 'sl', 'group', 'the', 'productions', 'media',
]);

export function normalizeName(name) {
  return String(name || '')
    .toLowerCase()
    .normalize('NFKD').replace(/[̀-ͯ]/g, '')   // strip diacritics
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(w => w && !NAME_NOISE.has(w))
    .join(' ')
    .trim();
}

// Registrable-ish domain: drop scheme/path/port and a leading www/jobs/careers host label.
export function normalizeDomain(value) {
  if (!value) return '';
  let host = String(value).trim().toLowerCase();
  host = host.replace(/^[a-z]+:\/\//, '').split('/')[0].split('?')[0].split(':')[0];
  const parts = host.split('.').filter(Boolean);
  return parts.slice(-2).join('.');   // example.com from careers.example.com
}

function entryDomains(entry) {
  const urls = [entry.careers_url, entry.api, entry.recipe?.endpoint, entry.feed_url].filter(Boolean);
  return new Set(urls.map(normalizeDomain).filter(Boolean));
}

// Classify how a studios.yml entry is wired: scannable now, or a backlog tag.
function classifyEntry(entry) {
  if (entry.recipe && typeof entry.recipe === 'object') {
    const kind = entry.recipe.kind;
    if (SCANNABLE_RECIPE_KINDS.has(kind)) return { provider: 'custom', kind, scannable: true };
    if (TAG_RECIPE_KINDS.has(kind)) return { provider: 'custom', kind, scannable: false };
  }
  if (entry.parser?.command) return { provider: 'local-parser', kind: 'parser', scannable: true };
  if (entry.provider) return { provider: entry.provider, kind: 'ats', scannable: true };
  if (entry.api || entry.careers_url) return { provider: 'auto-detect', kind: 'ats', scannable: true };
  if (entry.status) return { provider: null, kind: String(entry.status), scannable: false };
  return { provider: null, kind: 'unresolved', scannable: false };
}

function loadStudios() {
  if (!existsSync(STUDIOS_PATH)) return [];
  const doc = yaml.load(readFileSync(STUDIOS_PATH, 'utf-8')) || {};
  return Array.isArray(doc.tracked_companies) ? doc.tracked_companies : [];
}

// Best-effort name harvest from the research queue: checkbox bullets and table rows.
function loadResearchNames() {
  if (!existsSync(RESEARCH_PATH)) return [];
  const text = readFileSync(RESEARCH_PATH, 'utf-8');
  const names = [];
  for (const m of text.matchAll(/^\s*- \[[ x]\]\s+([^(—\n|]+?)(?:\s*[(—|]|$)/gm)) {
    names.push(m[1].trim());
  }
  for (const m of text.matchAll(/^\|\s*([A-Z][^|]+?)\s*\|/gm)) {
    const n = m[1].trim();
    if (n && !/^studio$/i.test(n)) names.push(n);
  }
  return names;
}

export function checkCompany(query, queryUrl, { studios = loadStudios(), researchNames = loadResearchNames() } = {}) {
  const qn = normalizeName(query);
  const qd = normalizeDomain(queryUrl);
  const matches = [];

  for (const entry of studios) {
    if (!entry || typeof entry !== 'object' || !entry.name) continue;
    const nameHit = qn && normalizeName(entry.name) === qn;
    const domainHit = qd && entryDomains(entry).has(qd);
    if (!nameHit && !domainHit) continue;
    const cls = classifyEntry(entry);
    matches.push({
      name: entry.name,
      source: 'studios.yml',
      matched_on: nameHit ? 'name' : 'domain',
      provider: cls.provider,
      kind: cls.kind,
      scannable: cls.scannable,
    });
  }

  // Only consult the research queue if studios.yml had no hit (it's the backlog).
  if (matches.length === 0 && qn) {
    for (const rn of researchNames) {
      if (normalizeName(rn) === qn) {
        matches.push({ name: rn.trim(), source: 'ats-research.md', matched_on: 'name', provider: null, kind: 'backlog', scannable: false });
        break;
      }
    }
  }

  const scannable = matches.some(m => m.scannable);
  const inBacklog = matches.length > 0 && !scannable;
  const status = scannable ? 'tracked' : inBacklog ? 'backlog' : 'unknown';

  let suggestion;
  if (scannable) suggestion = 'Already scannable — skip research; scan.mjs covers it.';
  else if (inBacklog) suggestion = 'Known but unresolved — run /career-ops resolve to assign a provider/recipe, or update the existing entry. Do NOT add a duplicate.';
  else suggestion = 'Not tracked — safe to research and add a new studios.yml entry.';

  return { query: qn, query_domain: qd || null, tracked: scannable, status, matches, suggestion };
}

// ── CLI ─────────────────────────────────────────────────────────────

function main() {
  const args = process.argv.slice(2).filter(a => a !== '--json');
  const urlFlag = args.indexOf('--url');
  let queryUrl = '';
  if (urlFlag !== -1) {
    queryUrl = args[urlFlag + 1] || '';
    args.splice(urlFlag, 2);
  }
  const query = args.join(' ').trim();
  if (!query && !queryUrl) {
    console.error('Usage: node track-check.mjs "Company Name" [--url domain.com]');
    process.exit(2);
  }
  console.log(JSON.stringify(checkCompany(query, queryUrl), null, 2));
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1] === fileURLToPath(import.meta.url)) {
  main();
}
