#!/usr/bin/env node

/**
 * rank.mjs — Deterministic, zero-token pre-ranker for the job pipeline.
 *
 * Reads the same data files the scanner produces and scores every pending job
 * on three independent dimensions (location, role, seniority) using the weights
 * in portals.yml under `ranking:`. Writes a sorted list to data/ranked.md and
 * prints the top results to stdout.
 *
 * This is SURFACE fit only — it never reads cv.md. Deep, CV-aware match is the
 * LLM step (`/career-ops pipeline`). rank.mjs is the cheap triage that decides
 * WHICH jobs are worth that expensive step, and in what order.
 *
 * Compositional by design: it imports nothing from scan.mjs and writes only its
 * own artifact (data/ranked.md). It shares the data format, not code. Every
 * scoring function below is pure and exported, so it can be unit-tested or
 * reused without running the CLI.
 *
 * Usage:
 *   node rank.mjs                 # rank pipeline, write data/ranked.md, print top 15
 *   node rank.mjs --top 30        # print the top 30 instead
 *   node rank.mjs --all           # print every job
 *   node rank.mjs --dry-run       # print only, don't write data/ranked.md
 */

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { fileURLToPath } from 'url';
import yaml from 'js-yaml';

// ── Paths & defaults ────────────────────────────────────────────────

const PORTALS_PATH = 'portals.yml';
const PIPELINE_PATH = 'data/pipeline.md';
const SCAN_HISTORY_PATH = 'data/scan-history.tsv';
const RANKED_PATH = 'data/ranked.md';

// Used only if portals.yml has no `ranking:` block, so rank.mjs runs standalone.
const DEFAULT_RANKING = {
  location: { Remote: 0.8, default: 0.3 },
  role: { default: 0.5 },
  seniority: { default: 0.7 },
  weights: { location: 0.4, role: 0.4, seniority: 0.2 },
};

// ── Pure scoring core ───────────────────────────────────────────────

/**
 * Reduce the weights of all keywords that matched a category into one score.
 *   max      — highest match wins; extra matches ignored (no emergent math)
 *   min      — lowest match wins; any disliked keyword drags the score down
 *   multiply — product of every match (compounds; double-matches get penalized)
 *   average  — mean of every match
 */
export function combineWeights(weights, mode = 'max') {
  switch (mode) {
    case 'min': return Math.min(...weights);
    case 'multiply': return weights.reduce((a, b) => a * b, 1);
    case 'average': return weights.reduce((a, b) => a + b, 0) / weights.length;
    case 'max':
    default: return Math.max(...weights);
  }
}

/**
 * Build the RegExp for a key, case-insensitive. Two modes:
 *
 *   1. Regex escape hatch — if the key is wrapped in slashes, it's used as a
 *      raw regex: "/programm(er|ing)/" or "/\\bui\\b/" for exact control.
 *      Trailing flags are honored ("i" is always added).
 *
 *   2. Word-stem (default) — the key must START a word, but the end is open, so
 *      "Program" matches Programmer / Programming / Programmers, while "UI"
 *      still never matches "build" or "guild" (no word there begins with "ui").
 *      Symbols work ("C++", "UI/UX"); the key is trimmed so stray spaces in
 *      config can't change anything.
 *
 * Returns null for an empty or invalid-regex key (never throws).
 */
export function keyToRegExp(key) {
  const trimmed = String(key).trim();
  if (!trimmed) return null;
  const raw = trimmed.match(/^\/(.+)\/([a-z]*)$/i);
  if (raw) {
    try {
      const flags = raw[2].includes('i') ? raw[2] : raw[2] + 'i';
      return new RegExp(raw[1], flags);
    } catch {
      return null;
    }
  }
  const escaped = trimmed.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?<![A-Za-z0-9])${escaped}`, 'i');
}

/**
 * First match span of `key` in `text` as {start, end}, or null. The span covers
 * only the matched text (the key for a stem, the regex match for a regex key) —
 * used by scoreCategory to resolve overlaps via maximal munch.
 */
export function matchSpan(text, key) {
  const re = keyToRegExp(key);
  if (!re) return null;
  const m = re.exec(String(text || ''));
  return m ? { start: m.index, end: m.index + m[0].length } : null;
}

/** Boolean convenience wrapper around matchSpan. */
export function matchesKeyword(text, key) {
  return matchSpan(text, key) !== null;
}

/**
 * Score one piece of text against a {keyword: weight, default: weight} map.
 *
 * Matching is MAXIMAL MUNCH: every key's match span is found, then resolved
 * longest-first — a longer, more specific key claims its span and any shorter
 * key overlapping it is suppressed. So with both "Engineer" and "Engine"
 * defined, "Gameplay Engineer" counts only Engineer (Engine is swallowed),
 * while "Unreal Engine" still counts Engine. The surviving, non-overlapping
 * matches are then reduced via `combine` (see combineWeights). Returns
 * { score, matched } where `matched` lists the survivors (or 'default').
 */
export function scoreCategory(text, map, combine = 'max') {
  const candidates = [];
  for (const [key, weight] of Object.entries(map)) {
    if (key === 'default') continue;
    if (typeof weight !== 'number') continue;
    const span = matchSpan(text, key);
    if (span) candidates.push({ key, weight, ...span });
  }
  if (candidates.length === 0) {
    const fallback = typeof map.default === 'number' ? map.default : 0;
    return { score: fallback, matched: 'default' };
  }

  // Longest span first (tiebreak: longer key text); each claims its span and
  // suppresses any later candidate that overlaps it.
  candidates.sort((a, b) => b.end - b.start - (a.end - a.start) || b.key.length - a.key.length);
  const claimed = [];
  const kept = [];
  for (const c of candidates) {
    if (!claimed.some(([s, e]) => c.start < e && c.end > s)) {
      claimed.push([c.start, c.end]);
      kept.push(c);
    }
  }
  kept.sort((a, b) => a.start - b.start); // readable left-to-right `matched`

  return {
    score: combineWeights(kept.map((k) => k.weight), combine),
    matched: kept.map((k) => k.key).join(' + '),
  };
}

/** Normalize a {key: number} weight map so the values sum to 1. */
export function normalizeWeights(weights) {
  const entries = Object.entries(weights).filter(([, v]) => typeof v === 'number' && v > 0);
  const total = entries.reduce((s, [, v]) => s + v, 0);
  if (total === 0) return Object.fromEntries(entries.map(([k]) => [k, 0]));
  return Object.fromEntries(entries.map(([k, v]) => [k, v / total]));
}

/**
 * Score a single job {title, location} against a ranking config.
 * Returns the job enriched with per-dimension scores and a combined `fit`.
 */
export function scoreJob(job, ranking) {
  const w = normalizeWeights(ranking.weights || DEFAULT_RANKING.weights);
  const combine = ranking.combine || 'max';
  const location = scoreCategory(job.location, ranking.location || {}, combine);
  const role = scoreCategory(job.title, ranking.role || {}, combine);
  const seniority = scoreCategory(job.title, ranking.seniority || {}, combine);
  const fit =
    (w.location || 0) * location.score +
    (w.role || 0) * role.score +
    (w.seniority || 0) * seniority.score;
  return { ...job, location_score: location, role_score: role, seniority_score: seniority, fit };
}

/** Score and sort a list of jobs, highest fit first. Stable for equal fits. */
export function rankJobs(jobs, ranking) {
  return jobs
    .map((j) => scoreJob(j, ranking))
    .sort((a, b) => b.fit - a.fit || a.company.localeCompare(b.company));
}

// ── Data loading (impure, isolated from the scoring core) ────────────

/** Parse pipeline.md checkbox lines: `- [ ] {url} | {company} | {title}`. */
export function parsePipeline(markdown) {
  const jobs = [];
  for (const line of markdown.split('\n')) {
    const m = line.match(/^\s*-\s*\[[ xX]?\]\s*(.+)$/);
    if (!m) continue;
    const parts = m[1].split(' | ');
    if (parts.length < 3) continue;
    const [url, company, ...rest] = parts;
    jobs.push({ url: url.trim(), company: company.trim(), title: rest.join(' | ').trim() });
  }
  return jobs;
}

/** Build a url -> location lookup from scan-history.tsv (7th column). */
export function loadLocations(tsv) {
  const lookup = new Map();
  const lines = tsv.trim().split('\n');
  for (const line of lines.slice(1)) {
    const cols = line.split('\t');
    if (cols.length >= 7 && cols[0]) lookup.set(cols[0], cols[6] || '');
  }
  return lookup;
}

/**
 * Read the ranking config from portals.yml, or fall back to defaults.
 * Prefers the unified `targeting:` block (same shape: location/role/seniority/
 * combine/weights, plus 0-weight excludes that scoreCategory handles natively);
 * falls back to the legacy `ranking:` block, then to built-in defaults.
 */
export function loadRanking(portalsPath = PORTALS_PATH) {
  if (!existsSync(portalsPath)) return DEFAULT_RANKING;
  const config = yaml.load(readFileSync(portalsPath, 'utf-8')) || {};
  return config.targeting || config.ranking || DEFAULT_RANKING;
}

// ── Rendering ───────────────────────────────────────────────────────

const pct = (n) => `${(n * 100).toFixed(0)}%`;

// Escape characters that would break a markdown table cell — chiefly the pipe,
// which several job titles contain (e.g. "Gameplay Programmer | Programmeur").
const cell = (s) => String(s ?? '').replace(/\|/g, '\\|').replace(/\s+/g, ' ').trim();

function renderTable(ranked) {
  const rows = ranked.map((j, i) => {
    const fit = j.fit.toFixed(3);
    const loc = cell(`${pct(j.location_score.score)} ${j.location_score.matched}`);
    const role = cell(`${pct(j.role_score.score)} ${j.role_score.matched}`);
    const sen = cell(`${pct(j.seniority_score.score)} ${j.seniority_score.matched}`);
    return `| ${i + 1} | ${fit} | ${cell(j.company)} | ${cell(j.title)} | ${cell(j.location) || '—'} | ${loc} | ${role} | ${sen} |`;
  });
  return [
    '| # | Fit | Company | Role | Location | Loc match | Role match | Lvl match |',
    '|---|-----|---------|------|----------|-----------|------------|-----------|',
    ...rows,
  ].join('\n');
}

function renderRankedFile(ranked, date) {
  return [
    '# Ranked Pipeline',
    '',
    `_Deterministic surface-fit ranking — generated by rank.mjs on ${date}._`,
    '_Weights live in portals.yml under `ranking:`. This does NOT read your CV;',
    'run `/career-ops pipeline` for deep, CV-aware evaluation of the top picks._',
    '',
    renderTable(ranked),
    '',
  ].join('\n');
}

// ── CLI ─────────────────────────────────────────────────────────────

function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const showAll = args.includes('--all');
  const topIdx = args.indexOf('--top');
  const top = topIdx !== -1 ? parseInt(args[topIdx + 1], 10) || 15 : 15;

  if (!existsSync(PIPELINE_PATH)) {
    console.error(`No pipeline found at ${PIPELINE_PATH}. Run scan.mjs first.`);
    process.exit(1);
  }

  const ranking = loadRanking();
  const jobs = parsePipeline(readFileSync(PIPELINE_PATH, 'utf-8'));
  if (jobs.length === 0) {
    console.log('Pipeline is empty — nothing to rank.');
    return;
  }

  const locations = existsSync(SCAN_HISTORY_PATH)
    ? loadLocations(readFileSync(SCAN_HISTORY_PATH, 'utf-8'))
    : new Map();
  for (const job of jobs) job.location = locations.get(job.url) || '';

  const ranked = rankJobs(jobs, ranking);
  const date = new Date().toISOString().slice(0, 10);

  if (!dryRun) {
    writeFileSync(RANKED_PATH, renderRankedFile(ranked, date), 'utf-8');
  }

  const shown = showAll ? ranked : ranked.slice(0, top);
  console.log(`\nRanked ${ranked.length} pipeline jobs by surface fit (location · role · seniority)\n`);
  console.log(renderTable(shown));
  if (!showAll && ranked.length > shown.length) {
    console.log(`\n… ${ranked.length - shown.length} more. Use --all to see them.`);
  }
  if (!dryRun) console.log(`\nFull ranking written to ${RANKED_PATH}`);
  console.log('→ Run /career-ops pipeline to deep-evaluate the top picks against your CV.');
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main();
}
