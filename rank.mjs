#!/usr/bin/env node

/**
 * rank.mjs — Deterministic, zero-token pre-ranker for the job pipeline.
 *
 * Ranks the board's fresh scan snapshot (`site/data/jobs.json`) — the SAME data
 * the local/public web board scores — using the `targeting:` weights in
 * portals.yml (identical to the board's projected targeting.local.json). So
 * data/ranked.md is a faithful CLI mirror of the web board, not a second source
 * of truth. The board snapshot is the ONLY input: regenerate it with
 * `npm run board:refresh` (which then runs this). Writes a sorted list to
 * data/ranked.md and prints the top results to stdout.
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
 *   node rank.mjs                 # rank board snapshot, write data/ranked.md, print top 15
 *   node rank.mjs --top 30        # print the top 30 instead
 *   node rank.mjs --all           # print every job
 *   node rank.mjs --dry-run       # print only, don't write data/ranked.md
 */

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { fileURLToPath } from 'url';
import yaml from 'js-yaml';

// ── Paths & defaults ────────────────────────────────────────────────

const PORTALS_PATH = 'portals.yml';
const BOARD_JOBS_PATH = 'site/data/jobs.json';
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
 *      regex: "/programm(er|ing)/" or "/(game|tools?) engineer/". Trailing flags
 *      are honored ("i" is always added). Two ergonomic DEFAULTS are applied so
 *      the common case stays terse — the boilerplate is appended for you:
 *        • a literal space means "whitespace separator" → compiled as \s+
 *          (so it also tolerates tabs / multiple spaces);
 *        • a leading word boundary \b is implied when the pattern opens on a
 *          word char or a "(" group — so "/(game|engine) engineer/" behaves
 *          exactly like "/\b(game|engine)\s+engineer/".
 *      A pattern that opens with its own anchor (^, \b, \B, a lookaround, or any
 *      backslash-escape) is left untouched, so you can still opt out.
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
    // Apply the ergonomic defaults (see doc above): literal spaces → \s+, and an
    // implied leading \b unless the pattern already opens with its own anchor.
    let body = raw[1].replace(/ +/g, '\\s+');
    if (/^[\w(]/.test(body)) body = '\\b' + body;
    try {
      const flags = raw[2].includes('i') ? raw[2] : raw[2] + 'i';
      return new RegExp(body, flags);
    } catch {
      return null;
    }
  }
  const escaped = trimmed.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // The (?<![A-Za-z0-9]) guard is a left word-boundary so a bare keyword ("SE")
  // can't match mid-word ("USERS"). It only makes sense when the keyword STARTS
  // with an alphanumeric; for one opening with punctuation (", SE") it would
  // demand a non-alphanumeric BEFORE that punctuation and so never match real
  // text like "Stockholm, SE". Skip the guard in that case.
  const guard = /^[A-Za-z0-9]/.test(trimmed) ? '(?<![A-Za-z0-9])' : '';
  return new RegExp(`${guard}${escaped}`, 'i');
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

// ── Group-model scoring (the unified scorer) ─────────────────────────
// The schema the in-browser board uses, now shared by Node. A `targeting.groups`
// array replaces the flat location/role/seniority/company maps:
//
//   group = { name, field, combine, weight, filters: [...] }
//     field    which job text to match: title | company | location | any
//     combine  how matched filters reduce to one score: min | max | avg
//     weight   cross-group importance for the final fit (normalized at use)
//   filter = { name, keywords: [...], weight, else }
//     weight   null/absent = INACTIVE (defined but ignored); 0 = EXCLUDE (drop);
//              <1 lower · 1 neutral · >1 boost
//     else     catch-all: matches only when no keyword filter in its group did
//
// Matching is MEMBERSHIP (does ANY keyword hit), NOT maximal munch — the rating
// lives on the filter, so every keyword in a filter shares its weight and span
// resolution is moot. Cross-filter conflicts resolve via `combine` instead.

// Baseline a group contributes when the job matched no *active* (weighted)
// filter — the neutral value that "on" (1) sits above and "lower" (<1) below.
export const DEFAULT_GROUP_WEIGHT = 0.5;

// Group combine is limited to the three the board exposes (min/max/avg). 'avg'
// is accepted as the board spells it; combineWeights() keeps multiply/average
// for the legacy flat path.
export function combineGroup(weights, mode = 'min') {
  if (mode === 'max') return Math.max(...weights);
  if (mode === 'avg' || mode === 'average') return weights.reduce((a, b) => a + b, 0) / weights.length;
  return Math.min(...weights); // 'min' default — worst match wins, so 0/exclude wins
}

// A filter's display label. The `name` is OPTIONAL: when absent, the first
// non-empty keyword stands in (so portals.yml can omit `name:` wherever the
// first keyword already reads well). Catch-alls keep needing an explicit name.
export function filterLabel(f) {
  if (f && f.name && String(f.name).trim()) return String(f.name).trim();
  for (const k of (f && f.keywords) || []) {
    if (k && String(k).trim()) return String(k).trim();
  }
  return '';
}

// Which job text a group matches against. `field` may be a single field id or
// an ARRAY of ids — an array reads each source and joins them with a space, so a
// group can match against e.g. [location, workmode] as one combined string (the
// keyword sees both, which keeps cross-field filters like "US-only remote" — US
// from location + remote from workmode — working after we strip mode tokens out
// of the location text). This generalises the fixed `any` combination.
export function fieldText(job, field) {
  if (Array.isArray(field)) return field.map((f) => fieldText(job, f)).join(' ');
  if (field === 'company') return job.company || '';
  if (field === 'location') return job.location || '';
  if (field === 'department') return job.department || '';
  // `workMode` is already the tri-state token 'remote'|'hybrid'|'onsite'
  // (providers/_types.js), so keyword filters ("remote"/"hybrid"/"onsite") run
  // straight through the regex engine. Unknown → '' so the job falls through to
  // the group's catch-all rather than false-matching.
  if (field === 'workmode') return job.workMode || '';
  if (field === 'any') return `${job.title || ''} ${job.company || ''} ${job.location || ''} ${job.department || ''}`;
  return job.title || ''; // 'title' (default)
}

// Compile a filter's keywords into RegExps once, cached on the filter as `_res`
// (same field the board uses, so a precompiled board filter is reused as-is).
function filterRegexes(f) {
  if (!f._res) f._res = (f.keywords || []).map(keyToRegExp).filter(Boolean);
  return f._res;
}

// `unless` is a guard that sits on TOP of every keyword in the filter: when the
// guard fires, the whole filter is voided (counts as no match). The guard is a
// list of REFERENCES to OTHER filters (by their label/name), not raw keywords —
// so it composes the filters you've already defined. It fires when the job
// matches ANY referenced filter, evaluated by that filter's own field+keywords.
// Lets a region exclude ("Poland", weight 0) NOT apply to a remote posting via
// `unless: [Remote]` — i.e. "exclude Poland unless the job is Remote", where the
// Remote filter tests workMode itself, no keyword duplication.
//
// Build a label→{filter, field} index from all groups so a reference can be
// resolved to the target filter and the field it matches against. Lowercased,
// first-wins; catch-alls (`else`) are skipped — they aren't referenceable targets.
export function buildFilterIndex(groups) {
  const idx = new Map();
  for (const g of groups || []) {
    for (const f of g.filters || []) {
      if (f.else) continue;
      const label = filterLabel(f).toLowerCase();
      if (label && !idx.has(label)) idx.set(label, { f, field: g.field });
    }
  }
  return idx;
}

// Does the job hit ANY of this filter's keywords against the given field text?
// Used both for the host filter (membership) and, via the index, for resolving
// an `unless` reference. Deliberately non-recursive: a referenced filter's own
// `unless` is NOT re-evaluated, so references can't form cycles.
function keywordHit(text, f) {
  for (const re of filterRegexes(f)) {
    if (re.global) re.lastIndex = 0;
    if (re.test(text)) return true;
  }
  return false;
}

// True when any of the filter's `unless` references resolves to a filter the job
// matches. Unresolved references (no such filter, or it's muted/absent from the
// index) are inert — they void nothing.
function unlessFires(job, f, index) {
  const refs = f.unless || [];
  if (!refs.length || !index) return false;
  for (const ref of refs) {
    const rec = index.get(String(ref).trim().toLowerCase());
    if (rec && keywordHit(fieldText(job, rec.field), rec.f)) return true;
  }
  return false;
}

/**
 * True if any of a filter's keywords matches `text` AND its `unless` guard does
 * not fire. The guard is checked only after a keyword hit, so a filter without
 * `unless` (the common case) behaves exactly as before. `index` resolves the
 * guard's filter references (see buildFilterIndex); omit it and the guard is inert.
 */
export function filterMatches(text, f, job, index) {
  if (!keywordHit(text, f)) return false;
  if (unlessFires(job, f, index)) return false;
  return true;
}

/**
 * The filters of `group` that match `job`. An `else` (catch-all) filter is
 * included only when no keyword filter in the group matched. `index` (optional)
 * resolves `unless` references across all groups; when omitted it is built from
 * this group alone, so cross-group references simply don't fire.
 */
export function matchGroup(job, group, index) {
  const idx = index || buildFilterIndex([group]);
  const text = fieldText(job, group.field);
  const matched = [];
  let anyKeyword = false;
  let elseFilter = null;
  for (const f of group.filters || []) {
    if (f.else) { elseFilter = f; continue; }
    if (filterMatches(text, f, job, idx)) { matched.push(f); anyKeyword = true; }
  }
  if (elseFilter && !anyKeyword) matched.push(elseFilter);
  // Priority rescue: a matched filter flagged `priority` voids this group's hard
  // excludes (weight 0) for the job — "exclude these regions UNLESS the job also
  // matches a priority filter (e.g. Remote)". Scoped to the group, so a Region
  // priority never rescues a Role/Company exclude. The priority filter keeps its
  // own weight; only the zero-weight excludes are dropped from the match set.
  if (matched.some((f) => f.priority)) {
    return matched.filter((f) => f.priority || f.weight !== 0);
  }
  return matched;
}

/** A group's score: its matched *active* filters combined via `combine`. */
export function scoreGroup(job, group, index) {
  const vals = matchGroup(job, group, index)
    .filter((f) => typeof f.weight === 'number')
    .map((f) => f.weight);
  if (!vals.length) return DEFAULT_GROUP_WEIGHT;
  return combineGroup(vals, group.combine || 'min');
}

/** True if the job matched an active filter weighted exactly 0 (hard exclude). */
export function isExcluded(job, groups) {
  const index = buildFilterIndex(groups);
  return groups.some((g) => matchGroup(job, g, index).some((f) => f.weight === 0));
}

/** Weighted fit across groups (group weights normalized at use). */
export function fitGroups(job, groups) {
  const index = buildFilterIndex(groups);
  let total = 0;
  let sum = 0;
  for (const g of groups) {
    const w = g.weight || 0;
    total += w;
    sum += w * scoreGroup(job, g, index);
  }
  return total ? sum / total : DEFAULT_GROUP_WEIGHT;
}

/**
 * Score one job against a `groups` array. Returns the job enriched with a per
 * group breakdown, a combined `fit`, and an `excluded` flag (a hard 0 anywhere).
 */
export function scoreJobGroups(job, groups) {
  const index = buildFilterIndex(groups);
  const breakdown = groups.map((g) => {
    const matched = matchGroup(job, g, index);
    return {
      name: g.name,
      field: g.field,
      score: scoreGroup(job, g, index),
      matched: matched.filter((f) => !f.else).map(filterLabel).filter(Boolean),
    };
  });
  return { ...job, group_scores: breakdown, fit: fitGroups(job, groups), excluded: isExcluded(job, groups) };
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
  // New unified schema: a `groups:` array. Falls through to the legacy flat
  // location/role/seniority path when groups are absent.
  if (Array.isArray(ranking?.groups)) return scoreJobGroups(job, ranking.groups);
  const w = normalizeWeights(ranking.weights || DEFAULT_RANKING.weights);
  const combine = ranking.combine || 'max';
  const location = scoreCategory(job.location, ranking.location || {}, combine);
  const role = scoreCategory(job.title, ranking.role || {}, combine);
  const seniority = scoreCategory(job.title, ranking.seniority || {}, combine);
  const company = scoreCategory(job.company, ranking.company || {}, combine);
  const fit =
    (w.location || 0) * location.score +
    (w.role || 0) * role.score +
    (w.seniority || 0) * seniority.score +
    (w.company || 0) * company.score;
  return { ...job, location_score: location, role_score: role, seniority_score: seniority, company_score: company, fit };
}

/** Score and sort a list of jobs, highest fit first. Stable for equal fits. */
export function rankJobs(jobs, ranking) {
  return jobs
    .map((j) => scoreJob(j, ranking))
    .sort((a, b) => b.fit - a.fit || a.company.localeCompare(b.company));
}

// ── Data loading (impure, isolated from the scoring core) ────────────

/**
 * Read the board's job snapshot (`site/data/jobs.json`) — the full, fresh,
 * URL-deduped scan that the public/local web board ranks. This is the SAME data
 * the board scores, so ranking it here with the same `portals.yml` targeting
 * makes data/ranked.md a faithful mirror of the local board (no second source of
 * truth). Rows already carry {title, url, company, location, postedDate,
 * workMode, department}; we only defaults-fill the fields the scorer touches so
 * a sparse row can't throw. Returns [] when the file is missing or malformed.
 */
export function loadBoardJobs(jsonText) {
  let parsed;
  try { parsed = JSON.parse(jsonText); } catch { return []; }
  const jobs = Array.isArray(parsed) ? parsed : parsed?.jobs;
  if (!Array.isArray(jobs)) return [];
  return jobs.map((j) => ({
    ...j,
    title: j.title || '',
    company: j.company || '',
    location: j.location || '',
  }));
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

// Render a job title as a clickable markdown link to its posting, for one-click
// access. The link text also escapes square brackets (which would otherwise
// break the `[text]` part), and the URL is wrapped in <…> so parentheses or
// other reserved characters in the posting URL can't break the `(…)` part.
// Falls back to plain text when the job has no URL.
function roleLink(title, url) {
  const text = cell(title).replace(/[[\]]/g, '\\$&');
  const href = String(url ?? '').trim();
  return href ? `[${text}](<${href}>)` : text;
}

// `linkify` makes the Role cell a clickable markdown link to the posting —
// on for the data/ranked.md artifact, off for the terminal preview (where a
// raw markdown link is just noise).
// Group-schema results carry `group_scores` (one entry per group) instead of
// the fixed location/role/seniority columns — render a column per group.
function renderTableGroups(ranked, { linkify = false } = {}) {
  const groupNames = ranked[0].group_scores.map((g) => g.name);
  const rows = ranked.map((j, i) => {
    const fit = j.fit.toFixed(3);
    const title = linkify ? roleLink(j.title, j.url) : cell(j.title);
    const groupCells = j.group_scores
      .map((g) => cell(`${pct(g.score)} ${g.matched.join(', ') || '—'}`))
      .join(' | ');
    return `| ${i + 1} | ${fit} | ${cell(j.company)} | ${title} | ${cell(j.location) || '—'} | ${groupCells} |`;
  });
  return [
    `| # | Fit | Company | Role | Location | ${groupNames.join(' | ')} |`,
    `|---|-----|---------|------|----------|${groupNames.map(() => '---').join('|')}|`,
    ...rows,
  ].join('\n');
}

function renderTable(ranked, { linkify = false } = {}) {
  if (ranked.length && ranked[0].group_scores) return renderTableGroups(ranked, { linkify });
  const rows = ranked.map((j, i) => {
    const fit = j.fit.toFixed(3);
    const loc = cell(`${pct(j.location_score.score)} ${j.location_score.matched}`);
    const role = cell(`${pct(j.role_score.score)} ${j.role_score.matched}`);
    const sen = cell(`${pct(j.seniority_score.score)} ${j.seniority_score.matched}`);
    const co = cell(`${pct(j.company_score.score)} ${j.company_score.matched}`);
    const title = linkify ? roleLink(j.title, j.url) : cell(j.title);
    return `| ${i + 1} | ${fit} | ${cell(j.company)} | ${title} | ${cell(j.location) || '—'} | ${loc} | ${role} | ${sen} | ${co} |`;
  });
  return [
    '| # | Fit | Company | Role | Location | Loc match | Role match | Lvl match | Co match |',
    '|---|-----|---------|------|----------|-----------|------------|-----------|----------|',
    ...rows,
  ].join('\n');
}

function renderRankedFile(ranked, date) {
  return [
    '# Ranked Pipeline',
    '',
    `_Deterministic surface-fit ranking — generated by rank.mjs on ${date}._`,
    '_Source: the board snapshot (`site/data/jobs.json`) ranked with `portals.yml`',
    'targeting — the SAME data + config the web board uses, so this file mirrors it',
    '(`npm run board:fresh`). This does NOT read your CV; run `/career-ops pipeline`',
    'for deep, CV-aware evaluation of the top picks._',
    '',
    renderTable(ranked, { linkify: true }),
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

  const ranking = loadRanking();

  // The board snapshot is the ONLY source — the SAME data the web board ranks, so
  // data/ranked.md mirrors it exactly (no second source of truth). Regenerate the
  // snapshot with `npm run board:refresh`, which writes it then runs this.
  if (!existsSync(BOARD_JOBS_PATH)) {
    console.error(`No board snapshot at ${BOARD_JOBS_PATH}. Run \`npm run board:refresh\` to scan + rank.`);
    process.exit(1);
  }
  const jobs = loadBoardJobs(readFileSync(BOARD_JOBS_PATH, 'utf-8'));
  if (jobs.length === 0) {
    console.log(`Board snapshot ${BOARD_JOBS_PATH} has no jobs — nothing to rank.`);
    return;
  }

  const ranked = rankJobs(jobs, ranking);
  const date = new Date().toISOString().slice(0, 10);

  if (!dryRun) {
    writeFileSync(RANKED_PATH, renderRankedFile(ranked, date), 'utf-8');
  }

  const shown = showAll ? ranked : ranked.slice(0, top);
  console.log(`\nRanked ${ranked.length} jobs by surface fit from the board snapshot (${BOARD_JOBS_PATH})\n`);
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
