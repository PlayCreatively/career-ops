#!/usr/bin/env node

/**
 * test-all.mjs — Comprehensive test suite for career-ops
 *
 * Run before merging any PR or pushing changes.
 * Tests: syntax, scripts, dashboard, data contract, personal data, paths.
 *
 * Usage:
 *   node test-all.mjs           # Run all tests
 *   node test-all.mjs --quick   # Skip dashboard build (faster)
 */

import { execSync, execFileSync } from 'child_process';
import { readFileSync, existsSync, readdirSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { join, dirname } from 'path';
import { tmpdir } from 'os';
import { fileURLToPath, pathToFileURL } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = __dirname;
const QUICK = process.argv.includes('--quick');
const NODE = process.execPath;

let passed = 0;
let failed = 0;
let warnings = 0;

function pass(msg) { console.log(`  ✅ ${msg}`); passed++; }
function fail(msg) { console.log(`  ❌ ${msg}`); failed++; }
function warn(msg) { console.log(`  ⚠️  ${msg}`); warnings++; }

function run(cmd, args = [], opts = {}) {
  try {
    if (Array.isArray(args) && args.length > 0) {
      return execFileSync(cmd, args, { cwd: ROOT, encoding: 'utf-8', timeout: 30000, ...opts }).trim();
    }
    return execSync(cmd, { cwd: ROOT, encoding: 'utf-8', timeout: 30000, ...opts }).trim();
  } catch (e) {
    return null;
  }
}

function fileExists(path) { return existsSync(join(ROOT, path)); }
function readFile(path) { return readFileSync(join(ROOT, path), 'utf-8'); }

console.log('\n🧪 career-ops test suite\n');

// ── 1. SYNTAX CHECKS ────────────────────────────────────────────

console.log('1. Syntax checks');

const mjsFiles = readdirSync(ROOT).filter(f => f.endsWith('.mjs'));
for (const f of mjsFiles) {
  const result = run(NODE, ['--check', f]);
  if (result !== null) {
    pass(`${f} syntax OK`);
  } else {
    fail(`${f} has syntax errors`);
  }
}

// ── 2. SCRIPT EXECUTION ─────────────────────────────────────────

console.log('\n2. Script execution (graceful on empty data)');

const scripts = [
  { name: 'cv-sync-check.mjs', expectExit: 1, allowFail: true }, // fails without cv.md (normal in repo)
  { name: 'verify-pipeline.mjs', expectExit: 0 },
  { name: 'normalize-statuses.mjs', expectExit: 0 },
  { name: 'dedup-tracker.mjs', expectExit: 0 },
  { name: 'merge-tracker.mjs', expectExit: 0 },
  { name: 'analyze-patterns.mjs --self-test', expectExit: 0 },
  { name: 'update-system.mjs check', expectExit: 0 },
];

for (const { name, allowFail } of scripts) {
  const result = run(NODE, name.split(' '), { stdio: ['pipe', 'pipe', 'pipe'] });
  if (result !== null) {
    pass(`${name} runs OK`);
  } else if (allowFail) {
    warn(`${name} exited with error (expected without user data)`);
  } else {
    fail(`${name} crashed`);
  }
}

// ── 3. LIVENESS CLASSIFICATION ──────────────────────────────────

console.log('\n3. Liveness classification');

try {
  const { classifyLiveness } = await import(pathToFileURL(join(ROOT, 'liveness-core.mjs')).href);

  const expiredChromeApply = classifyLiveness({
    finalUrl: 'https://example.com/jobs/closed-role',
    bodyText: 'Company Careers\nApply\nThe job you are looking for is no longer open.',
    applyControls: [],
  });
  if (expiredChromeApply.result === 'expired') {
    pass('Expired pages are not revived by nav/footer "Apply" text');
  } else {
    fail(`Expired page misclassified as ${expiredChromeApply.result}`);
  }

  const activeWorkdayPage = classifyLiveness({
    finalUrl: 'https://example.workday.com/job/123',
    bodyText: [
      '663 JOBS FOUND',
      'Senior AI Engineer',
      'Join our applied AI team to ship production systems, partner with customers, and own delivery across evaluation, deployment, and reliability.',
    ].join('\n'),
    applyControls: ['Apply for this Job'],
  });
  if (activeWorkdayPage.result === 'active') {
    pass('Visible apply controls still keep real job pages active');
  } else {
    fail(`Active job page misclassified as ${activeWorkdayPage.result}`);
  }

  const closedMycareersfuture = classifyLiveness({
    finalUrl: 'https://www.mycareersfuture.gov.sg/job/engineering/senior-staff-embedded-software-engineer',
    bodyText: [
      'Senior Staff Embedded Software Engineer',
      'MaxLinear Asia Singapore Private Limited',
      '9 applications    Posted 27 Oct 2025    Closed on 26 Nov 2025',
      'Applications have closed for this job',
      'Log in to Apply',
      "You'll need to log in with Singpass to verify your identity.",
      'Roles & Responsibilities: design, develop and maintain embedded firmware for broadband communications ICs.',
    ].join('\n'),
    applyControls: ['Log in to Apply'],
  });
  if (closedMycareersfuture.result === 'expired') {
    pass('Closed postings with "Applications have closed" banner are detected');
  } else {
    fail(`Closed mycareersfuture posting misclassified as ${closedMycareersfuture.result}`);
  }
} catch (e) {
  fail(`Liveness classification tests crashed: ${e.message}`);
}

// ── 4. DASHBOARD BUILD ──────────────────────────────────────────

if (!QUICK) {
  console.log('\n4. Dashboard build');
  const goBuild = run('cd dashboard && go build -o /tmp/career-dashboard-test . 2>&1');
  if (goBuild !== null) {
    pass('Dashboard compiles');
  } else {
    fail('Dashboard build failed');
  }
} else {
  console.log('\n4. Dashboard build (skipped --quick)');
}

// ── 5. DATA CONTRACT ────────────────────────────────────────────

console.log('\n5. Data contract validation');

// Check system files exist
const systemFiles = [
  'CLAUDE.md', 'VERSION', 'DATA_CONTRACT.md',
  'modes/_shared.md', 'modes/_profile.template.md',
  'modes/oferta.md', 'modes/pdf.md', 'modes/scan.md',
  'templates/states.yml', 'templates/cv-template.html',
  '.claude/skills/career-ops/SKILL.md',
];

for (const f of systemFiles) {
  if (fileExists(f)) {
    pass(`System file exists: ${f}`);
  } else {
    fail(`Missing system file: ${f}`);
  }
}

// Check user files are NOT tracked (gitignored)
const userFiles = [
  'config/profile.yml', 'modes/_profile.md', 'portals.yml',
];
for (const f of userFiles) {
  const tracked = run('git', ['ls-files', f]);
  if (tracked === '') {
    pass(`User file gitignored: ${f}`);
  } else if (tracked === null) {
    pass(`User file gitignored: ${f}`);
  } else {
    fail(`User file IS tracked (should be gitignored): ${f}`);
  }
}

// ── 6. PERSONAL DATA LEAK CHECK ─────────────────────────────────

console.log('\n6. Personal data leak check');

const leakPatterns = [
  'Santiago', 'santifer.io', 'Santifer iRepair', 'Zinkee', 'ALMAS',
  'hi@santifer.io', '688921377', '/Users/santifer/',
];

const scanExtensions = ['md', 'yml', 'html', 'mjs', 'sh', 'go', 'json'];
const allowedFiles = [
  // English README + localized translations (all legitimately credit Santiago)
  'README.md', 'README.es.md', 'README.ja.md', 'README.ko-KR.md',
  'README.pt-BR.md', 'README.ru.md', 'README.cn.md', 'README.zh-TW.md',
  // Standard project files
  'LICENSE', 'CITATION.cff', 'CONTRIBUTING.md', 'CHANGELOG.md', 'TRADEMARK.md',
  'package.json', '.github/FUNDING.yml', 'CLAUDE.md', 'AGENTS.md', 'go.mod', 'test-all.mjs',
  '.claude-plugin/marketplace.json', '.claude-plugin/plugin.json',
  // Community / governance files (added in v1.3.0, all legitimately reference the maintainer)
  'CODE_OF_CONDUCT.md', 'GOVERNANCE.md', 'SECURITY.md', 'SUPPORT.md',
  '.github/SECURITY.md',
  // Dashboard credit string
  'dashboard/internal/ui/screens/pipeline.go',
  'dashboard/internal/ui/screens/progress.go',
];

// Build pathspec for git grep — only scan tracked files matching these
// extensions. This is what `grep -rn` was trying to do, but git-aware:
// untracked files (debate artifacts, AI tool scratch, local plans/) and
// gitignored files can't trigger false positives because they were never
// going to reach a commit anyway.
const grepPathspec = scanExtensions.map(e => `'*.${e}'`).join(' ');

let leakFound = false;
for (const pattern of leakPatterns) {
  const result = run(
    `git grep -n "${pattern}" -- ${grepPathspec} 2>/dev/null`
  );
  if (result) {
    for (const line of result.split('\n')) {
      const file = line.split(':')[0];
      if (allowedFiles.some(a => file.includes(a))) continue;
      if (file.includes('dashboard/go.mod')) continue;
      warn(`Possible personal data in ${file}: "${pattern}"`);
      leakFound = true;
    }
  }
}
if (!leakFound) {
  pass('No personal data leaks outside allowed files');
}

// ── 7. ABSOLUTE PATH CHECK ──────────────────────────────────────

console.log('\n7. Absolute path check');

// Same git grep approach: only scans tracked files. Untracked AI tool
// outputs, local debate artifacts, etc. can't false-positive here.
const absPathResult = run(
  `git grep -n "/Users/" -- '*.mjs' '*.sh' '*.md' '*.go' '*.yml' 2>/dev/null | grep -v README.md | grep -v LICENSE | grep -v CLAUDE.md | grep -v test-all.mjs`
);
if (!absPathResult) {
  pass('No absolute paths in code files');
} else {
  for (const line of absPathResult.split('\n').filter(Boolean)) {
    fail(`Absolute path: ${line.slice(0, 100)}`);
  }
}

// ── 8. MODE FILE INTEGRITY ──────────────────────────────────────

console.log('\n8. Mode file integrity');

const expectedModes = [
  '_shared.md', '_profile.template.md', 'oferta.md', 'pdf.md', 'scan.md',
  'batch.md', 'apply.md', 'auto-pipeline.md', 'contacto.md', 'deep.md',
  'ofertas.md', 'pipeline.md', 'project.md', 'tracker.md', 'training.md',
];

for (const mode of expectedModes) {
  if (fileExists(`modes/${mode}`)) {
    pass(`Mode exists: ${mode}`);
  } else {
    fail(`Missing mode: ${mode}`);
  }
}

// Check _shared.md references _profile.md
const shared = readFile('modes/_shared.md');
if (shared.includes('_profile.md')) {
  pass('_shared.md references _profile.md');
} else {
  fail('_shared.md does NOT reference _profile.md');
}

// ── 9. LOCAL PARSER CONTRACT ────────────────────────────────────

console.log('\n9. Local parser contract');

const scanScript = readFile('scan.mjs');
if (
  scanScript.includes('typeof company.name !== \'string\'') &&
  scanScript.includes('company.name.trim()') &&
  scanScript.includes('company.name.toLowerCase()')
) {
  pass('scan.mjs guards company names before filtering');
} else {
  fail('scan.mjs does not guard company names before filtering');
}

if (
  scanScript.includes("skipIds: ['local-parser']") &&
  scanScript.includes('local parser failed, used API fallback') &&
  scanScript.includes('resolveProvider(company, providers')
) {
  pass('scan.mjs falls back to ATS API when local parser fails');
} else {
  fail('scan.mjs does not fall back to ATS API when local parser fails');
}

if (fileExists('providers/local-parser.mjs')) {
  pass('local-parser provider module exists');
} else {
  fail('local-parser provider module is missing');
}

const scanMode = fileExists('modes/scan.md') ? readFile('modes/scan.md') : '';
if (
  scanMode.includes('local_parser_ok') &&
  scanMode.includes('no repetir scraping caro') &&
  scanMode.includes('nombre no listado en `local_parser_ok`')
) {
  pass('scan.md skips expensive levels after successful local parser');
} else {
  fail('scan.md missing local_parser_ok skip rules for agent scan');
}

if (!fileExists('scripts/parsers/cohere_jobs.py')) {
  pass('Cohere parser example is not bundled as a runtime script');
} else {
  fail('Cohere parser example is still bundled as a runtime script');
}

const portalExample = readFile('templates/portals.example.yml');
if (
  !portalExample.includes('cohere_jobs.py') &&
  portalExample.includes('scripts/parsers/example-js-company-jobs.js') &&
  portalExample.includes('scripts/parsers/example_python_company_jobs.py') &&
  portalExample.includes('already know their target careers URL')
) {
  pass('portals example documents a generic local parser contract');
} else {
  fail('portals example still points at a bundled Cohere parser');
}

// ── 10. AGENTS.md INTEGRITY ─────────────────────────────────────

console.log('\n10. AGENTS.md integrity');

const agents = readFile('AGENTS.md');
const requiredSections = [
  'Data Contract', 'Update Check', 'Ethical Use',
  'Offer Verification', 'Canonical States', 'TSV Format',
  'First Run', 'Onboarding',
];

for (const section of requiredSections) {
  if (agents.includes(section)) {
    pass(`AGENTS.md has section: ${section}`);
  } else {
    fail(`AGENTS.md missing section: ${section}`);
  }
}

// ── 11. VERSION FILE ─────────────────────────────────────────────

console.log('\n11. Version file');

if (fileExists('VERSION')) {
  const version = readFile('VERSION').trim();
  if (/^\d+\.\d+\.\d+$/.test(version)) {
    pass(`VERSION is valid semver: ${version}`);
  } else {
    fail(`VERSION is not valid semver: "${version}"`);
  }
} else {
  fail('VERSION file missing');
}

// ── 11. LOCATION FILTER — always_allow tier ───────────────────────

console.log('\n11. Location filter — always_allow tier');

try {
  const { buildLocationFilter } = await import(pathToFileURL(join(ROOT, 'scan.mjs')).href);

  const filter = buildLocationFilter({
    always_allow: ['belgium', 'brussels'],
    allow: ['europe', 'emea', 'remote'],
    block: ['france', 'germany', 'united states'],
  });

  // Case 1: home-region passes regardless of other text
  if (filter('Brussels, Belgium') === true) pass('Brussels, Belgium passes (always_allow hit)');
  else fail('Brussels, Belgium should pass');

  // Case 2: always_allow wins over block (THE motivating case for this tier)
  if (filter('Remote, Belgium or France') === true) pass('Remote, Belgium or France passes (always_allow beats block)');
  else fail('Remote, Belgium or France should pass — always_allow must win over block');

  // Case 3: no always_allow hit, block still rejects
  if (filter('Paris, France') === false) pass('Paris, France is rejected (block still applies)');
  else fail('Paris, France should be rejected');

  // Case 4: empty location → pass (existing semantics, unchanged)
  if (filter('') === true) pass('empty location passes (unchanged semantics)');
  else fail('empty location should pass');

  // Case 5: case-insensitivity
  if (filter('BRUSSELS, BELGIUM') === true) pass('case-insensitive match works');
  else fail('case-insensitive match failed');

  // Case 6: backward compatibility — no always_allow key behaves like stock allow/block
  const stockFilter = buildLocationFilter({
    allow: ['europe', 'remote'],
    block: ['france'],
  });
  if (stockFilter('Remote, Belgium or France') === false) pass('without always_allow, block still wins (backward compatible)');
  else fail('without always_allow, behaviour must match stock allow/block (block wins)');

  // Case 7: null/missing locationFilter → pass-all filter (early-return path)
  const nullFilter = buildLocationFilter(null);
  if (nullFilter('Anywhere on Earth') === true && nullFilter('') === true) {
    pass('null locationFilter returns a pass-all filter (early-return path)');
  } else {
    fail('null locationFilter should return a pass-all filter');
  }

  // Case 8: string-instead-of-array → wrapped to a 1-item list
  const stringFilter = buildLocationFilter({ always_allow: 'belgium', block: ['france'] });
  if (stringFilter('Remote, Belgium or France') === true) {
    pass('always_allow as a bare string is wrapped to a single-item list');
  } else {
    fail('always_allow as a bare string should still work');
  }

  // Case 9: null/non-string items are filtered out (no crash, no false matches)
  const messyFilter = buildLocationFilter({
    always_allow: [null, 'belgium', 42, undefined],
    block: ['france', null, 7],
  });
  if (messyFilter('Brussels, Belgium') === true && messyFilter('Paris, France') === false) {
    pass('non-string entries (null, numbers, undefined) are filtered out without crashing');
  } else {
    fail('mixed-type keyword lists should not crash and should still match string entries');
  }

  // Case 10: all-null/non-string list → empty after normalization (no false rejects)
  const allBadFilter = buildLocationFilter({ block: [null, 42, undefined], allow: ['remote'] });
  if (allBadFilter('Remote') === true) {
    pass('a block list with only non-string entries normalizes to [] (no false rejects)');
  } else {
    fail('non-string-only block list should not cause rejection');
  }

  // Case 11: empty / whitespace-only entries are dropped (would otherwise pass-all via includes(''))
  const emptyKeywordFilter = buildLocationFilter({
    always_allow: ['', '  '],
    allow: ['remote'],
    block: ['france'],
  });
  if (emptyKeywordFilter('Paris, France') === false) {
    pass('empty/whitespace always_allow entries are dropped (no pass-all via includes(""))');
  } else {
    fail('empty always_allow entries should NOT bypass block — would have made the filter pass-all');
  }

  // Case 12: surrounding whitespace is trimmed so the keyword still matches
  const whitespaceFilter = buildLocationFilter({
    always_allow: ['  Belgium  ', '\tBrussels\n'],
    block: ['france'],
  });
  if (whitespaceFilter('Remote, Belgium or France') === true) {
    pass('whitespace-padded keywords still match after trim');
  } else {
    fail('"  Belgium  " should be trimmed and still match "Remote, Belgium or France"');
  }

  // Case 13: whitespace-only location is treated as missing (pass-all-tiers)
  if (filter('   \t  ') === true) pass('whitespace-only location passes (treated as missing)');
  else fail('whitespace-only location should pass');

  // Case 14: non-string location (number/object/null) → pass without throwing
  let crashed = false;
  try {
    const r1 = filter(42);
    const r2 = filter({ city: 'Brussels' });
    const r3 = filter(null);
    const r4 = filter(undefined);
    if (r1 === true && r2 === true && r3 === true && r4 === true) {
      pass('non-string location values (number, object, null, undefined) pass without throwing');
    } else {
      fail(`non-string location results: number=${r1}, object=${r2}, null=${r3}, undefined=${r4}`);
    }
  } catch (e) {
    crashed = true;
    fail(`non-string location crashed: ${e.message}`);
  }

  // Case 15: a malformed location (e.g. legacy object) does NOT bypass block when interpreted naively —
  // the guard returns true (pass) BEFORE block/allow even run, which is correct: scoring/eval happens
  // downstream from the scan filter, so malformed locations should fall through to the manual evaluation
  // step rather than being silently dropped here.
  if (filter(42) === true) pass('non-string locations are passed through to downstream evaluation, not silently dropped');
  else fail('non-string locations should pass through');

} catch (e) {
  fail(`always_allow tests crashed: ${e.message}`);
}
// ── 12. FOLLOW-UP CADENCE LOGIC ─────────────────────────────────

console.log('\n12. Follow-up cadence logic');

try {
  const cadence = await import(pathToFileURL(join(ROOT, 'followup-cadence.mjs')).href);

  // CLI regression: the import.meta.url guard must still let the module run as a CLI.
  // Data-independent — default mode emits the result as JSON: a `metadata` object when
  // the tracker has applications, or an `{error}` object (exit 1) when it is empty.
  // Empty output would mean the guard wrongly suppressed main().
  let cliOut = '';
  try {
    cliOut = execFileSync(NODE, [join(ROOT, 'followup-cadence.mjs')], { cwd: ROOT, encoding: 'utf-8', timeout: 30000 });
  } catch (cliErr) {
    cliOut = `${cliErr.stdout || ''}`; // exit 1 on an empty tracker is expected; keep stdout
  }
  let cliJson = null;
  try { cliJson = JSON.parse(cliOut.trim()); } catch { /* leave null → fail below */ }
  if (cliJson && typeof cliJson === 'object' && ('metadata' in cliJson || 'error' in cliJson)) {
    pass('CLI still executes under the import.meta.url guard (emits result JSON)');
  } else {
    fail('CLI produced no structured JSON when run directly — import.meta.url guard may be broken');
  }

  // Date helpers
  if (cadence.addDays(cadence.parseDate('2026-05-01'), 7) === '2026-05-08') {
    pass('addDays advances a parsed date by N days (UTC)');
  } else {
    fail(`addDays produced ${cadence.addDays(cadence.parseDate('2026-05-01'), 7)}`);
  }
  if (cadence.daysBetween(cadence.parseDate('2026-05-01'), cadence.parseDate('2026-05-08')) === 7) {
    pass('daysBetween counts whole days between two dates');
  } else {
    fail('daysBetween miscounted');
  }
  if (cadence.parseDate('not-a-date') === null && cadence.parseDate('2026-05-01') instanceof Date) {
    pass('parseDate rejects malformed input and accepts ISO dates');
  } else {
    fail('parseDate validation wrong');
  }

  // Status normalization (strips bold + trailing date, lowercases, maps aliases)
  if (cadence.normalizeStatus('**Applied** 2026-05-01') === 'applied') {
    pass('normalizeStatus strips bold + trailing date and lowercases');
  } else {
    fail(`normalizeStatus produced ${cadence.normalizeStatus('**Applied** 2026-05-01')}`);
  }

  // Urgency decision tree (CADENCE defaults: applied_first=7, max_followups=2, responded_initial=1, interview_thankyou=1)
  const urgencyCases = [
    [['applied', 7, null, 0], 'overdue', 'applied past applied_first → overdue'],
    [['applied', 3, null, 0], 'waiting', 'applied within window → waiting'],
    [['applied', 30, null, 2], 'cold', 'applied at max follow-ups → cold'],
    [['responded', 0, null, 0], 'urgent', 'responded before responded_initial → urgent'],
    [['interview', 1, null, 0], 'overdue', 'interview past thank-you window → overdue'],
  ];
  for (const [args, expected, label] of urgencyCases) {
    const got = cadence.computeUrgency(...args);
    if (got === expected) pass(`computeUrgency: ${label}`);
    else fail(`computeUrgency ${label}: expected ${expected}, got ${got}`);
  }

  // Next follow-up date scheduling
  const nextCases = [
    [['applied', '2026-05-01', null, 0], '2026-05-08', 'first applied follow-up = appDate + applied_first'],
    [['applied', '2026-05-01', null, 2], null, 'cold (max follow-ups) → null'],
    [['interview', '2026-05-01', null, 0], '2026-05-02', 'interview = appDate + interview_thankyou'],
  ];
  for (const [args, expected, label] of nextCases) {
    const got = cadence.computeNextFollowupDate(...args);
    if (got === expected) pass(`computeNextFollowupDate: ${label}`);
    else fail(`computeNextFollowupDate ${label}: expected ${expected}, got ${got}`);
  }
} catch (e) {
  fail(`follow-up cadence module crashed: ${e.message}`);
}

// ── 12. PROVIDERS — Workable ────────────────────────────────────────

console.log('\n12. Provider — workable');

try {
  const workable = (await import(pathToFileURL(join(ROOT, 'providers/workable.mjs')).href)).default;
  const { parseWorkableMarkdown } = await import(pathToFileURL(join(ROOT, 'providers/workable.mjs')).href);

  // detect() — auto-detection from careers_url
  if (workable.id === 'workable') pass('workable.id is "workable"');
  else fail(`workable.id is ${JSON.stringify(workable.id)}`);

  const hit = workable.detect({ name: 'TestCo', careers_url: 'https://apply.workable.com/optimile' });
  if (hit && hit.url === 'https://apply.workable.com/optimile/jobs.md') {
    pass('workable.detect() resolves apply.workable.com/<slug> → /jobs.md feed');
  } else {
    fail(`workable.detect() returned ${JSON.stringify(hit)}`);
  }

  const miss = workable.detect({ name: 'TestCo', careers_url: 'https://example.com/careers' });
  if (miss === null) pass('workable.detect() returns null for non-workable URLs');
  else fail(`workable.detect() should return null, got ${JSON.stringify(miss)}`);

  // parse() — markdown table
  const sampleMd = [
    '# Optimile — All Open Positions',
    '',
    '| Title | Department | Location | Type | Salary | Posted | Details |',
    '|---|---|---|---|---|---|---|',
    '| Senior AI PM | Product | Ghent, Belgium | Full-time | — | 2026-04-01 | [View](https://apply.workable.com/optimile/jobs/view/ABC123.md) |',
    '| Tech Lead | Engineering | Remote | Full-time | — | 2026-03-25 | [View](https://apply.workable.com/optimile/jobs/view/DEF456.md) |',
  ].join('\n');

  const jobs = parseWorkableMarkdown(sampleMd, 'Optimile');
  if (jobs.length === 2) pass('parseWorkableMarkdown extracts 2 jobs from 2-row table');
  else fail(`parseWorkableMarkdown returned ${jobs.length} jobs, expected 2`);

  if (jobs[0]?.title === 'Senior AI PM' && jobs[0]?.location === 'Ghent, Belgium' && jobs[0]?.company === 'Optimile') {
    pass('parseWorkableMarkdown extracts title, location, company correctly');
  } else {
    fail(`parseWorkableMarkdown row 0 = ${JSON.stringify(jobs[0])}`);
  }

  if (jobs[0]?.url === 'https://apply.workable.com/optimile/jobs/view/ABC123') {
    pass('parseWorkableMarkdown strips .md suffix from job URL');
  } else {
    fail(`parseWorkableMarkdown should strip .md; got url=${JSON.stringify(jobs[0]?.url)}`);
  }

  // Robustness
  if (parseWorkableMarkdown('', 'X').length === 0) pass('empty input → empty result');
  else fail('empty input should yield empty result');

  if (parseWorkableMarkdown(null, 'X').length === 0) pass('null input → empty result (no crash)');
  else fail('null input should yield empty result without crashing');

  // fetch() reaches the http context on the happy path (allowed hostname).
  await workable.fetch(
    { name: 'Smoke', careers_url: 'https://apply.workable.com/optimile' },
    {
      transport: 'http',
      fetchText: async (url) => {
        if (!url.startsWith('https://apply.workable.com/')) {
          throw new Error('fetchText called with unexpected URL');
        }
        return '| Title | Department | Location | Type | Salary | Posted | Details |\n|---|---|---|---|---|---|---|\n';
      },
      fetchJson: async () => { throw new Error('fetchJson should not be called'); },
    },
  );
  pass('workable.fetch() reaches fetchText on the happy path (allowed hostname)');

  // fetch() rejects an unresolvable careers_url (no apply.workable.com match in URL).
  let rejected = false;
  try {
    await workable.fetch(
      { name: 'BadUrl', careers_url: 'https://evil.com/totally-not-workable' },
      {
        transport: 'http',
        fetchText: async () => { throw new Error('SSRF! should not reach here'); },
        fetchJson: async () => { throw new Error('SSRF! should not reach here'); },
      },
    );
  } catch (e) {
    if (e.message.includes('cannot derive feed URL')) {
      rejected = true;
    } else {
      fail(`workable.fetch() rejected with wrong error: ${e.message}`);
    }
  }
  if (rejected) pass('workable.fetch() rejects unresolvable careers_url before fetch');
  else fail('workable.fetch() should throw cannot-derive-feed-URL for non-Workable URLs');

  // SSRF: malicious URL with apply.workable.com in the PATH (not hostname) must not be detected as Workable.
  // With strict URL parsing, the hostname `evil.example` fails the check and detect() returns null.
  if (workable.detect({ name: 'Spoof', careers_url: 'https://evil.example/apply.workable.com/slug' }) === null) {
    pass('workable.detect() rejects path-spoofed URLs (apply.workable.com in path, not hostname)');
  } else {
    fail('workable.detect() must NOT misdetect URLs that contain apply.workable.com in the path');
  }

  // careers_url with non-string value (e.g. YAML mistake passing a number) → detect() returns null without crashing
  if (workable.detect({ name: 'X', careers_url: 42 }) === null) {
    pass('workable.detect() returns null for non-string careers_url (42)');
  } else {
    fail('workable.detect() should treat non-string careers_url as missing');
  }

  // Workable parser tolerates a title with a stray pipe — URL is extracted from the line, not cols[7]
  const strayPipeMd = [
    '| Title | Department | Location | Type | Salary | Posted | Details |',
    '|---|---|---|---|---|---|---|',
    '| Senior PM (full | part-time) | Product | Remote | Full-time | — | 2026-04-01 | [View](https://apply.workable.com/x/jobs/view/PIPE.md) |',
  ].join('\n');
  const strayJobs = parseWorkableMarkdown(strayPipeMd, 'X');
  if (strayJobs.length === 1 && strayJobs[0].url === 'https://apply.workable.com/x/jobs/view/PIPE') {
    pass('parseWorkableMarkdown extracts URL from line-level regex (survives stray pipes in title)');
  } else {
    fail(`stray-pipe row not handled correctly: ${JSON.stringify(strayJobs)}`);
  }

  // Off-domain [View] link is dropped (URL validation)
  const offDomainMd = [
    '| Title | Department | Location | Type | Salary | Posted | Details |',
    '|---|---|---|---|---|---|---|',
    '| Good Role | Product | Remote | Full-time | — | 2026-04-01 | [View](https://apply.workable.com/x/jobs/view/ABC.md) |',
    '| Evil Role | Product | Remote | Full-time | — | 2026-04-01 | [View](https://evil.example/jobs/view/X) |',
    '| Insecure Role | Product | Remote | Full-time | — | 2026-04-01 | [View](http://apply.workable.com/x/jobs/view/Y.md) |',
  ].join('\n');
  const filteredJobs = parseWorkableMarkdown(offDomainMd, 'X');
  if (filteredJobs.length === 1 && filteredJobs[0].title === 'Good Role') {
    pass('parseWorkableMarkdown drops off-domain and non-https [View] links');
  } else {
    fail(`expected only "Good Role" through, got ${JSON.stringify(filteredJobs.map(j => j.title))}`);
  }

} catch (e) {
  fail(`workable provider tests crashed: ${e.message}`);
}

// ── 13. PROVIDERS — SmartRecruiters ─────────────────────────────────

console.log('\n13. Provider — smartrecruiters');

try {
  const sr = (await import(pathToFileURL(join(ROOT, 'providers/smartrecruiters.mjs')).href)).default;
  const { parseSmartRecruitersResponse } = await import(pathToFileURL(join(ROOT, 'providers/smartrecruiters.mjs')).href);

  if (sr.id === 'smartrecruiters') pass('smartrecruiters.id is "smartrecruiters"');
  else fail(`smartrecruiters.id is ${JSON.stringify(sr.id)}`);

  const hitCareers = sr.detect({ name: 'Adyen', careers_url: 'https://careers.smartrecruiters.com/adyen' });
  if (hitCareers && hitCareers.url.startsWith('https://api.smartrecruiters.com/v1/companies/adyen/postings')) {
    pass('smartrecruiters.detect() resolves careers.smartrecruiters.com/<slug> → api URL');
  } else {
    fail(`smartrecruiters.detect(careers) returned ${JSON.stringify(hitCareers)}`);
  }

  const hitJobs = sr.detect({ name: 'X', careers_url: 'https://jobs.smartrecruiters.com/x' });
  if (hitJobs && hitJobs.url.startsWith('https://api.smartrecruiters.com/v1/companies/x/postings')) {
    pass('smartrecruiters.detect() also handles jobs.smartrecruiters.com');
  } else {
    fail(`smartrecruiters.detect(jobs) returned ${JSON.stringify(hitJobs)}`);
  }

  if (sr.detect({ name: 'X', careers_url: 'https://example.com/careers' }) === null) {
    pass('smartrecruiters.detect() returns null for non-SR URLs');
  } else {
    fail('smartrecruiters.detect() should return null for non-SR URLs');
  }

  // parseSmartRecruitersResponse
  const sample = {
    content: [
      {
        id: 'abc-123',
        name: 'Senior PM',
        ref: 'https://api.smartrecruiters.com/v1/companies/sgs/postings/abc-123',
        location: { fullLocation: 'Geneva, Switzerland', remote: false },
      },
      {
        id: 'def-456',
        name: 'Remote AI Engineer',
        ref: 'https://api.smartrecruiters.com/v1/companies/sgs/postings/def-456',
        location: { city: 'Paris', country: 'France', remote: true },
      },
      {
        id: 'ghi-789',
        name: 'No-ref Role',
        location: { fullLocation: 'Berlin, Germany' },
      },
    ],
  };
  const jobs = parseSmartRecruitersResponse(sample, 'SGS');
  if (jobs.length === 3) pass('parseSmartRecruitersResponse extracts 3 jobs');
  else fail(`parseSmartRecruitersResponse returned ${jobs.length} jobs`);

  if (jobs[0]?.location === 'Geneva, Switzerland' && jobs[0]?.title === 'Senior PM') {
    pass('parseSmartRecruitersResponse uses fullLocation when present');
  } else {
    fail(`row 0 = ${JSON.stringify(jobs[0])}`);
  }

  // Location is place-only; remoteness is carried by workMode, not appended.
  if (jobs[1]?.location === 'Paris, France' && jobs[1]?.workMode === 'remote') {
    pass('parseSmartRecruitersResponse builds place-only location + workMode from city/country/remote');
  } else {
    fail(`row 1 = ${JSON.stringify({ location: jobs[1]?.location, workMode: jobs[1]?.workMode })}, expected location "Paris, France" + workMode "remote"`);
  }

  if (jobs[0]?.url === 'https://jobs.smartrecruiters.com/sgs/abc-123-senior-pm') {
    pass('parseSmartRecruitersResponse builds canonical <company>/<id>-<slug> URL from ref (no /postings/ 404)');
  } else {
    fail(`row 0 url = ${JSON.stringify(jobs[0]?.url)} (expected canonical /sgs/abc-123-senior-pm)`);
  }

  if (jobs[0]?.url && !jobs[0].url.includes('/postings/')) {
    pass('parseSmartRecruitersResponse never emits the API-only /postings/ path');
  } else {
    fail('parseSmartRecruitersResponse must not emit /postings/ (it 404s on the careers host)');
  }

  if (jobs[2]?.url && jobs[2].url.startsWith('https://jobs.smartrecruiters.com/sgs/ghi-789')) {
    pass('parseSmartRecruitersResponse falls back to synthetic URL when ref is missing');
  } else {
    fail(`row 2 url = ${JSON.stringify(jobs[2]?.url)}`);
  }

  // Empty input safety
  if (parseSmartRecruitersResponse({}, 'X').length === 0) pass('empty {} input → empty result');
  else fail('empty {} input should yield empty result');

  if (parseSmartRecruitersResponse({ content: 'not an array' }, 'X').length === 0) {
    pass('non-array content → empty result (no crash)');
  } else {
    fail('non-array content should yield empty result');
  }

  // careers_url with non-string value → detect() returns null without crashing
  if (sr.detect({ name: 'X', careers_url: { foo: 'bar' } }) === null) {
    pass('smartrecruiters.detect() returns null for non-string careers_url (object)');
  } else {
    fail('smartrecruiters.detect() should treat non-string careers_url as missing');
  }

  // Fallback URL when both ref AND id are missing → empty string (not "undefined" in URL)
  const noRefNoId = parseSmartRecruitersResponse(
    { content: [{ name: 'Stranded Role' }] },
    'X',
  );
  if (noRefNoId.length === 1 && noRefNoId[0].url === '') {
    pass('parseSmartRecruitersResponse returns url="" when both ref and id are missing');
  } else {
    fail(`expected url='' when ref+id both missing, got ${JSON.stringify(noRefNoId[0])}`);
  }

  // SSRF: malicious URL with smartrecruiters hostname in the PATH (not host) must not be detected.
  if (sr.detect({ name: 'Spoof', careers_url: 'https://evil.example/careers.smartrecruiters.com/slug' }) === null) {
    pass('smartrecruiters.detect() rejects path-spoofed URLs');
  } else {
    fail('smartrecruiters.detect() must NOT misdetect path-spoofed URLs');
  }

  // SmartRecruiters: untrusted j.ref host falls through to fallback rather than rewriting
  const bogusRef = parseSmartRecruitersResponse(
    { content: [{ id: 'X1', name: 'Strange Role', ref: 'https://evil.example/v1/companies/x/postings/X1' }] },
    'TestCo',
  );
  if (bogusRef[0]?.url && !bogusRef[0].url.includes('evil.example')) {
    pass('parseSmartRecruitersResponse rejects untrusted j.ref host (falls through to fallback)');
  } else {
    fail(`untrusted j.ref leaked into url: ${JSON.stringify(bogusRef[0]?.url)}`);
  }

  // SmartRecruiters: companyName with spaces/symbols is slugified for the fallback URL
  const slugifiedCompany = parseSmartRecruitersResponse(
    { content: [{ id: 'X2', name: 'Strange Role' }] },
    'My Acme & Co.',
  );
  if (slugifiedCompany[0]?.url === 'https://jobs.smartrecruiters.com/my-acme-co/X2-strange-role') {
    pass('parseSmartRecruitersResponse slugifies the companyName for the fallback URL');
  } else {
    fail(`fallback URL not properly slugified: ${JSON.stringify(slugifiedCompany[0]?.url)}`);
  }

  // Pagination: fetch() loops until an empty page (or short page) is returned
  let pageRequests = 0;
  const pagedJobs = await sr.fetch(
    { name: 'PagedCo', careers_url: 'https://careers.smartrecruiters.com/paged' },
    {
      transport: 'http',
      fetchText: async () => { throw new Error('fetchText should not be called'); },
      fetchJson: async (url) => {
        pageRequests++;
        const offset = parseInt(new URL(url).searchParams.get('offset') || '0', 10);
        if (offset === 0) {
          // Page 1: full page (100 items)
          return { content: Array.from({ length: 100 }, (_, i) => ({ id: `P1-${i}`, name: `Role 1-${i}` })) };
        }
        if (offset === 100) {
          // Page 2: short page (50 items) → loop stops after this
          return { content: Array.from({ length: 50 }, (_, i) => ({ id: `P2-${i}`, name: `Role 2-${i}` })) };
        }
        // Should not be reached because page 2 was short
        return { content: [] };
      },
    },
  );
  if (pageRequests === 2 && pagedJobs.length === 150) {
    pass('smartrecruiters.fetch() paginates and aggregates results (2 pages → 150 total)');
  } else {
    fail(`pagination: pageRequests=${pageRequests}, total=${pagedJobs.length} (expected 2 requests / 150 results)`);
  }

  // Pagination stop condition: empty content terminates the loop
  let emptyPageRequests = 0;
  const emptyJobs = await sr.fetch(
    { name: 'EmptyCo', careers_url: 'https://careers.smartrecruiters.com/empty' },
    {
      transport: 'http',
      fetchText: async () => { throw new Error('fetchText should not be called'); },
      fetchJson: async () => {
        emptyPageRequests++;
        return { content: [] };
      },
    },
  );
  if (emptyPageRequests === 1 && emptyJobs.length === 0) {
    pass('smartrecruiters.fetch() stops on the first empty page');
  } else {
    fail(`empty pagination: requests=${emptyPageRequests}, total=${emptyJobs.length}`);
  }

} catch (e) {
  fail(`smartrecruiters provider tests crashed: ${e.message}`);
}

// ── 14. PROVIDERS — Recruitee ───────────────────────────────────────

console.log('\n14. Provider — recruitee');

try {
  const recruitee = (await import(pathToFileURL(join(ROOT, 'providers/recruitee.mjs')).href)).default;
  const { parseRecruiteeResponse } = await import(pathToFileURL(join(ROOT, 'providers/recruitee.mjs')).href);

  if (recruitee.id === 'recruitee') pass('recruitee.id is "recruitee"');
  else fail(`recruitee.id is ${JSON.stringify(recruitee.id)}`);

  const hit = recruitee.detect({ name: 'Channable', careers_url: 'https://channable.recruitee.com' });
  if (hit && hit.url === 'https://channable.recruitee.com/api/offers/') {
    pass('recruitee.detect() resolves <slug>.recruitee.com → api offers');
  } else {
    fail(`recruitee.detect() returned ${JSON.stringify(hit)}`);
  }

  if (recruitee.detect({ name: 'X', careers_url: 'https://example.com/careers' }) === null) {
    pass('recruitee.detect() returns null for non-recruitee URLs');
  } else {
    fail('recruitee.detect() should return null for non-recruitee URLs');
  }

  // parseRecruiteeResponse
  const sample = {
    offers: [
      { title: 'Senior PM', careers_url: 'https://channable.recruitee.com/o/senior-pm', city: 'Utrecht', country: 'Netherlands', remote: false },
      { title: 'Backend Eng', url: 'https://channable.recruitee.com/o/backend', city: 'Amsterdam', country: 'Netherlands', remote: true },
      { title: 'AI Lead', location: 'Remote, EMEA' },
    ],
  };
  const jobs = parseRecruiteeResponse(sample, 'Channable');
  if (jobs.length === 3) pass('parseRecruiteeResponse extracts 3 offers');
  else fail(`parseRecruiteeResponse returned ${jobs.length} offers`);

  if (jobs[0]?.title === 'Senior PM' && jobs[0]?.company === 'Channable' && jobs[0]?.url === 'https://channable.recruitee.com/o/senior-pm') {
    pass('parseRecruiteeResponse prefers careers_url field over url');
  } else {
    fail(`row 0 = ${JSON.stringify(jobs[0])}`);
  }

  // Location is place-only; remoteness is carried by workMode, not appended.
  if (jobs[1]?.location === 'Amsterdam, Netherlands' && jobs[1]?.workMode === 'remote') {
    pass('parseRecruiteeResponse assembles place-only location + workMode from city/country/remote');
  } else {
    fail(`row 1 = ${JSON.stringify({ location: jobs[1]?.location, workMode: jobs[1]?.workMode })}, expected location "Amsterdam, Netherlands" + workMode "remote"`);
  }

  if (jobs[2]?.location === 'Remote, EMEA') {
    pass('parseRecruiteeResponse uses explicit location field when present');
  } else {
    fail(`row 2 location = ${JSON.stringify(jobs[2]?.location)}`);
  }

  if (parseRecruiteeResponse({}, 'X').length === 0) pass('empty {} → empty result');
  else fail('empty {} should yield empty result');

  if (parseRecruiteeResponse({ offers: null }, 'X').length === 0) {
    pass('null offers → empty result (no crash)');
  } else {
    fail('null offers should yield empty result');
  }

  // careers_url with non-string value → detect() returns null without crashing
  if (recruitee.detect({ name: 'X', careers_url: null }) === null && recruitee.detect({ name: 'X', careers_url: 7 }) === null) {
    pass('recruitee.detect() returns null for non-string careers_url (null and 7)');
  } else {
    fail('recruitee.detect() should treat non-string careers_url as missing');
  }

  // SSRF: malicious URL with recruitee.com in the PATH (not host) must not be detected.
  if (recruitee.detect({ name: 'Spoof', careers_url: 'https://evil.example/channable.recruitee.com/foo' }) === null) {
    pass('recruitee.detect() rejects path-spoofed URLs');
  } else {
    fail('recruitee.detect() must NOT misdetect path-spoofed URLs');
  }

  // Off-domain offer URL is dropped (URL validation)
  const offDomainOffers = parseRecruiteeResponse(
    {
      offers: [
        { title: 'Good', careers_url: 'https://channable.recruitee.com/o/good' },
        { title: 'Evil', careers_url: 'https://evil.example/o/evil' },
        { title: 'Insecure', careers_url: 'http://channable.recruitee.com/o/insecure' },
        { title: 'No URL field' },
      ],
    },
    'Channable',
  );
  if (offDomainOffers[0]?.url === 'https://channable.recruitee.com/o/good' && offDomainOffers[1]?.url === '' && offDomainOffers[2]?.url === '' && offDomainOffers[3]?.url === '') {
    pass('parseRecruiteeResponse drops off-domain, non-https, and missing offer URLs');
  } else {
    fail(`URL validation: row0=${JSON.stringify(offDomainOffers[0]?.url)}, row1=${JSON.stringify(offDomainOffers[1]?.url)}, row2=${JSON.stringify(offDomainOffers[2]?.url)}, row3=${JSON.stringify(offDomainOffers[3]?.url)}`);
  }

} catch (e) {
  fail(`recruitee provider tests crashed: ${e.message}`);
}

// ── 15. PROVIDERS — Hitmarker (games / esports board) ───────────────

console.log('\n15. Provider — hitmarker');

try {
  const hitmarker = (await import(pathToFileURL(join(ROOT, 'providers/hitmarker.mjs')).href)).default;
  const { parseHitmarkerResponse } = await import(pathToFileURL(join(ROOT, 'providers/hitmarker.mjs')).href);

  if (hitmarker.id === 'hitmarker') pass('hitmarker.id is "hitmarker"');
  else fail(`hitmarker.id is ${JSON.stringify(hitmarker.id)}`);

  const hit = hitmarker.detect({ name: 'Hitmarker', careers_url: 'https://hitmarker.net/jobs' });
  if (hit && hit.url === 'https://search.hitmarker.com/multi_search') {
    pass('hitmarker.detect() claims hitmarker.net careers URLs');
  } else {
    fail(`hitmarker.detect() returned ${JSON.stringify(hit)}`);
  }

  if (hitmarker.detect({ name: 'X', careers_url: 'https://boards.greenhouse.io/x' }) === null) {
    pass('hitmarker.detect() returns null for non-hitmarker URLs');
  } else {
    fail('hitmarker.detect() should return null for non-hitmarker URLs');
  }

  // SSRF / spoof guards: lookalike host and path-embedded domain must not match.
  if (
    hitmarker.detect({ name: 'Spoof', careers_url: 'https://evil-hitmarker.net' }) === null &&
    hitmarker.detect({ name: 'Spoof', careers_url: 'https://evil.example/hitmarker.net/jobs' }) === null &&
    hitmarker.detect({ name: 'X', careers_url: null }) === null
  ) {
    pass('hitmarker.detect() rejects lookalike hosts, path-spoofs, and non-string URLs');
  } else {
    fail('hitmarker.detect() must reject spoofed/invalid careers URLs');
  }

  // parseHitmarkerResponse against a Typesense multi_search shape.
  const sample = {
    results: [{
      hits: [
        {
          document: {
            id: '1700866',
            title: 'Gameplay Programmer',
            url: 'https://hitmarker.net/jobs/larian-studios-gameplay-programmer-1700866',
            jobCompany: { title: 'Larian Studios' },
            jobLocation: [{
              title: 'Guildford',
              parents: [
                { id: 'x4', title: 'Europe', type: 'continent' },
                { id: '232', title: 'UK', type: 'country' },
              ],
            }],
          },
        },
        // Remote-only doc: no city, country falls back to title alone.
        {
          document: {
            id: '2',
            title: 'Technical Artist',
            url: 'https://hitmarker.net/jobs/remote-ta-2',
            jobCompany: { title: 'Remote Studio' },
            jobLocation: [{ title: 'Remote', parents: [] }],
          },
        },
        // Malformed docs that must be dropped (no title / no url).
        { document: { id: '3', url: 'https://hitmarker.net/jobs/3' } },
        { document: { id: '4', title: 'No URL' } },
      ],
    }],
  };
  const jobs = parseHitmarkerResponse(sample);
  if (jobs.length === 2) pass('parseHitmarkerResponse keeps only docs with title + url');
  else fail(`parseHitmarkerResponse returned ${jobs.length} jobs (expected 2)`);

  if (jobs[0]?.company === 'Larian Studios' && jobs[0]?.location === 'Guildford, UK') {
    pass('parseHitmarkerResponse composes "City, Country" location');
  } else {
    fail(`row 0 = ${JSON.stringify(jobs[0])}`);
  }

  if (jobs[1]?.location === 'Remote') {
    pass('parseHitmarkerResponse falls back to city title when no country parent');
  } else {
    fail(`row 1 location = ${JSON.stringify(jobs[1]?.location)}`);
  }

  if (parseHitmarkerResponse({}).length === 0 && parseHitmarkerResponse({ results: [{ hits: null }] }).length === 0) {
    pass('parseHitmarkerResponse handles empty/null shapes without crashing');
  } else {
    fail('parseHitmarkerResponse should yield empty result for empty/null shapes');
  }

} catch (e) {
  fail(`hitmarker provider tests crashed: ${e.message}`);
}

// ── 12. TRACKER REPORT LINK NORMALIZATION (#760) ────────────────

console.log('\n12. Tracker report-link normalization');

try {
  const { normalizeReportLink } = await import(pathToFileURL(join(ROOT, 'tracker-links.mjs')).href);
  const repo = '/repo';
  const dataDir = join(repo, 'data');

  // data/ layout: root-relative TSV link → ../reports/...
  const fromTsv = normalizeReportLink('[12](reports/012-acme-2026-01-04.md)', dataDir, repo);
  if (fromTsv === '[12](../reports/012-acme-2026-01-04.md)') {
    pass('data/ layout: root-relative link rewritten to ../reports/...');
  } else {
    fail(`data/ layout normalization wrong: ${fromTsv}`);
  }

  // Idempotent: re-running on an already-normalized link must not double-prefix
  const twice = normalizeReportLink(fromTsv, dataDir, repo);
  if (twice === fromTsv) {
    pass('normalization is idempotent (no double-prefix on re-run)');
  } else {
    fail(`normalization not idempotent: ${twice}`);
  }

  // Root layout: tracker at repo root → link stays reports/...
  const atRoot = normalizeReportLink('[12](reports/012-acme-2026-01-04.md)', repo, repo);
  if (atRoot === '[12](reports/012-acme-2026-01-04.md)') {
    pass('root layout: link stays root-relative reports/...');
  } else {
    fail(`root layout normalization wrong: ${atRoot}`);
  }

  // Non-report links are left untouched — including external URLs that happen
  // to contain an embedded "/reports/" segment (must not be rewritten).
  const other = normalizeReportLink('[site](https://example.com/reports/foo.md)', dataDir, repo);
  if (other === '[site](https://example.com/reports/foo.md)') {
    pass('non-report links (incl. URLs with embedded /reports/) are left untouched');
  } else {
    fail(`non-report link altered: ${other}`);
  }

  // End-to-end migration against a fictional fixture tracker (no personal data)
  const tmpDir = mkdtempSync(join(tmpdir(), 'career-ops-migrate-'));
  try {
    mkdirSync(join(tmpDir, 'data'));
    mkdirSync(join(tmpDir, 'reports'));
    writeFileSync(join(tmpDir, 'reports', '012-acme-2026-01-04.md'), '# fixture\n');
    const tracker = join(tmpDir, 'data', 'applications.md');
    writeFileSync(tracker,
      '# Applications Tracker\n\n' +
      '| # | Date | Company | Role | Score | Status | PDF | Report | Notes |\n' +
      '|---|------|---------|------|-------|--------|-----|--------|-------|\n' +
      '| 12 | 2026-01-04 | Acme | Engineer | 4.2/5 | Evaluated | ✅ | [12](reports/012-acme-2026-01-04.md) | ok |\n');

    // Migrate by pointing the script at the fixture tracker via env override.
    run(NODE, ['merge-tracker.mjs', '--migrate'], { env: { ...process.env, CAREER_OPS_TRACKER: tracker } });
    const after = readFileSync(tracker, 'utf-8');
    if (after.includes('[12](../reports/012-acme-2026-01-04.md)')) {
      pass('migration rewrites fixture tracker links to ../reports/...');
    } else {
      fail('migration did not rewrite fixture tracker link');
    }
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
} catch (e) {
  fail(`tracker-link normalization tests crashed: ${e.message}`);
}

console.log('\n16. Snapshot dedup — posting-ID + aggregator-gated collapsing');

try {
  const { dedupeSnapshot, postingId } = await import(pathToFileURL(join(ROOT, 'scan.mjs')).href);

  // postingId extraction
  if (postingId('https://www.riotgames.com/en/work-with-us/job/7838553?gh_jid=7838553') === '7838553') pass('postingId reads gh_jid query param');
  else fail('postingId should read gh_jid');
  if (postingId('https://goodbyekansas.teamtailor.com/jobs/6607983-realtime-artist') === '6607983') pass('postingId reads leading numeric of /jobs/<id>-slug');
  else fail('postingId should read Teamtailor path id');
  if (postingId('https://jobs.lever.co/acme/abc-uuid-def') === null) pass('postingId returns null for non-numeric (Lever UUID)');
  else fail('postingId should be null for Lever UUID');

  const jobs = [
    // Pass 1 — same company + posting ID across DIFFERENT hosts (Teamtailor studio
    // subdomain mirrored on parent-group domain), even with a differing location
    // string → collapse to one.
    { title: 'Level Designer', company: 'Sandbox Interactive', location: 'Berlin, DE', url: 'https://sandboxinteractive.teamtailor.com/jobs/7363029-level-designer' },
    { title: 'Level Designer', company: 'Sandbox Interactive', location: 'Berlin, Germany', url: 'https://stillfrontgroup.teamtailor.com/jobs/7363029-level-designer' },
    // Pass 2 — aggregator mirror of a direct posting → drop the aggregator row.
    { title: 'Senior Software Engineer', company: 'Riot Games', location: 'Los Angeles, USA', url: 'https://www.riotgames.com/en/work-with-us/job/7838553?gh_jid=7838553' },
    { title: 'Senior Software Engineer', company: 'Riot Games', location: 'Los Angeles, USA', url: 'https://hitmarker.net/jobs/riot-games-senior-software-engineer-123' },
    // Two DISTINCT reqs: same title/company/location, different IDs, both direct,
    // no aggregator → keep BOTH (the Epic false-positive guard).
    { title: 'Gameplay Programmer', company: 'Epic Games', location: 'Cary, NC, USA', url: 'https://epicgames.com/careers/jobs/6001690004?gh_jid=6001690004' },
    { title: 'Gameplay Programmer', company: 'Epic Games', location: 'Cary, NC, USA', url: 'https://epicgames.com/careers/jobs/6001706004?gh_jid=6001706004' },
    // Singleton → untouched
    { title: 'Tools Engineer', company: 'Naughty Dog', location: 'Santa Monica, CA', url: 'https://job-boards.greenhouse.io/naughtydog/jobs/12345' },
  ];

  const { jobs: out, collapsed, collapsedById, collapsedByHeuristic } = dedupeSnapshot(jobs);

  if (collapsedById === 1) pass('pass 1 collapses one same-company+ID mirror (across hosts, differing location)');
  else fail(`expected 1 collapsed by ID, got ${collapsedById}`);

  if (collapsedByHeuristic === 1) pass('pass 2 drops one aggregator mirror that has a direct twin');
  else fail(`expected 1 collapsed by heuristic, got ${collapsedByHeuristic}`);

  if (collapsed === 2 && out.length === 5) pass('total: 7 → 5 (one ID dupe + one aggregator mirror removed)');
  else fail(`expected 5 jobs out (collapsed 2), got ${out.length} (collapsed ${collapsed})`);

  const riot = out.filter(j => j.company === 'Riot Games');
  if (riot.length === 1 && riot[0].url.includes('riotgames.com')) pass('aggregator pass keeps the direct URL, drops Hitmarker');
  else fail('aggregator pass should keep the direct riotgames.com URL');

  const epic = out.filter(j => j.company === 'Epic Games');
  if (epic.length === 2) pass('two distinct direct reqs are never merged (Epic false-positive guard)');
  else fail(`distinct Epic reqs should both survive, got ${epic.length}`);

  const sandbox = out.filter(j => j.company === 'Sandbox Interactive');
  if (sandbox.length === 1) pass('Teamtailor cross-host mirror collapsed to one');
  else fail(`Sandbox mirror should collapse to 1, got ${sandbox.length}`);

  // Configurable aggregator list: flag Teamtailor's parent-group domain instead.
  // With the ID pass already collapsing Sandbox, prove the aggregator list is read
  // by making WorkWithIndies a no-op default still removes Hitmarker.
  const { jobs: out2, collapsedByHeuristic: h2 } = dedupeSnapshot(jobs, { aggregators: [] });
  if (h2 === 0 && out2.filter(j => j.url.includes('hitmarker.net')).length === 1) {
    pass('empty aggregator list disables pass 2 (Hitmarker mirror retained)');
  } else {
    fail('empty aggregator list should leave aggregator mirrors in place');
  }
} catch (e) {
  fail(`snapshot dedup tests crashed: ${e.message}`);
}

// ── WORK MODE: location split + multi-source fields ─────────────

console.log('\n17. Work mode — location split + multi-source filter fields');
try {
  const { splitLocationMode, normalizeWorkMode } = await import(pathToFileURL(join(ROOT, 'providers/_util.mjs')).href);
  const { fieldText, isExcluded, matchGroup } = await import(pathToFileURL(join(ROOT, 'rank.mjs')).href);

  // splitLocationMode: strip the mode token from common shapes, derive workMode.
  const cases = [
    ['United States, Remote', 'United States', 'remote'],
    ['Remote (US)', 'US', 'remote'],
    ['New York - Remote; New York, United States', 'New York; New York, United States', 'remote'],
    ['London (Hybrid)', 'London', 'hybrid'],
    ['Berlin, hybrid', 'Berlin', 'hybrid'],
    ['Warsaw - On-site', 'Warsaw', 'onsite'],
    ['Helsinki', 'Helsinki', ''],        // no token → untouched
    ['Remote', '', 'remote'],
    ['Anywhere', '', 'anywhere'],        // geography-free → 4th state
    ['Distributed', '', 'anywhere'],
    ['Remote, Anywhere', '', 'anywhere'],// most permissive wins
  ];
  let splitOk = true;
  for (const [input, loc, mode] of cases) {
    const r = splitLocationMode(input);
    if (r.location !== loc || r.workMode !== mode) {
      splitOk = false;
      fail(`splitLocationMode(${JSON.stringify(input)}) = ${JSON.stringify(r)}, expected {location:${JSON.stringify(loc)}, workMode:${JSON.stringify(mode)}}`);
    }
  }
  if (splitOk) pass(`splitLocationMode strips mode token across ${cases.length} location shapes`);

  if (normalizeWorkMode('OnSite') === 'onsite' && normalizeWorkMode('Hybrid') === 'hybrid'
      && normalizeWorkMode('Anywhere') === 'anywhere' && normalizeWorkMode('distributed') === 'anywhere'
      && normalizeWorkMode('unspecified') === '') {
    pass('normalizeWorkMode maps ATS values to the work-mode enum (unknown → "")');
  } else {
    fail('normalizeWorkMode enum mapping wrong');
  }

  // fieldText: array field joins multiple sources into one combined string.
  const job = { title: 'Eng', company: 'X', location: 'US', workMode: 'remote', department: 'Audio' };
  if (fieldText(job, ['location', 'workmode']) === 'US remote') {
    pass('fieldText(array) joins multiple sources (location + workmode)');
  } else {
    fail(`fieldText(['location','workmode']) = ${JSON.stringify(fieldText(job, ['location', 'workmode']))}`);
  }

  // Cross-field exclude only works when the group reads BOTH sources.
  const usOnlyRemote = { id: 'g', field: ['location', 'workmode'], combine: 'min',
    filters: [{ id: 'x', keywords: ['/^(?=.*remote)(?=.*\\bus)/'], weight: 0 }] };
  const single = { ...usOnlyRemote, field: 'location' };
  if (isExcluded(job, [usOnlyRemote]) && !isExcluded(job, [single])) {
    pass('cross-field "US-only remote" excludes via [location, workmode], not location alone');
  } else {
    fail(`cross-field exclude: combined=${isExcluded(job, [usOnlyRemote])} (want true), location-only=${isExcluded(job, [single])} (want false)`);
  }

  // workmode field matches the structured token; unknown falls through.
  const g = { id: 'm', field: 'workmode', combine: 'min', filters: [{ id: 'h', keywords: ['hybrid'], weight: 1.5 }] };
  if (matchGroup({ workMode: 'hybrid' }, g).length === 1 && matchGroup({}, g).length === 0) {
    pass('workmode field matches hybrid token; unknown work mode does not match');
  } else {
    fail('workmode field matching wrong');
  }
} catch (e) {
  fail(`work-mode tests crashed: ${e.message}`);
}

// ── Provider — breezy ───────────────────────────────────────────

console.log('\n16. Provider — breezy');

try {
  const breezy = (await import(pathToFileURL(join(ROOT, 'providers/breezy.mjs')).href)).default;
  const { parseBreezyFeed } = await import(pathToFileURL(join(ROOT, 'providers/breezy.mjs')).href);

  if (breezy.id === 'breezy') pass('breezy.id is "breezy"');
  else fail(`breezy.id is ${JSON.stringify(breezy.id)}`);

  const hit = breezy.detect({ name: 'Pine Creek Games', careers_url: 'https://pine-creek-games.breezy.hr/' });
  if (hit && hit.url === 'https://pine-creek-games.breezy.hr/json') {
    pass('breezy.detect() derives {tenant}/json from a *.breezy.hr careers URL');
  } else {
    fail(`breezy.detect() returned ${JSON.stringify(hit)}`);
  }

  if (
    breezy.detect({ careers_url: 'https://marketing.breezy.hr/json' }) === null &&
    breezy.detect({ careers_url: 'https://app.breezy.hr' }) === null &&
    breezy.detect({ careers_url: 'https://breezy.hr' }) === null
  ) {
    pass('breezy.detect() skips bare breezy.hr and reserved (marketing/app) subdomains');
  } else {
    fail('breezy.detect() must skip bare host and reserved subdomains');
  }

  if (
    breezy.detect({ careers_url: 'https://evil-breezy.hr' }) === null &&
    breezy.detect({ careers_url: 'https://evil.example/breezy.hr/json' }) === null &&
    breezy.detect({ careers_url: null }) === null
  ) {
    pass('breezy.detect() rejects lookalike hosts, path-spoofs, and non-string URLs');
  } else {
    fail('breezy.detect() must reject spoofed/invalid careers URLs');
  }

  // parseBreezyFeed against the real /json array shape.
  const sample = [
    {
      name: '2D Animator',
      url: 'https://pine-creek-games.breezy.hr/p/00b4-2d-animator',
      published_date: '2026-06-11T13:00:03.186Z',
      department: 'Art and Animation',
      location: { country: { name: 'Denmark', id: 'DK' }, is_remote: true, remote_details: { value: 'remote-location' }, name: 'Copenhagen' },
      company: { name: 'Pine Creek Games' },
    },
    // is_remote anywhere → workMode 'anywhere'; no company → fallback name.
    { name: 'Designer', url: 'https://x.breezy.hr/p/2', location: { is_remote: true, remote_details: { value: 'remote-anywhere' }, name: 'Anywhere' } },
    // Malformed: dropped (no name / no url).
    { url: 'https://x.breezy.hr/p/3' },
    { name: 'No URL' },
  ];
  const jobs = parseBreezyFeed(sample, 'Fallback Studio');
  if (jobs.length === 2) pass('parseBreezyFeed keeps only items with name + url');
  else fail(`parseBreezyFeed returned ${jobs.length} jobs (expected 2)`);

  if (jobs[0]?.company === 'Pine Creek Games' && jobs[0]?.location === 'Copenhagen, Denmark' && jobs[0]?.workMode === 'remote' && jobs[0]?.department === 'Art and Animation') {
    pass('parseBreezyFeed maps company/location/workMode/department');
  } else {
    fail(`row 0 = ${JSON.stringify(jobs[0])}`);
  }

  if (jobs[1]?.company === 'Fallback Studio' && jobs[1]?.workMode === 'anywhere') {
    pass('parseBreezyFeed falls back to entry name and maps remote-anywhere → anywhere');
  } else {
    fail(`row 1 = ${JSON.stringify(jobs[1])}`);
  }

  if (parseBreezyFeed(null, 'X').length === 0 && parseBreezyFeed({}, 'X').length === 0) {
    pass('parseBreezyFeed handles null/non-array shapes without crashing');
  } else {
    fail('parseBreezyFeed should yield empty result for null/non-array shapes');
  }
} catch (e) {
  fail(`breezy provider tests crashed: ${e.message}`);
}

// ── Provider — remote-game-jobs ─────────────────────────────────

console.log('\n17. Provider — remote-game-jobs');

try {
  const rgj = (await import(pathToFileURL(join(ROOT, 'providers/remotegamejobs.mjs')).href)).default;
  const { parseRemoteGameJobsFeed } = await import(pathToFileURL(join(ROOT, 'providers/remotegamejobs.mjs')).href);

  if (rgj.id === 'remote-game-jobs') pass('remote-game-jobs.id is "remote-game-jobs"');
  else fail(`remote-game-jobs.id is ${JSON.stringify(rgj.id)}`);

  const hit = rgj.detect({ careers_url: 'https://remotegamejobs.com/' });
  if (hit && hit.url === 'https://remotegamejobs.com/feed.rss') {
    pass('remote-game-jobs.detect() claims remotegamejobs.com careers URLs');
  } else {
    fail(`remote-game-jobs.detect() returned ${JSON.stringify(hit)}`);
  }

  if (
    rgj.detect({ careers_url: 'https://boards.greenhouse.io/x' }) === null &&
    rgj.detect({ careers_url: 'https://evil-remotegamejobs.com' }) === null &&
    rgj.detect({ careers_url: null }) === null
  ) {
    pass('remote-game-jobs.detect() rejects non-RGJ, lookalike, and non-string URLs');
  } else {
    fail('remote-game-jobs.detect() must reject spoofed/invalid careers URLs');
  }

  const sampleXml = `<rss><channel>
    <item>
      <title>Pine Creek Games is hiring 2D Animator (Remote Job)</title>
      <link>https://remotegamejobs.com/jobs/pine-creek-games-2d-animator-remote-job</link>
      <pubDate>Sat, 13 Jun 2026 15:04:00 +0000</pubDate>
    </item>
    <item>
      <title>Acme &amp; Co is hiring a Senior Tools Engineer (Remote Job)</title>
      <link>https://remotegamejobs.com/jobs/acme-co-senior-tools-engineer-remote-job</link>
    </item>
    <item>
      <title>A free-form headline that does not match</title>
      <link>https://remotegamejobs.com/jobs/weird-one</link>
    </item>
    <item>
      <title>No link here</title>
    </item>
  </channel></rss>`;
  const jobs = parseRemoteGameJobsFeed(sampleXml);
  if (jobs.length === 3) pass('parseRemoteGameJobsFeed keeps items with title + link');
  else fail(`parseRemoteGameJobsFeed returned ${jobs.length} jobs (expected 3)`);

  if (jobs[0]?.company === 'Pine Creek Games' && jobs[0]?.title === '2D Animator' && jobs[0]?.workMode === 'remote' && jobs[0]?.postedDate === '2026-06-13T15:04:00.000Z') {
    pass('parseRemoteGameJobsFeed splits "{Company} is hiring {Role} (Remote Job)" + parses pubDate');
  } else {
    fail(`row 0 = ${JSON.stringify(jobs[0])}`);
  }

  if (jobs[1]?.company === 'Acme & Co' && jobs[1]?.title === 'Senior Tools Engineer') {
    pass('parseRemoteGameJobsFeed strips a/an and decodes entities in title');
  } else {
    fail(`row 1 = ${JSON.stringify(jobs[1])}`);
  }

  if (jobs[2]?.company === '' && jobs[2]?.title === 'A free-form headline that does not match') {
    pass('parseRemoteGameJobsFeed keeps non-matching titles raw (fail-safe)');
  } else {
    fail(`row 2 = ${JSON.stringify(jobs[2])}`);
  }

  if (parseRemoteGameJobsFeed(null).length === 0 && parseRemoteGameJobsFeed('').length === 0) {
    pass('parseRemoteGameJobsFeed handles null/empty input without crashing');
  } else {
    fail('parseRemoteGameJobsFeed should yield empty result for null/empty input');
  }
} catch (e) {
  fail(`remote-game-jobs provider tests crashed: ${e.message}`);
}

// ── Provider `probe` descriptor contract (probe-studios auto-discovery) ──

console.log('\n18. Provider probe descriptors');

try {
  const { readdirSync } = await import('node:fs');
  const dir = join(ROOT, 'providers');
  const files = readdirSync(dir).filter(f => f.endsWith('.mjs') && !f.startsWith('_'));
  let withProbe = 0;
  let contractOk = true;
  for (const f of files) {
    const mod = await import(pathToFileURL(join(dir, f)).href);
    if (!mod.probe) continue;
    withProbe++;
    const p = mod.probe;
    const eps = p.endpoints;
    const epsOk = Array.isArray(eps) && eps.length > 0 && eps.every(e =>
      (e.kind === 'slug' || e.kind === 'domain') &&
      typeof e.url === 'function' && typeof e.where === 'function' && typeof e.parse === 'function');
    const slugsOk = p.slugs === undefined || typeof p.slugs === 'function';
    if (!epsOk || !slugsOk) { contractOk = false; fail(`${f}: malformed probe descriptor`); }
  }
  if (contractOk) pass(`all ${withProbe} probe descriptors are well-formed (endpoints + url/where/parse fns)`);
  // The discoverable ATS set should at least include the keyless slug providers.
  if (withProbe >= 8) pass(`${withProbe} providers are slug-discoverable (auto-loaded by probe-studios.mjs)`);
  else fail(`expected >= 8 discoverable providers, found ${withProbe}`);

  // A 'domain'-kind endpoint must declare HIGH confidence (own-domain = trusted).
  const tt = (await import(pathToFileURL(join(dir, 'teamtailor.mjs')).href)).probe;
  const dom = tt.endpoints.find(e => e.kind === 'domain');
  if (dom && dom.confidence === 'high') pass('teamtailor domain endpoint is HIGH confidence');
  else fail('teamtailor domain endpoint should be HIGH confidence');

  // parse() returns a hit for a real shape and null for a miss.
  const gh = (await import(pathToFileURL(join(dir, 'greenhouse.mjs')).href)).probe.endpoints[0];
  if (gh.parse({ jobs: [{ location: { name: 'Berlin' } }] })?.count === 1 && gh.parse({}) === null) {
    pass('greenhouse probe parse() reads jobs[] and rejects empty shapes');
  } else {
    fail('greenhouse probe parse() contract wrong');
  }
} catch (e) {
  fail(`probe descriptor tests crashed: ${e.message}`);
}

// ── Adaptive probe runner: canary + restrict + side-effect-free import ──

console.log('\n19. Adaptive probe runner (waves / canary / restrict)');

try {
  const dir = join(ROOT, 'providers');
  // Importing probe-studios.mjs must NOT run the probe (guarded by run-as-main).
  const ps = await import(pathToFileURL(join(ROOT, 'probe-studios.mjs')).href);
  if (typeof ps.probe === 'function' && typeof ps.runEndpoint === 'function' && typeof ps.checkCanaries === 'function') {
    pass('probe-studios.mjs imports side-effect-free and exports probe/runEndpoint/checkCanaries');
  } else {
    fail('probe-studios.mjs missing expected test exports');
  }

  // classifyStatus: the inverted certainty model (404 = certain, throttle = uncertain).
  const cs = ps._classifyStatus;
  if (cs(404).kind === 'notfound' && cs(200).kind === 'data' &&
      cs(403).kind === 'uncertain' && cs(429).kind === 'uncertain' && cs(503).kind === 'uncertain') {
    pass('classifyStatus: 404→notfound, 2xx→data, 403/429/5xx→uncertain');
  } else {
    fail('classifyStatus contract wrong');
  }

  // The breezy provider declares a canary (known-live tenant) for 404 distrust.
  const breezy = (await import(pathToFileURL(join(dir, 'breezy.mjs')).href)).probe;
  if (breezy.canary === 'pine-creek-games') pass('breezy probe declares a canary (pine-creek-games) for 404-as-throttle defense');
  else fail('breezy probe should declare canary pine-creek-games');

  // restrict: probe() with an empty restrict set hits NO providers → clean miss,
  // no network, no throw (proves later waves can scope to specific ATSes).
  const tracked = { names: new Set(), hosts: new Set() };
  const fakeProviders = [{ id: 'greenhouse', endpoints: [{ kind: 'slug', url: () => 'http://127.0.0.1:9/x', where: (s) => s, parse: () => null }] }];
  const r = await ps.probe({ name: 'Nonexistent Studio XYZ' }, tracked, fakeProviders, { restrict: new Set() });
  if (r && r.ats === null && !r.uncertain) pass('probe(restrict:∅) probes nothing → clean miss (waves can scope to one ATS)');
  else fail(`probe restrict-empty should be a clean miss, got ${JSON.stringify(r)}`);

  // dedup: a studio already tracked short-circuits to skipped (no network).
  const tracked2 = { names: new Set([ps.norm('Tracked Studio')]), hosts: new Set() };
  const r2 = await ps.probe({ name: 'Tracked Studio' }, tracked2, fakeProviders, {});
  if (r2 && r2.skipped) pass('probe() skips a studio already in studios.yml (no probing)');
  else fail(`probe dedup should skip, got ${JSON.stringify(r2)}`);

  // ── probe-state ledger (progressive draining) ──
  const ids = ['greenhouse', 'breezy', 'workable'];
  const led = new Map();
  // no entry → null (probe everything)
  const open0 = ps.ledgerOpen(led, 'studio-a', ids);
  // partial: greenhouse cleared → only breezy+workable open
  led.set('studio-b', { name: 'B', version: ps.SCAN_VERSION, hit: '', missed: new Set(['greenhouse']), last: '2026-06-14' });
  const openB = ps.ledgerOpen(led, 'studio-b', ids);
  // fully cleared → empty Set (caller skips)
  led.set('studio-c', { name: 'C', version: ps.SCAN_VERSION, hit: '', missed: new Set(ids), last: 'x' });
  const openC = ps.ledgerOpen(led, 'studio-c', ids);
  // stale version → null (misses invalidated, re-probe all)
  led.set('studio-d', { name: 'D', version: ps.SCAN_VERSION - 1, hit: '', missed: new Set(ids), last: 'x' });
  const openD = ps.ledgerOpen(led, 'studio-d', ids);
  if (open0 === null && openB.size === 2 && !openB.has('greenhouse') && openC.size === 0 && openD === null) {
    pass('ledgerOpen: none→all, partial→open subset, full→skip, stale-version→re-probe all');
  } else {
    fail(`ledgerOpen logic wrong: open0=${open0} B=${[...(openB||[])]} C=${openC&&openC.size} D=${openD}`);
  }
  // mergeLedger unions new misses onto known ones; a stale prior is reset first.
  const lm = new Map([['k', { name: 'K', version: ps.SCAN_VERSION, hit: '', missed: new Set(['greenhouse']), last: 'x' }]]);
  ps.mergeLedger(lm, 'k', 'K', { ats: null, missedAts: ['breezy'] });
  const lm2 = new Map([['s', { name: 'S', version: ps.SCAN_VERSION - 1, hit: '', missed: new Set(['lever']), last: 'x' }]]);
  ps.mergeLedger(lm2, 's', 'S', { ats: null, missedAts: ['ashby'] });
  if ([...lm.get('k').missed].sort().join(',') === 'breezy,greenhouse' && [...lm2.get('s').missed].join(',') === 'ashby') {
    pass('mergeLedger: unions at current version, resets a stale-version record');
  } else {
    fail('mergeLedger union/reset wrong');
  }

  // --quick must NOT close a provider that has an untried domain endpoint (it
  // skips the custom-domain sweep), so a later full run still probes it. A
  // slug-only provider IS fully covered by quick and DOES close. We re-import
  // with --quick in argv (cache-busted) since QUICK is read at module load.
  const savedArgv = process.argv;
  process.argv = [...savedArgv, '--quick'];
  const psQ = await import(pathToFileURL(join(ROOT, 'probe-studios.mjs')).href + '?quick=1');
  process.argv = savedArgv;
  // A tiny local server that 200s with an empty body, so parse()→null is a CLEAN
  // miss (not a network/uncertain). Both providers point at it.
  const tQ = { names: new Set(), hosts: new Set() };
  const http = await import('node:http');
  const srv = http.createServer((_, res) => { res.writeHead(200); res.end(''); });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const portUrl = `http://127.0.0.1:${srv.address().port}/x`;
  const missEndpoint = { url: () => portUrl, where: (s) => s, parse: () => null };
  const provDomain = { id: 'teamtailor', endpoints: [{ kind: 'slug', ...missEndpoint }, { kind: 'domain', ...missEndpoint }] };
  const provSlug = { id: 'greenhouse', endpoints: [{ kind: 'slug', ...missEndpoint }] };
  const rQ = await psQ.probe({ name: 'Nonexistent Studio XYZ' }, tQ, [provDomain, provSlug], {});
  await new Promise((r) => srv.close(r));
  const missed = new Set(rQ.missedAts || []);
  if (!missed.has('teamtailor') && missed.has('greenhouse')) {
    pass('quick mode: leaves domain-capable provider OPEN in ledger, closes slug-only provider');
  } else {
    fail(`quick miss-recording wrong: missedAts=${[...missed]}`);
  }

  // per-host gate: a burst to ONE host is capped (default 4) so a WAF can't be
  // tripped; different hosts run fully in parallel (unaffected).
  let activeH = 0, peakH = 0, peakOther = 0, activeOther = 0;
  const slow = (track) => async () => { track(1); await new Promise((r) => setTimeout(r, 15)); track(-1); };
  const trackH = (d) => { activeH += d; peakH = Math.max(peakH, activeH); };
  const trackO = (d) => { activeOther += d; peakOther = Math.max(peakOther, activeOther); };
  await Promise.all([
    ...Array.from({ length: 12 }, () => ps._withHostLimit('one.example', slow(trackH))),
    ...Array.from({ length: 6 }, () => ps._withHostLimit('two.example', slow(trackO))),
  ]);
  if (peakH <= 4 && peakOther <= 4 && peakOther >= 1) {
    pass(`per-host gate caps one host's burst (peak ${peakH} ≤ 4) while other hosts run in parallel`);
  } else {
    fail(`per-host gate wrong: peakH=${peakH} peakOther=${peakOther}`);
  }
} catch (e) {
  fail(`adaptive probe runner tests crashed: ${e.message}`);
}

// ── 20. FETCH ERROR CLASSIFICATION ──────────────────────────────
console.log('\n20. Fetch error classification (throttle/block monitoring)');
try {
  const { classifyFetchError } = await import(pathToFileURL(join(ROOT, 'providers/_http.mjs')).href);
  const cases = [
    [{ status: 429, message: 'HTTP 429: error code: 1015' }, 'throttled', 'Cloudflare 1015 → throttled'],
    [{ status: 503, message: 'unavailable' }, 'throttled', '503 → throttled'],
    [{ status: 200, message: 'Too Many Requests' }, 'throttled', 'rate-limit copy in body → throttled'],
    [{ status: 403, message: 'forbidden' }, 'blocked', '403 → blocked'],
    [{ status: 401, message: 'unauthorized' }, 'blocked', '401 → blocked'],
    [{ status: 404, message: 'not found' }, 'notfound', '404 → notfound (benign, not a miss)'],
    [{ name: 'AbortError', message: 'aborted' }, 'timeout', 'AbortError → timeout'],
    [{ message: 'fetch failed' }, 'network', 'network error → network'],
    [{ status: 500, message: 'boom' }, 'http', 'other HTTP → http'],
  ];
  let allOk = true;
  for (const [inp, exp, label] of cases) {
    const got = classifyFetchError(inp);
    if (got !== exp) { allOk = false; fail(`classifyFetchError: ${label} (got "${got}")`); }
  }
  if (allOk) pass(`classifyFetchError maps ${cases.length} cases correctly (throttle/block/notfound/timeout/network/http)`);
  // Throttle and block are the two "miss" kinds the scanner aggregates into a
  // provider-blackout signal; everything else is benign or a plain error.
  const miss = (k) => k === 'throttled' || k === 'blocked';
  if (miss(classifyFetchError({ status: 429 })) && miss(classifyFetchError({ status: 403 })) &&
      !miss(classifyFetchError({ status: 404 })) && !miss(classifyFetchError({ message: 'x' }))) {
    pass('miss-kinds (throttled/blocked) stay distinct from benign 404/network — no silent blackout');
  } else {
    fail('miss-kind partition is wrong — blackout detection would misfire');
  }
} catch (e) {
  fail(`fetch error classification tests crashed: ${e.message}`);
}

// ── 21. HEALTH TALLY (departed-ATS detection) ───────────────────
console.log('\n21. Health tally (per-company failure streaks)');
try {
  const { mergeHealth } = await import(pathToFileURL(join(ROOT, 'merge-health.mjs')).href);
  const T = 3;
  const d = (s) => new Date(`2026-06-0${s}T00:00:00Z`);

  // A streak builds across runs and fires an alert exactly at the threshold.
  let s = mergeHealth(null, [{ name: 'Acme', ok: false, error: 'HTTP 404', kind: 'notfound' }], { threshold: T, now: d(1) });
  let ok1 = s.companies.Acme.fails === 1 && s.alerts.length === 0;
  s = mergeHealth(s, [{ name: 'Acme', ok: false, error: 'HTTP 403', kind: 'blocked' }], { threshold: T, now: d(2) });
  ok1 = ok1 && s.companies.Acme.fails === 2 && s.companies.Acme.since === '2026-06-01' && s.alerts.length === 0;
  s = mergeHealth(s, [{ name: 'Acme', ok: false, error: 'timeout', kind: 'timeout' }], { threshold: T, now: d(3) });
  ok1 = ok1 && s.companies.Acme.fails === 3 && s.alerts.join() === 'Acme';
  if (ok1) pass('streak increments across runs (any error kind), `since` is pinned, alert fires at threshold');
  else fail(`streak/alert wrong: ${JSON.stringify(s)}`);

  // A single success resets the streak (dropped) and clears the alert.
  const recovered = mergeHealth(s, [{ name: 'Acme', ok: true }], { threshold: T, now: d(4) });
  if (!recovered.companies.Acme && recovered.alerts.length === 0) {
    pass('one reachable fetch resets the streak and clears the alert');
  } else {
    fail(`recovery did not reset: ${JSON.stringify(recovered)}`);
  }

  // A company NOT attempted this run carries forward untouched (scoped runs and
  // temporary studios.yml removals must not reset or drop another's streak).
  const carried = mergeHealth(s, [{ name: 'Other', ok: true }], { threshold: T, now: d(4) });
  if (carried.companies.Acme && carried.companies.Acme.fails === 3 && carried.alerts.join() === 'Acme') {
    pass('un-attempted companies carry forward unchanged (no reset, no drop)');
  } else {
    fail(`carry-forward wrong: ${JSON.stringify(carried)}`);
  }
} catch (e) {
  fail(`health tally tests crashed: ${e.message}`);
}

// ── SUMMARY ─────────────────────────────────────────────────────

console.log('\n' + '='.repeat(50));
console.log(`📊 Results: ${passed} passed, ${failed} failed, ${warnings} warnings`);

if (failed > 0) {
  console.log('🔴 TESTS FAILED — do NOT push/merge until fixed\n');
  process.exit(1);
} else if (warnings > 0) {
  console.log('🟡 Tests passed with warnings — review before pushing\n');
  process.exit(0);
} else {
  console.log('🟢 All tests passed — safe to push/merge\n');
  process.exit(0);
}
