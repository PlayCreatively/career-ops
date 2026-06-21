#!/usr/bin/env node
// @ts-check
// resolve-batch.mjs — the AGENT layer of `/career-ops resolve`.
//
// The tokenless slug-prober (probe/probe-studios.mjs --backlog) cracks the easy
// studios for free. This harness handles the RESIDUE: studios where slug-guessing
// fails and you have to actually read a homepage to find the careers source.
//
// For each still-unresolved studio it spawns ONE lean Haiku agent (`claude -p`)
// that finds the official site + the ATS host (or concludes email-only/none),
// returns a strict JSON verdict, and reports EXACT token cost. The harness then
// VALIDATES any ATS/feed claim with a tokenless fetch (the agent's word is never
// trusted blind — that's how namesakes got in) before writing the verdict —
// including per-studio `cost_usd` — back onto the studios.yml entry.
//
// WHY a separate process per studio (not Agent subagents): only `claude -p
// --output-format json` hands back `total_cost_usd` + `usage`, so the frontmatter
// cost is EXACT, not estimated.
//
// Usage:
//   node resolve-batch.mjs [N]            # dry-run N unresolved (default 5); logs + token table, no writes
//   node resolve-batch.mjs [N] --apply    # also write validated verdicts into studios.yml
//   node resolve-batch.mjs --company "X"  # just this studio
//   node resolve-batch.mjs --company "X" --apply
//   node resolve-batch.mjs --from-audit   # re-check the studios validate-wiring.mjs flagged
//   node resolve-batch.mjs --from-audit --apply   # ...and REPLACE their stale wiring in place
//
// Output sidecar (always): data/resolve-results.jsonl  (one verdict per line, with cost)
// Env: CAREER_OPS_CLAUDE_BIN to override the claude binary path.

import { readFileSync, writeFileSync, appendFileSync, mkdtempSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ROOT = process.cwd();
const STUDIOS = join(ROOT, 'studios.yml');
const SIDECAR = join(ROOT, 'data', 'resolve-results.jsonl');
const FLAGGED = join(ROOT, 'data', 'wiring-flagged.txt');

// ── args ──────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const APPLY = argv.includes('--apply');
// --from-audit: re-check the studios validate-wiring.mjs flagged (dead/suspect
// feeds). These ALREADY have wiring, so on --apply we REPLACE it, not append.
const FROM_AUDIT = argv.includes('--from-audit');
const companyIdx = argv.indexOf('--company');
const ONLY = companyIdx >= 0 ? argv[companyIdx + 1] : null;
// --max-turns N: hard cap on each agent's loop (the main cost lever). Default 4
// is cheap but can starve harder studios into "no verdict" — raise it (e.g. 8)
// when re-checks fail to converge.
const mtIdx = argv.indexOf('--max-turns');
const MAX_TURNS = mtIdx >= 0 ? Math.max(1, parseInt(argv[mtIdx + 1], 10) || 4) : 4;
const N = (() => {
  // ignore the integer that belongs to --max-turns when reading the batch size
  const n = argv.find((a, i) => /^\d+$/.test(a) && i !== mtIdx + 1);
  return n ? parseInt(n, 10) : 5;
})();

// ── locate the claude binary ────────────────────────────────────────────────
function claudeBin() {
  if (process.env.CAREER_OPS_CLAUDE_BIN) return process.env.CAREER_OPS_CLAUDE_BIN;
  if (process.platform === 'win32') {
    // Prefer the native .exe (Node can spawn it without shell:true; a .cmd cannot
    // be spawned without a shell, which would mangle the long prompt arg).
    const exe = join(process.env.APPDATA || '', 'npm', 'node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe');
    if (existsSync(exe)) return exe;
  }
  return 'claude'; // assume on PATH
}
const CLAUDE = claudeBin();

// ── studios.yml parsing (line-based; the file is hand-maintained + commented) ─
// A studio entry is a `  - name: X` line followed by 4-space-indented fields up
// to the next `  - name:` or a less-indented line. We only need: the name, the
// entry's line range, and whether it already has a feed (provider/careers_url/
// recipe/parser) → if it does, it's resolved and we skip it.
function parseStudios(text) {
  const lines = text.split('\n');
  const entries = [];
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^(\s*)-\s+name:\s*(.+?)\s*$/);
    if (!m) continue;
    const indent = m[1].length;
    const name = stripYamlScalar(m[2]);
    // gather the body until the next sibling list item or a dedent
    let end = i + 1;
    const bodyIndent = indent + 2;
    const body = [];
    while (end < lines.length) {
      const l = lines[end];
      if (l.trim() === '') { body.push(l); end++; continue; }
      const li = l.match(/^(\s*)/)[1].length;
      if (li <= indent) break;                 // dedent → entry ended
      if (li === indent && /^\s*-\s/.test(l)) break;
      body.push(l);
      end++;
    }
    const bodyText = body.join('\n');
    const hasFeed = /\n\s*(provider|careers_url|recipe|parser):/.test('\n' + bodyText);
    entries.push({ name, start: i, end, indent, bodyIndent, hasFeed, body: bodyText });
  }
  return { lines, entries };
}

function stripYamlScalar(s) {
  s = s.trim();
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    return s.slice(1, -1);
  }
  return s;
}

function countryOf(bodyText) {
  const m = bodyText.match(/\n?\s*country:\s*([A-Za-z]{2})\b/);
  return m ? m[1].toUpperCase() : '';
}

function currentUrlOf(bodyText) {
  const m = bodyText.match(/\n?\s*careers_url:\s*(\S+)/);
  return m ? stripYamlScalar(m[1]) : '';
}

// ── the resolver prompt (the contract proven by the manual pass) ─────────────
// Lessons baked in: classify from the ATS HOST (search + page source), never the
// rendered job list (JS-injected, invisible to a fetch); a valid-but-empty feed
// is RESOLVED not dead; never say email-only without checking BOTH page source
// and an ATS-host search.
function resolverPrompt(name, country, currentUrl) {
  const ctry = country ? ` It is based in ${country}.` : '';
  const sus = currentUrl
    ? `\nA script currently polls "${currentUrl}" for this studio's jobs, but that returned zero or non-game results — it may be the WRONG (same-named non-game) company. Verify and, if wrong, give the correct host.\n`
    : '';
  return [
    `You are resolving how the game studio "${name}" publishes its job openings.${ctry}${sus}`,
    `Goal: identify which Applicant Tracking System (ATS) / job-feed host powers its careers page, so a script can poll it directly.`,
    ``,
    `BUDGET — keep this cheap: at most ONE web search and ONE page fetch. STOP the moment you`,
    `have the ATS host OR have confirmed email-only/none. Do not browse further to "be thorough".`,
    `The search results alone usually reveal the ATS host in a result URL — prefer that over fetching.`,
    ``,
    `Steps:`,
    `1. Confirm the studio's OFFICIAL site and that it is the GAME studio (not a same-named non-game company).`,
    `2. Find the ATS host. One web search for "<studio> careers" or "<studio> jobs" — the answer is usually a`,
    `   result URL on one of these hosts (fetch the careers page only if the search is inconclusive):`,
    `   greenhouse.io, lever.co, ashbyhq.com, *.teamtailor.com, *.recruitee.com, smartrecruiters.com, *.workable.com, *.bamboohr.com, *.myworkdayjobs.com (workday), *.jobs.personio.de (personio), jobylon, breezy.hr, avature, hailey.`,
    `   IMPORTANT: the job LIST is usually JS-rendered and invisible to a plain fetch — do NOT conclude "no jobs / email-only" just because a fetched page looks empty. Judge by the ATS HOST, not by whether roles render.`,
    `3. Classify the outcome:`,
    `   - "ats": you found a known ATS host above. Give provider + the careers_url on that host.`,
    `   - "recipe-json" / "recipe-html": jobs come from the studio's own site via a JSON XHR or static HTML list (no third-party ATS).`,
    `   - "email-only": applications go to an email with no machine-readable feed.`,
    `   - "none": no findable website / studio appears defunct.`,
    `   - "uncertain": a real careers page likely exists but you could not confirm the host (e.g. fully JS-gated). Prefer this over a guess.`,
    ``,
    `Respond with ONLY a JSON object, no prose, no code fence:`,
    `{"official_site": "<url or null>", "provider": "<greenhouse|lever|ashby|teamtailor|recruitee|smartrecruiters|workable|bamboohr|workday|personio|jobylon|breezy|avature|hailey|null>", "ats_host": "<host or null>", "careers_url": "<url or null>", "outcome": "<ats|recipe-json|recipe-html|email-only|none|uncertain>", "evidence": "<one sentence: the concrete signal you saw>"}`,
  ].join('\n');
}

// ── spawn one lean Haiku resolver, return {verdict, cost_usd, usage, raw} ─────
function runAgent(name, country, currentUrl) {
  const scratch = mkdtempSync(join(tmpdir(), 'resolve-')); // no CLAUDE.md here → lean context
  const res = spawnSync(CLAUDE, [
    '-p', resolverPrompt(name, country, currentUrl),
    '--output-format', 'json',
    '--model', 'haiku',
    '--allowedTools', 'WebSearch,WebFetch',
    '--max-turns', String(MAX_TURNS),   // hard cap on the agentic loop — the biggest cost lever (--max-turns N)
  ], { cwd: scratch, input: '', encoding: 'utf8', timeout: 200_000, maxBuffer: 32 * 1024 * 1024, windowsHide: true });

  if (res.error) return { error: String(res.error.message || res.error) };
  let env;
  try { env = JSON.parse(res.stdout); }
  catch { return { error: `unparseable claude output: ${(res.stdout || res.stderr || '').slice(0, 300)}` }; }
  const verdict = extractJson(env.result);
  const u = env.usage || {};
  return {
    verdict,
    cost_usd: env.total_cost_usd ?? null,
    usage: {
      in: u.input_tokens ?? 0,
      out: u.output_tokens ?? 0,
      cache_create: u.cache_creation_input_tokens ?? 0,
      cache_read: u.cache_read_input_tokens ?? 0,
      web: u.server_tool_use?.web_search_requests ?? 0,
      // total billable context the model actually had to chew through this call
      total: (u.input_tokens ?? 0) + (u.output_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0),
    },
    raw: env.result,
  };
}

function extractJson(s) {
  if (!s) return null;
  const fenced = s.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = fenced ? fenced[1] : s;
  const brace = candidate.match(/\{[\s\S]*\}/);
  if (!brace) return null;
  try { return JSON.parse(brace[0]); } catch { return null; }
}

// ── tokenless validation: prove the agent's ATS claim before trusting it ─────
// Returns { ok: boolean, jobs: number|null, empty: boolean, note } — a valid feed
// SHAPE with 0 jobs counts as ok:true, empty:true (the Yager/Personio case).
const FEED = {
  greenhouse: (u) => { const s = slugFrom(u, /greenhouse\.io\/([^/?#]+)/); return s && `https://boards-api.greenhouse.io/v1/boards/${s}/jobs`; },
  lever:      (u) => { const s = slugFrom(u, /lever\.co\/([^/?#]+)/);       return s && `https://api.lever.co/v0/postings/${s}?mode=json`; },
  ashby:      (u) => { const s = slugFrom(u, /ashbyhq\.com\/([^/?#]+)/);     return s && `https://api.ashbyhq.com/posting-api/job-board/${s}`; },
  personio:   (u) => { const h = hostFrom(u); return h && `https://${h.replace(/\/.*/, '')}/xml?language=en`; },
  teamtailor: (u) => { const o = originFrom(u); return o && `${o}/jobs.json`; },
  recruitee:  (u) => { const s = slugFrom(u, /([^/.]+)\.recruitee\.com/) || slugFrom(u, /recruitee\.com\/([^/?#]+)/); return s && `https://${s}.recruitee.com/api/offers/`; },
};

async function validate(provider, careersUrl) {
  const build = FEED[provider];
  if (!build || !careersUrl) return { ok: null, note: 'no tokenless validator for this provider — needs --apply scan check' };
  const url = build(careersUrl);
  if (!url) return { ok: null, note: 'could not derive feed url from careers_url' };
  try {
    const r = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(20_000) });
    if (!r.ok) return { ok: false, note: `feed HTTP ${r.status}` };
    const body = await r.text();
    const jobs = countJobs(provider, body);
    return { ok: true, jobs, empty: jobs === 0, note: `feed live (${jobs} jobs)` };
  } catch (e) {
    return { ok: false, note: `feed fetch failed: ${String(e.message || e).slice(0, 80)}` };
  }
}

function countJobs(provider, body) {
  if (provider === 'personio') return (body.match(/<position>/g) || []).length;
  if (provider === 'teamtailor') { try { return (JSON.parse(body).items || []).length; } catch { return 0; } }
  try { const j = JSON.parse(body); return (j.jobs || j.data || j.offers || (Array.isArray(j) ? j : [])).length || 0; } catch { return 0; }
}
const hostFrom = (u) => { try { return new URL(u).host + new URL(u).pathname.replace(/\/$/, ''); } catch { return ''; } };
const originFrom = (u) => { try { return new URL(u).origin; } catch { return ''; } };
const slugFrom = (u, re) => { const m = (u || '').match(re); return m ? m[1] : ''; };

// ── write a verdict back onto the studios.yml entry (--apply only) ───────────
// MUST be applied bottom-up (descending entry.start) so each edit's line shifts
// never invalidate an unprocessed entry above it. For a re-checked (flagged)
// entry that already has wiring, the old provider/careers_url + any prior
// resolve: block are REMOVED first, so we replace rather than duplicate keys.
function applyVerdict(parsed, entry, verdict, validation, cost, today) {
  const pad = ' '.repeat(entry.bodyIndent);
  const v = verdict;
  const resolved = v.outcome === 'ats' && validation.ok;

  if (entry.hasFeed) removeWiringLines(parsed.lines, entry);

  const out = [];
  if (resolved) {
    out.push(`${pad}provider: ${v.provider}`);
    out.push(`${pad}careers_url: ${v.careers_url}`);
  }
  out.push(`${pad}resolve:`);
  out.push(`${pad}  at: ${today}`);
  out.push(`${pad}  outcome: ${resolved ? 'ats' : (validation.ok === false && v.outcome === 'ats' ? 'uncertain' : v.outcome)}`);
  if (resolved) out.push(`${pad}  provider: ${v.provider}`);
  out.push(`${pad}  method: haiku`);
  out.push(`${pad}  cost_usd: ${cost == null ? 'null' : cost.toFixed(6)}`);
  if (validation.jobs != null) out.push(`${pad}  jobs_at_wire: ${validation.jobs}`);
  out.push(`${pad}  note: ${yamlStr((v.evidence || '').slice(0, 160))}`);
  parsed.lines.splice(entry.start + 1, 0, ...out);
  return out.length;
}

// Live-compute an entry's body line span [from, to) by indentation, then strip the
// existing provider:/careers_url: lines (at bodyIndent) and any resolve: mapping
// (its line + deeper-indented children). Splices from highest index down so each
// removal doesn't shift the indices still to be removed.
function removeWiringLines(lines, entry) {
  const bodyIndent = entry.bodyIndent;
  let to = entry.start + 1;
  while (to < lines.length) {
    const l = lines[to];
    if (l.trim() === '') { to++; continue; }
    if (l.match(/^(\s*)/)[1].length <= entry.indent) break;
    to++;
  }
  const drop = [];
  for (let i = entry.start + 1; i < to; i++) {
    const l = lines[i];
    const ind = l.match(/^(\s*)/)[1].length;
    if (ind === bodyIndent && /^(provider|careers_url):/.test(l.trim())) { drop.push(i); continue; }
    if (ind === bodyIndent && /^resolve:/.test(l.trim())) {
      drop.push(i);
      for (let j = i + 1; j < to; j++) {
        if (lines[j].trim() === '') { drop.push(j); continue; }
        if (lines[j].match(/^(\s*)/)[1].length > bodyIndent) drop.push(j);
        else break;
      }
    }
  }
  for (const i of drop.sort((a, b) => b - a)) lines.splice(i, 1);
}
const yamlStr = (s) => `"${String(s).replace(/"/g, "'")}"`;

// ── main ─────────────────────────────────────────────────────────────────────
async function main() {
  if (!existsSync(STUDIOS)) { console.error('studios.yml not found in cwd'); process.exit(1); }
  const text = readFileSync(STUDIOS, 'utf8');
  const parsed = parseStudios(text);

  let pool;
  if (FROM_AUDIT) {
    if (!existsSync(FLAGGED)) { console.log('No data/wiring-flagged.txt — run `node validate-wiring.mjs` first.'); return; }
    const names = new Set(readFileSync(FLAGGED, 'utf8').split('\n').map(s => s.trim().toLowerCase()).filter(Boolean));
    pool = parsed.entries.filter(e => names.has(e.name.toLowerCase()));
  } else {
    pool = parsed.entries.filter(e => !e.hasFeed);
  }
  if (ONLY) pool = parsed.entries.filter(e => e.name.toLowerCase() === ONLY.toLowerCase());
  const batch = ONLY ? pool : pool.slice(0, N);

  if (batch.length === 0) {
    console.log(FROM_AUDIT ? 'Nothing flagged to re-check.' : 'Nothing to resolve (no matching unresolved entries).');
    return;
  }

  console.log(`\n  resolve-batch — ${batch.length} studio(s) · ${FROM_AUDIT ? 're-check flagged' : 'resolve backlog'} · model haiku · ${APPLY ? 'APPLY' : 'dry-run'} · claude: ${CLAUDE}\n`);
  const rows = [];
  const applies = []; // {entry, v, validation, cost} — applied bottom-up after the loop
  let total = 0;
  const tok = { in: 0, out: 0, cache_read: 0, cache_create: 0 };

  for (const entry of batch) {
    const country = countryOf(entry.body);
    const currentUrl = FROM_AUDIT ? currentUrlOf(entry.body) : '';
    process.stdout.write(`  • ${entry.name}${country ? ` (${country})` : ''} … `);
    const r = runAgent(entry.name, country, currentUrl);
    if (r.error || !r.verdict) {
      console.log(`✗ ${r.error || 'no verdict'}`);
      rows.push({ name: entry.name, outcome: 'error', cost: r.cost_usd || 0, note: r.error || 'no verdict' });
      total += r.cost_usd || 0;
      appendFileSync(SIDECAR, JSON.stringify({ at: today(), name: entry.name, error: r.error, cost_usd: r.cost_usd, raw: r.raw }) + '\n');
      continue;
    }
    const v = r.verdict;
    let validation = { ok: null, note: 'n/a' };
    if (v.outcome === 'ats' && v.provider && v.careers_url) validation = await validate(v.provider, v.careers_url);
    total += r.cost_usd || 0;
    const u = r.usage || { in: 0, out: 0, cache_read: 0, cache_create: 0, web: 0, total: 0 };
    tok.in += u.in || 0; tok.out += u.out || 0; tok.cache_read += u.cache_read || 0; tok.cache_create += u.cache_create || 0;
    const work = (u.in || 0) + (u.out || 0) + (u.cache_create || 0); // fresh tokens the run actually generated/ingested
    const mark = v.outcome === 'ats' ? (validation.ok ? '✅ ats' : (validation.ok === false ? '⚠️  ats-unverified' : '☑️  ats')) : `· ${v.outcome}`;
    console.log(`${mark}${v.provider ? ` ${v.provider}` : ''} · ${fmtTok(work)} fresh +${fmtTok(u.cache_read || 0)} cached${u.web ? ` · ${u.web} web` : ''}`);
    if (FROM_AUDIT && currentUrl) console.log(`      was: ${currentUrl}`);
    if (v.outcome === 'ats') console.log(`      now: ${v.careers_url || ''} — ${validation.note}`);
    if (v.evidence) console.log(`      “${v.evidence}”`);

    rows.push({ name: entry.name, outcome: v.outcome, provider: v.provider, validated: validation.ok, cost: r.cost_usd || 0 });
    appendFileSync(SIDECAR, JSON.stringify({ at: today(), name: entry.name, country, from_audit: FROM_AUDIT, was: currentUrl || undefined, verdict: v, validation, cost_usd: r.cost_usd, usage: r.usage }) + '\n');

    if (APPLY) applies.push({ entry, v, validation, cost: r.cost_usd });
  }

  if (APPLY) {
    // Bottom-up so each splice's line shift can't invalidate an entry above it.
    applies.sort((a, b) => b.entry.start - a.entry.start);
    for (const a of applies) applyVerdict(parsed, a.entry, a.v, a.validation, a.cost, today());
    writeFileSync(STUDIOS, parsed.lines.join('\n'));
    console.log(`\n  ✎ studios.yml updated in place (${applies.length} ${FROM_AUDIT ? 're-checked' : 'resolved'}).`);
  }

  // summary
  console.log(`\n  ── batch summary ──`);
  const by = {};
  for (const r of rows) by[r.outcome] = (by[r.outcome] || 0) + 1;
  console.log('  ' + Object.entries(by).map(([k, n]) => `${k}: ${n}`).join('  ·  '));
  const fresh = tok.in + tok.out + tok.cache_create;
  console.log(`  tokens: ${fmtTok(fresh)} fresh (${fmtTok(tok.in)} in / ${fmtTok(tok.out)} out / ${fmtTok(tok.cache_create)} cache-write) + ${fmtTok(tok.cache_read)} cache-read`);
  console.log(`  avg ${fmtTok(Math.round(fresh / rows.length))} fresh/studio   (cost $${total.toFixed(4)})`);
  console.log(`  sidecar: data/resolve-results.jsonl`);
  if (!APPLY) console.log(`  (dry-run — re-run with --apply to write verdicts into studios.yml)\n`);
  else console.log('');
}

function today() { return new Date().toISOString().slice(0, 10); }
function fmtTok(n) { return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n); }

main().catch(e => { console.error(e); process.exit(1); });
