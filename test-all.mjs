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

// ── 11b. Aggregator employer blocklist (buildCompanyBlocklist) ──────
console.log('\n11b. Aggregator employer blocklist');
try {
  const { buildCompanyBlocklist } = await import(pathToFileURL(join(ROOT, 'scan.mjs')).href);

  const isBlocked = buildCompanyBlocklist(['ByteDance', 'NVIDIA', 'JustPlay GmbH']);
  // Exact, case-insensitive match
  if (isBlocked('ByteDance') && isBlocked('bytedance') && isBlocked('  NVIDIA ')) {
    pass('blocks listed employers case-insensitively (and trims)');
  } else {
    fail('listed employers should be blocked case-insensitively');
  }
  // Exact-only: must NOT stem/substring-match a real studio (Tencent, "ByteDance Games Studio")
  if (!isBlocked('Tencent') && !isBlocked('ByteDance Games Studio') && !isBlocked('NVIDIA Lightspeed Studios')) {
    pass('exact match only — never collateral-blocks a differently-named studio');
  } else {
    fail('blocklist must be exact, not a stem/substring match');
  }
  // Fail-safe: empty / invalid / absent list blocks nothing; empty company never blocked
  const none = buildCompanyBlocklist(undefined);
  const noneArr = buildCompanyBlocklist([null, 42, '  ', '']);
  if (!none('ByteDance') && !noneArr('ByteDance') && !isBlocked('') && !isBlocked(null)) {
    pass('fail-safe: empty/invalid list blocks nothing; empty company is never blocked');
  } else {
    fail('empty/invalid blocklist or empty company should block nothing');
  }
} catch (e) {
  fail(`company blocklist tests crashed: ${e.message}`);
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
  // The markdown carries a job row, so the widget fallback must NOT fire.
  await workable.fetch(
    { name: 'Smoke', careers_url: 'https://apply.workable.com/optimile' },
    {
      transport: 'http',
      fetchText: async (url) => {
        if (!url.startsWith('https://apply.workable.com/')) {
          throw new Error('fetchText called with unexpected URL');
        }
        return [
          '| Title | Department | Location | Type | Salary | Posted | Details |',
          '|---|---|---|---|---|---|---|',
          '| Smoke Role | Eng | Remote | Full-time | — | 2026-04-01 | [View](https://apply.workable.com/optimile/jobs/view/SMOKE.md) |',
        ].join('\n');
      },
      fetchJson: async () => { throw new Error('fetchJson should not be called when markdown has rows'); },
    },
  );
  pass('workable.fetch() reaches fetchText on the happy path (allowed hostname)');

  // Empty markdown export → widget JSON fallback (embedded-board accounts like
  // Side / Keywords Studios leave jobs.md empty but the widget API is full).
  const { parseWorkableWidget } = await import(pathToFileURL(join(ROOT, 'providers/workable.mjs')).href);
  let widgetCalledWith = null;
  const fallbackJobs = await workable.fetch(
    { name: 'Embedded', careers_url: 'https://apply.workable.com/embedded-co' },
    {
      transport: 'http',
      fetchText: async () =>
        '| Title | Department | Location | Type | Salary | Posted | Details |\n|---|---|---|---|---|---|---|\n',
      fetchJson: async (url) => {
        widgetCalledWith = url;
        return {
          name: 'Embedded Co', description: '',
          jobs: [
            { title: 'Live Role', shortcode: 'ZZZ999', url: 'https://apply.workable.com/j/ZZZ999',
              city: 'Reykjavik', state: '', country: 'Iceland', department: 'Art', published_on: '2026-05-01' },
            { title: '', shortcode: 'EMPTY1', url: 'https://apply.workable.com/j/EMPTY1' }, // no title → dropped
          ],
        };
      },
    },
  );
  if (widgetCalledWith === 'https://apply.workable.com/api/v1/widget/accounts/embedded-co?details=true'
      && fallbackJobs.length === 1 && fallbackJobs[0].title === 'Live Role'
      && fallbackJobs[0].location === 'Reykjavik, Iceland'
      && fallbackJobs[0].url === 'https://apply.workable.com/j/ZZZ999') {
    pass('workable.fetch() falls back to widget JSON when markdown export is empty');
  } else {
    fail(`widget fallback wrong: url=${widgetCalledWith} jobs=${JSON.stringify(fallbackJobs)}`);
  }

  // parseWorkableWidget drops off-domain / non-https job URLs like the markdown path.
  const widgetFiltered = parseWorkableWidget({
    jobs: [
      { title: 'Good', url: 'https://apply.workable.com/j/OK1', city: 'Remote' },
      { title: 'Evil', url: 'https://evil.example/j/X' },
      { title: 'Insecure', url: 'http://apply.workable.com/j/Y' },
    ],
  }, 'X');
  if (widgetFiltered.length === 1 && widgetFiltered[0].title === 'Good') {
    pass('parseWorkableWidget drops off-domain and non-https job URLs');
  } else {
    fail(`parseWorkableWidget filter wrong: ${JSON.stringify(widgetFiltered.map(j => j.title))}`);
  }

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

// ── 12b. PROVIDERS — Avature ────────────────────────────────────────

console.log('\n12b. Provider — avature');

try {
  const avature = (await import(pathToFileURL(join(ROOT, 'providers/avature.mjs')).href)).default;
  const { parseAvatureHtml, resolveAvature } = await import(pathToFileURL(join(ROOT, 'providers/avature.mjs')).href);

  if (avature.id === 'avature') pass('avature.id is "avature"');
  else fail(`avature.id is ${JSON.stringify(avature.id)}`);

  // detect() — bare tenant origins need explicit provider; SearchJobs/JobDetail paths auto-claim.
  if (avature.detect({ name: 'EA', careers_url: 'https://jobs.ea.com' }) === null) {
    pass('avature.detect() returns null for a bare tenant origin (needs explicit provider)');
  } else {
    fail('avature.detect() should NOT auto-claim a bare origin');
  }
  const dHit = avature.detect({ name: 'EA', careers_url: 'https://jobs.ea.com/en_US/careers/SearchJobs/' });
  if (dHit && dHit.url === 'https://jobs.ea.com/en_US/careers/SearchJobs/?jobRecordsPerPage=20&jobOffset=0') {
    pass('avature.detect() auto-claims a /careers/SearchJobs path');
  } else {
    fail(`avature.detect(SearchJobs) returned ${JSON.stringify(dHit)}`);
  }
  if (avature.detect({ name: 'X', careers_url: 'https://example.com/careers' }) === null) {
    pass('avature.detect() returns null for non-Avature career paths');
  } else {
    fail('avature.detect() should return null for unrelated /careers paths');
  }
  if (avature.detect({ name: 'X', careers_url: 42 }) === null) {
    pass('avature.detect() returns null for non-string careers_url (42)');
  } else {
    fail('avature.detect() should treat non-string careers_url as missing');
  }

  // resolveAvature() — origin + locale (default en_US, honour an explicit locale segment).
  const r1 = resolveAvature({ careers_url: 'https://jobs.ea.com' });
  if (r1 && r1.origin === 'https://jobs.ea.com' && r1.host === 'jobs.ea.com' && r1.locale === 'en_US') {
    pass('resolveAvature() defaults locale to en_US for a bare origin');
  } else {
    fail(`resolveAvature(bare) = ${JSON.stringify(r1)}`);
  }
  const r2 = resolveAvature({ careers_url: 'https://jobs.ea.com/fr_FR/careers/SearchJobs/' });
  if (r2 && r2.locale === 'fr_FR') pass('resolveAvature() keeps an explicit locale segment');
  else fail(`resolveAvature(locale) = ${JSON.stringify(r2)}`);

  // parseAvatureHtml() — card extraction, entity decode, same-origin filtering.
  const sampleHtml = [
    '<a class="link link_result" href="https://jobs.ea.com/en_US/careers/JobDetail/UI-Artist-II/214826" data-au="ag-a-10">',
    'UI Artist II', '</a>',
    '<div class="article__header__text__subtitle">',
    '<span class="list-item-location">Hyderabad, India</span>',
    '<span class="list-item-department">EA Mobile &amp; Slingshot</span>',
    '</div>',
    '<a class="link link_result" href="https://jobs.ea.com/en_US/careers/JobDetail/Lighting-Artist/213912">',
    'Concepteur.trice d&#8217;&#xe9;clairage', '</a>',
    '<span class="list-item-location">Montreal, Canada</span>',
    '<span class="list-item-department">Motive</span>',
    // off-host card must be dropped
    '<a class="link link_result" href="https://evil.example/en_US/careers/JobDetail/X/1">Evil</a>',
    '<span class="list-item-location">Nowhere</span>',
  ].join('\n');
  const aJobs = parseAvatureHtml(sampleHtml, 'Electronic Arts', 'jobs.ea.com');
  if (aJobs.length === 2) pass('parseAvatureHtml extracts 2 same-host cards (drops off-host)');
  else fail(`parseAvatureHtml returned ${aJobs.length} jobs, expected 2`);

  if (aJobs[0]?.title === 'UI Artist II' && aJobs[0]?.location === 'Hyderabad, India'
      && aJobs[0]?.department === 'EA Mobile & Slingshot' && aJobs[0]?.company === 'Electronic Arts') {
    pass('parseAvatureHtml extracts title/location/department/company and decodes &amp;');
  } else {
    fail(`parseAvatureHtml card 0 = ${JSON.stringify(aJobs[0])}`);
  }
  if (aJobs[1]?.title === 'Concepteur.trice d’éclairage') {
    pass('parseAvatureHtml decodes numeric/hex entities (’ and é)');
  } else {
    fail(`parseAvatureHtml entity decode wrong: ${JSON.stringify(aJobs[1]?.title)}`);
  }
  if (!aJobs.some(j => j.url.includes('evil.example'))) {
    pass('parseAvatureHtml drops off-host JobDetail links');
  } else {
    fail('parseAvatureHtml must drop off-host cards');
  }

  // Dedup: the same JobDetail URL appearing twice yields one job.
  const dupHtml = [
    '<a class="link link_result" href="https://jobs.ea.com/c/JobDetail/A/1">A</a>',
    '<a class="link link_result" href="https://jobs.ea.com/c/JobDetail/A/1">A again</a>',
  ].join('\n');
  if (parseAvatureHtml(dupHtml, 'EA', 'jobs.ea.com').length === 1) {
    pass('parseAvatureHtml dedupes repeated job URLs');
  } else {
    fail('parseAvatureHtml should dedupe identical job URLs');
  }

  // Robustness
  if (parseAvatureHtml('', 'X', 'jobs.ea.com').length === 0) pass('parseAvatureHtml empty input → empty result');
  else fail('parseAvatureHtml empty input should yield empty result');
  if (parseAvatureHtml(null, 'X', 'jobs.ea.com').length === 0) pass('parseAvatureHtml null input → empty (no crash)');
  else fail('parseAvatureHtml null input should yield empty without crashing');

  // fetch() pagination: walks jobOffset until an empty page, dedupes, stays same-origin.
  const pages = {
    0: '<a class="link link_result" href="https://jobs.ea.com/c/JobDetail/R0/1">R0</a>'
      + Array.from({ length: 19 }, (_, i) => `<a class="link link_result" href="https://jobs.ea.com/c/JobDetail/P0-${i}/${100 + i}">P0-${i}</a>`).join(''),
    20: Array.from({ length: 20 }, (_, i) => `<a class="link link_result" href="https://jobs.ea.com/c/JobDetail/P1-${i}/${200 + i}">P1-${i}</a>`).join(''),
    40: '', // empty page → stop
  };
  const seenOffsets = [];
  const fetched = await avature.fetch(
    { name: 'EA', careers_url: 'https://jobs.ea.com' },
    {
      transport: 'http',
      fetchText: async (url) => {
        if (!url.startsWith('https://jobs.ea.com/')) throw new Error(`off-origin fetch: ${url}`);
        const off = Number(new URL(url).searchParams.get('jobOffset'));
        seenOffsets.push(off);
        return pages[off] ?? '';
      },
    },
  );
  if (fetched.length === 40 && seenOffsets.join(',') === '0,20,40') {
    pass('avature.fetch() paginates jobOffset 0→20→40 and stops on the empty page');
  } else {
    fail(`avature.fetch() pagination wrong: jobs=${fetched.length} offsets=${seenOffsets.join(',')}`);
  }

} catch (e) {
  fail(`avature provider tests crashed: ${e.message}`);
}

// ── 12b2. PROVIDERS — HiBob ─────────────────────────────────────────

console.log('\n12b2. Provider — hibob');

try {
  const hibob = (await import(pathToFileURL(join(ROOT, 'providers/hibob.mjs')).href)).default;
  const { mapHibobJobAds } = await import(pathToFileURL(join(ROOT, 'providers/hibob.mjs')).href);

  if (hibob.id === 'hibob') pass('hibob.id is "hibob"');
  else fail(`hibob.id is ${JSON.stringify(hibob.id)}`);

  // detect() — auto-claims *.careers.hibob.com hosts, ignores everything else.
  const dHit = hibob.detect({ name: 'Nexus Mods', careers_url: 'https://nexusmods.careers.hibob.com' });
  if (dHit && dHit.url === 'https://nexusmods.careers.hibob.com/jobs') {
    pass('hibob.detect() auto-claims a *.careers.hibob.com host');
  } else {
    fail(`hibob.detect() returned ${JSON.stringify(dHit)}`);
  }
  if (hibob.detect({ name: 'X', careers_url: 'https://evil.hibob.com.example/jobs' }) === null) {
    pass('hibob.detect() returns null for a look-alike host (suffix not matched)');
  } else {
    fail('hibob.detect() must not claim a host that only embeds careers.hibob.com');
  }
  if (hibob.detect({ name: 'X', careers_url: 'http://nexusmods.careers.hibob.com' }) === null) {
    pass('hibob.detect() returns null for non-https');
  } else {
    fail('hibob.detect() should reject non-https careers_url');
  }
  if (hibob.detect({ name: 'X', careers_url: 99 }) === null) {
    pass('hibob.detect() returns null for non-string careers_url');
  } else {
    fail('hibob.detect() should treat non-string careers_url as missing');
  }

  // mapHibobJobAds() — field mapping, dedup, structured workMode, location clean.
  const details = [
    {
      id: '90844ed4', title: 'Senior App Developer', department: 'App Development',
      site: 'UK - Remote', country: 'United Kingdom', workspaceTypeId: 'remote',
      publishedAt: '2026-06-17T10:00:10.451356961Z',
    },
    {
      id: 'abc-123', title: 'Lead Writer', department: 'Narrative',
      site: 'Berlin (HQ)', country: 'Germany', workspaceTypeId: 'hybrid',
      publishedAt: '2026-05-05T09:00:00.000Z',
    },
    { id: 'abc-123', title: 'Lead Writer DUP' }, // dup id → dropped
    { id: 'no-title' },                          // missing title → dropped
    { title: 'no-id' },                          // missing id → dropped
  ];
  const jobs = mapHibobJobAds(details, 'Nexus Mods', 'https://nexusmods.careers.hibob.com');
  if (jobs.length === 2) pass('mapHibobJobAds keeps 2 valid rows (drops dup id + missing title/id)');
  else fail(`mapHibobJobAds returned ${jobs.length}, expected 2`);

  const j0 = jobs[0];
  if (j0 && j0.url === 'https://nexusmods.careers.hibob.com/jobs?jobId=90844ed4'
      && j0.title === 'Senior App Developer' && j0.company === 'Nexus Mods'
      && j0.department === 'App Development' && j0.workMode === 'remote'
      && j0.location === 'UK' && j0.postedDate === '2026-06-17T10:00:10.451Z') {
    pass('mapHibobJobAds maps url/title/company/department, derives workMode, strips mode from location, truncates ns date');
  } else {
    fail(`mapHibobJobAds row 0 = ${JSON.stringify(j0)}`);
  }
  if (jobs[1]?.workMode === 'hybrid' && jobs[1]?.location === 'Berlin (HQ)') {
    pass('mapHibobJobAds keeps a place-only site untouched and maps hybrid');
  } else {
    fail(`mapHibobJobAds row 1 = ${JSON.stringify(jobs[1])}`);
  }
  if (mapHibobJobAds(null, 'X', 'https://x.careers.hibob.com').length === 0
      && mapHibobJobAds([], 'X', 'https://x.careers.hibob.com').length === 0) {
    pass('mapHibobJobAds returns [] on null/empty input (fail-safe)');
  } else {
    fail('mapHibobJobAds should return [] for null/empty input');
  }

  // fetch() — sends a same-origin Referer, parses jobAdDetails, stays same-origin.
  let sentReferer = null;
  const fetched = await hibob.fetch(
    { name: 'Nexus Mods', careers_url: 'https://nexusmods.careers.hibob.com' },
    {
      transport: 'http',
      fetchJson: async (url, opts) => {
        if (url !== 'https://nexusmods.careers.hibob.com/api/job-ad') throw new Error(`off-origin fetch: ${url}`);
        sentReferer = opts && opts.headers && (opts.headers.referer || opts.headers.Referer);
        return { filterGroups: {}, jobAdDetails: details };
      },
    },
  );
  if (fetched.length === 2 && sentReferer === 'https://nexusmods.careers.hibob.com/jobs') {
    pass('hibob.fetch() hits /api/job-ad with a same-origin Referer and maps the list');
  } else {
    fail(`hibob.fetch() wrong: jobs=${fetched.length} referer=${sentReferer}`);
  }

  let threw = false;
  await hibob.fetch(
    { name: 'X', careers_url: 'https://x.careers.hibob.com' },
    { transport: 'http', fetchJson: async () => ({ nope: true }) },
  ).catch(() => { threw = true; });
  if (threw) pass('hibob.fetch() throws on an unexpected API shape');
  else fail('hibob.fetch() should throw when jobAdDetails is absent');

} catch (e) {
  fail(`hibob provider tests crashed: ${e.message}`);
}

// ── 12b3. PROVIDERS — HERP ──────────────────────────────────────────

console.log('\n12b3. Provider — herp');

try {
  const herp = (await import(pathToFileURL(join(ROOT, 'providers/herp.mjs')).href)).default;
  const { parseHerpList, resolveHerp } = await import(pathToFileURL(join(ROOT, 'providers/herp.mjs')).href);

  if (herp.id === 'herp') pass('herp.id is "herp"');
  else fail(`herp.id is ${JSON.stringify(herp.id)}`);

  // detect() — auto-claims herp.careers/v1/<tenant>, derives the board URL.
  const dHit = herp.detect({ name: 'PlatinumGames', careers_url: 'https://herp.careers/v1/pgrecruit' });
  if (dHit && dHit.url === 'https://herp.careers/v1/pgrecruit') {
    pass('herp.detect() auto-claims herp.careers/v1/<tenant> and returns the board URL');
  } else {
    fail(`herp.detect() returned ${JSON.stringify(dHit)}`);
  }
  if (herp.detect({ name: 'X', careers_url: 'https://herp.careers.evil.com/v1/x' }) === null) {
    pass('herp.detect() returns null for a look-alike host');
  } else {
    fail('herp.detect() must not claim a host that only embeds herp.careers');
  }
  if (herp.detect({ name: 'X', careers_url: 'http://herp.careers/v1/x' }) === null) {
    pass('herp.detect() returns null for non-https');
  } else {
    fail('herp.detect() should reject non-https careers_url');
  }
  if (herp.detect({ name: 'X', careers_url: 'https://herp.careers/v1' }) === null
      && herp.detect({ name: 'X', careers_url: 'https://herp.careers/v1/requisition-groups/abc' }) === null) {
    pass('herp.detect() returns null when there is no real tenant in the path');
  } else {
    fail('herp.detect() should reject a missing/category-only path');
  }

  // mineUrl() — url→identity for the rehm miner.
  const mined = herp.mineUrl('https://herp.careers/v1/pgrecruit/Zo-SJ55QMOEB');
  if (mined && mined.slug === 'pgrecruit' && mined.careers_url === 'https://herp.careers/v1/pgrecruit') {
    pass('herp.mineUrl() extracts the tenant slug + canonical careers_url from a job URL');
  } else {
    fail(`herp.mineUrl() returned ${JSON.stringify(mined)}`);
  }
  if (herp.mineUrl('https://example.com/v1/x/y') === null) {
    pass('herp.mineUrl() returns null for a non-herp host');
  } else {
    fail('herp.mineUrl() should ignore non-herp hosts');
  }

  // parseHerpList() — card parse, title cleanup, workMode, dedup, category reject.
  const html = `
    <div class="card requisition-list-card"><div class="card__section"><div class="career-page-group-name-tag-container">
      <a class="career-page-group-name-tag-container" href="/v1/pgrecruit/requisition-groups/abc-123">
        <div class="career-page-group-name-tag"><span class="career-page-group-name-tag__text">01-00.ゲーム開発職</span></div></a>
      <a class="with-heading requisition-list-card__header-anchor" href="/v1/pgrecruit/019d9056-3be4-7551">
        <h2 class="requisition-list-card__header with-heading__heading heading">01-01-00.【ハイブリッド勤務】ゲームデザイナー/Game Designer</h2></a>
    </div></div>
    <div class="card requisition-list-card">
      <a class="with-heading requisition-list-card__header-anchor" href="/v1/pgrecruit/Zo-SJ55QMOEB">
        <h2 class="requisition-list-card__header heading">01-14-02.【フルリモート】サウンドデザイナー/Sound &amp; Designer</h2></a>
    </div>
    <div class="card requisition-list-card">
      <a class="with-heading requisition-list-card__header-anchor" href="/v1/pgrecruit/Zo-SJ55QMOEB">
        <h2 class="requisition-list-card__header heading">DUPLICATE</h2></a>
    </div>
    <div class="card requisition-list-card">
      <a class="with-heading requisition-list-card__header-anchor" href="/v1/OTHERTENANT/leak">
        <h2 class="requisition-list-card__header heading">Cross-tenant leak</h2></a>
    </div>`;
  const rows = parseHerpList(html, 'PlatinumGames', 'https://herp.careers', 'pgrecruit');
  if (rows.length === 2) pass('parseHerpList keeps 2 rows (dedups by url, ignores category links + cross-tenant href)');
  else fail(`parseHerpList returned ${rows.length}, expected 2: ${JSON.stringify(rows.map(r => r.title))}`);

  const r0 = rows[0];
  if (r0 && r0.title === 'ゲームデザイナー/Game Designer'
      && r0.url === 'https://herp.careers/v1/pgrecruit/019d9056-3be4-7551'
      && r0.company === 'PlatinumGames' && r0.location === 'Japan' && r0.workMode === 'hybrid') {
    pass('parseHerpList strips the "NN-NN." prefix + 【…】 tag, sets Japan, derives hybrid from the tag');
  } else {
    fail(`parseHerpList row 0 = ${JSON.stringify(r0)}`);
  }
  if (rows[1]?.workMode === 'remote' && rows[1]?.title === 'サウンドデザイナー/Sound & Designer') {
    pass('parseHerpList derives remote from 【フルリモート】 and decodes entities in the title');
  } else {
    fail(`parseHerpList row 1 = ${JSON.stringify(rows[1])}`);
  }
  if (parseHerpList('', 'X', 'https://herp.careers', 'x').length === 0
      && parseHerpList('<div>no cards</div>', 'X', 'https://herp.careers', 'x').length === 0) {
    pass('parseHerpList returns [] on empty/cardless HTML (fail-safe)');
  } else {
    fail('parseHerpList should return [] when there are no cards');
  }

  // resolveHerp() — tenant extraction sanity.
  const rv = resolveHerp({ careers_url: 'https://herp.careers/v1/dena' });
  if (rv && rv.tenant === 'dena' && rv.origin === 'https://herp.careers') {
    pass('resolveHerp() extracts {origin, tenant} from careers_url');
  } else {
    fail(`resolveHerp() returned ${JSON.stringify(rv)}`);
  }

  // fetch() — stays same-origin, parses the board, returns [] for an empty board.
  let fetchedUrl = null;
  const fetched = await herp.fetch(
    { name: 'PlatinumGames', careers_url: 'https://herp.careers/v1/pgrecruit' },
    {
      transport: 'http',
      fetchText: async (url) => {
        fetchedUrl = url;
        if (url !== 'https://herp.careers/v1/pgrecruit') throw new Error(`off-board fetch: ${url}`);
        return html;
      },
    },
  );
  if (fetched.length === 2 && fetchedUrl === 'https://herp.careers/v1/pgrecruit') {
    pass('herp.fetch() reads the tenant board URL and maps the cards');
  } else {
    fail(`herp.fetch() wrong: jobs=${fetched.length} url=${fetchedUrl}`);
  }

  const empty = await herp.fetch(
    { name: 'X', careers_url: 'https://herp.careers/v1/x' },
    { transport: 'http', fetchText: async () => '<div>There are currently no open jobs</div>' },
  );
  if (Array.isArray(empty) && empty.length === 0) {
    pass('herp.fetch() returns [] for an empty board (no throw)');
  } else {
    fail(`herp.fetch() should return [] for an empty board, got ${JSON.stringify(empty)}`);
  }

} catch (e) {
  fail(`herp provider tests crashed: ${e.message}`);
}

// ── 12c. PROVIDERS — BambooHR ───────────────────────────────────────

console.log('\n12c. Provider — bamboohr');

try {
  const bamboo = (await import(pathToFileURL(join(ROOT, 'providers/bamboohr.mjs')).href)).default;
  const { parseBambooList, probe: bambooProbe } = await import(pathToFileURL(join(ROOT, 'providers/bamboohr.mjs')).href);

  if (bamboo.id === 'bamboohr') pass('bamboohr.id is "bamboohr"');
  else fail(`bamboohr.id is ${JSON.stringify(bamboo.id)}`);

  // detect() — claims *.bamboohr.com tenant hosts, ignores everything else.
  const bHit = bamboo.detect({ name: 'Offworld Industries', careers_url: 'https://owi.bamboohr.com' });
  if (bHit && bHit.url === 'https://owi.bamboohr.com/careers/list') {
    pass('bamboohr.detect() resolves a *.bamboohr.com host → /careers/list');
  } else {
    fail(`bamboohr.detect(tenant) returned ${JSON.stringify(bHit)}`);
  }
  if (bamboo.detect({ name: 'X', careers_url: 'https://example.com/careers' }) === null) {
    pass('bamboohr.detect() returns null for non-bamboohr hosts');
  } else {
    fail('bamboohr.detect() must ignore non-bamboohr hosts');
  }
  if (bamboo.detect({ name: 'X' }) === null && bamboo.detect(null) === null) {
    pass('bamboohr.detect() null for missing/null entry (no crash)');
  } else {
    fail('bamboohr.detect() should return null for missing careers_url');
  }

  // probe — slug-discoverable.
  if (bambooProbe && bambooProbe.endpoints[0].kind === 'slug'
      && bambooProbe.endpoints[0].url('owi') === 'https://owi.bamboohr.com/careers/list'
      && typeof bambooProbe.canary === 'string' && bambooProbe.canary) {
    pass('bamboohr.probe exposes a slug endpoint + canary');
  } else {
    fail(`bamboohr.probe malformed: ${JSON.stringify(bambooProbe)}`);
  }

  // parseBambooList() — URL construction, location compose, fields, fallback.
  const sample = {
    meta: { totalCount: 3 },
    result: [
      { id: '164', jobOpeningName: 'Build Engineer', departmentLabel: 'DevOps',
        location: { city: 'New Westminster', state: 'British Columbia' },
        atsLocation: { country: 'Canada', state: 'British Columbia', city: null }, isRemote: null },
      { id: 108, jobOpeningName: 'Camera Animator',
        location: { city: null, state: null },
        atsLocation: { country: 'United Kingdom', state: 'Warwickshire', city: 'Royal Leamington Spa, England, United Kingdom' }, isRemote: true },
      { id: '', jobOpeningName: 'No ID — dropped' }, // no id → skipped
    ],
  };
  const bJobs = parseBambooList(sample, 'https://owi.bamboohr.com', 'Offworld');
  if (bJobs.length === 2) pass('parseBambooList drops id-less rows, keeps the rest');
  else fail(`parseBambooList returned ${bJobs.length} jobs, expected 2`);

  if (bJobs[0] && bJobs[0].url === 'https://owi.bamboohr.com/careers/164'
      && bJobs[0].title === 'Build Engineer' && bJobs[0].department === 'DevOps'
      && bJobs[0].company === 'Offworld'
      && bJobs[0].location === 'New Westminster, British Columbia, Canada') {
    pass('parseBambooList builds /careers/{id} URL + composes deduped location with country');
  } else {
    fail(`parseBambooList card 0 = ${JSON.stringify(bJobs[0])}`);
  }

  // Numeric id coerces; messy atsLocation.city → first segment; isRemote → workMode.
  if (bJobs[1] && bJobs[1].url === 'https://owi.bamboohr.com/careers/108'
      && bJobs[1].location === 'Royal Leamington Spa, Warwickshire, United Kingdom'
      && bJobs[1].workMode === 'remote') {
    pass('parseBambooList coerces numeric id, trims messy city, maps isRemote→remote');
  } else {
    fail(`parseBambooList card 1 = ${JSON.stringify(bJobs[1])}`);
  }

  // dedup on identical built URL.
  const dup = { result: [
    { id: '5', jobOpeningName: 'A' }, { id: '5', jobOpeningName: 'A again' },
  ] };
  if (parseBambooList(dup, 'https://x.bamboohr.com', 'X').length === 1) {
    pass('parseBambooList dedupes rows that map to the same URL');
  } else {
    fail('parseBambooList should dedupe identical job URLs');
  }

  // robustness.
  if (parseBambooList({ result: [] }, 'https://x.bamboohr.com', 'X').length === 0
      && parseBambooList(null, 'https://x.bamboohr.com', 'X').length === 0
      && parseBambooList({}, 'https://x.bamboohr.com', 'X').length === 0) {
    pass('parseBambooList empty/null/shapeless input → empty (no crash)');
  } else {
    fail('parseBambooList must handle empty/null/shapeless input');
  }

  // fetch() — pulls the list via fetchJson (single request) and parses it.
  let bFetchUrl = '';
  const bFetched = await bamboo.fetch(
    { name: 'Offworld', careers_url: 'https://owi.bamboohr.com' },
    {
      transport: 'http',
      fetchJson: async (url) => {
        bFetchUrl = url;
        if (!url.startsWith('https://owi.bamboohr.com/')) throw new Error(`off-origin: ${url}`);
        return sample;
      },
    },
  );
  if (bFetchUrl === 'https://owi.bamboohr.com/careers/list' && bFetched.length === 2) {
    pass('bamboohr.fetch() requests /careers/list once and returns parsed jobs');
  } else {
    fail(`bamboohr.fetch() wrong: url=${bFetchUrl} jobs=${bFetched.length}`);
  }

} catch (e) {
  fail(`bamboohr provider tests crashed: ${e.message}`);
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
    // Remote Game Jobs aggregator mirror of a direct posting → drop the aggregator row.
    { title: '2D Animator', company: 'Pine Creek Games', location: 'Remote', url: 'https://pinecreekgames.teamtailor.com/jobs/9001-2d-animator' },
    { title: '2D Animator', company: 'Pine Creek Games', location: 'Remote', url: 'https://remotegamejobs.com/jobs/pine-creek-games-2d-animator-remote-job' },
    // Last-resort demotion: GameDevJobs (login wall, no direct link) mirrors a
    // NORMAL aggregator (GameJobs.co, which links out) with no direct twin → drop
    // the GameDevJobs row, keep the GameJobs.co one.
    { title: 'Gameplay Programmer', company: 'Triband', location: 'Copenhagen, DK', url: 'https://gamejobs.co/Gameplay-Programmer-at-Triband' },
    { title: 'Gameplay Programmer', company: 'Triband', location: 'Copenhagen, DK', url: 'https://gamedevjobs.com/jobs/gameplay-programmer-abcd1234' },
    // GameDevJobs mirror of a DIRECT posting → dropped by tier 1 like any aggregator.
    { title: 'Tools Programmer', company: 'Sharkmob', location: 'Malmö, SE', url: 'https://sharkmob.teamtailor.com/jobs/5551-tools-programmer' },
    { title: 'Tools Programmer', company: 'Sharkmob', location: 'Malmö, SE', url: 'https://gamedevjobs.com/jobs/tools-programmer-99887766' },
    // All-last-resort group (only GameDevJobs) → untouched (nothing better exists).
    { title: 'QA Tester', company: 'Indie Co', location: 'Remote', url: 'https://gamedevjobs.com/jobs/qa-tester-11112222' },
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

  if (collapsedByHeuristic === 4) pass('pass 2 drops four mirrors (Hitmarker + Remote Game Jobs direct-twins, GameDevJobs vs direct + vs normal aggregator)');
  else fail(`expected 4 collapsed by heuristic, got ${collapsedByHeuristic}`);

  if (collapsed === 5 && out.length === 9) pass('total: 14 → 9 (one ID dupe + four aggregator/last-resort mirrors removed)');
  else fail(`expected 9 jobs out (collapsed 5), got ${out.length} (collapsed ${collapsed})`);

  const riot = out.filter(j => j.company === 'Riot Games');
  if (riot.length === 1 && riot[0].url.includes('riotgames.com')) pass('aggregator pass keeps the direct URL, drops Hitmarker');
  else fail('aggregator pass should keep the direct riotgames.com URL');

  const pine = out.filter(j => j.company === 'Pine Creek Games');
  if (pine.length === 1 && pine[0].url.includes('teamtailor.com')) pass('aggregator pass keeps the direct URL, drops Remote Game Jobs mirror');
  else fail('aggregator pass should keep the direct Pine Creek URL, drop the remotegamejobs.com mirror');

  // Last-resort tier: GameDevJobs loses to a normal aggregator (no direct twin).
  const triband = out.filter(j => j.company === 'Triband');
  if (triband.length === 1 && triband[0].url.includes('gamejobs.co')) pass('last-resort: GameDevJobs dropped in favour of GameJobs.co (which links out)');
  else fail(`Triband should keep only the GameJobs.co row, got ${JSON.stringify(triband.map(j => j.url))}`);

  // Tier 1 still applies to GameDevJobs like any aggregator: direct twin wins.
  const shark = out.filter(j => j.company === 'Sharkmob');
  if (shark.length === 1 && shark[0].url.includes('teamtailor.com')) pass('GameDevJobs mirror of a direct posting is dropped by tier 1');
  else fail(`Sharkmob should keep only the direct row, got ${JSON.stringify(shark.map(j => j.url))}`);

  // All-last-resort group: nothing better exists → keep it (never silently dropped).
  const indie = out.filter(j => j.company === 'Indie Co');
  if (indie.length === 1) pass('all-last-resort group left untouched (GameDevJobs-only role survives)');
  else fail(`Indie Co GameDevJobs-only role should survive, got ${indie.length}`);

  const epic = out.filter(j => j.company === 'Epic Games');
  if (epic.length === 2) pass('two distinct direct reqs are never merged (Epic false-positive guard)');
  else fail(`distinct Epic reqs should both survive, got ${epic.length}`);

  const sandbox = out.filter(j => j.company === 'Sandbox Interactive');
  if (sandbox.length === 1) pass('Teamtailor cross-host mirror collapsed to one');
  else fail(`Sandbox mirror should collapse to 1, got ${sandbox.length}`);

  // Configurable aggregator list: flag Teamtailor's parent-group domain instead.
  // With the ID pass already collapsing Sandbox, prove the aggregator list is read
  // by making WorkWithIndies a no-op default still removes Hitmarker.
  const { jobs: out2, collapsedByHeuristic: h2 } = dedupeSnapshot(jobs, { aggregators: [], lastResort: [] });
  if (h2 === 0 && out2.filter(j => j.url.includes('hitmarker.net')).length === 1) {
    pass('empty aggregator + last-resort lists disable pass 2 (Hitmarker mirror retained)');
  } else {
    fail('empty aggregator/last-resort lists should leave aggregator mirrors in place');
  }
} catch (e) {
  fail(`snapshot dedup tests crashed: ${e.message}`);
}

// ── WORK MODE: location split + multi-source fields ─────────────

console.log('\n17. Work mode — location split + multi-source filter fields');
try {
  const { splitLocationMode, normalizeWorkMode, slugifyTitle } = await import(pathToFileURL(join(ROOT, 'providers/_util.mjs')).href);
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
    ['Any', '', 'anywhere'],             // bare "Any" → anywhere
    ['Any Location', '', 'anywhere'],    // phrase consumed whole, not just "Any"
    ['Germany', 'Germany', ''],          // "any" inside a word never fires
    ['Albany, NY', 'Albany, NY', ''],    // ditto — no word boundary before its 'a'
    ['Anytown, USA', 'Anytown, USA', ''],// "any" prefix of a place is left intact
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
      && normalizeWorkMode('Any') === 'anywhere'
      && normalizeWorkMode('unspecified') === '') {
    pass('normalizeWorkMode maps ATS values to the work-mode enum (unknown → "")');
  } else {
    fail('normalizeWorkMode enum mapping wrong');
  }

  // slugifyTitle: powers ashby job_url_template for studios that mirror their
  // board on their own domain (Supercell). Drops punctuation (not &→and),
  // keeps a trailing hyphen for trailing whitespace, no leading/trailing trim.
  const slugCases = [
    ['Gameplay Programmer', 'gameplay-programmer'],
    ['Head of R&D, Clash Royale', 'head-of-rd-clash-royale'],
    ['Product Lead, Project R.I.S.E', 'product-lead-project-rise'],
    ['Senior Server Engineer, Central Tech ', 'senior-server-engineer-central-tech-'],
    ['Head of Entertainment & Partnerships', 'head-of-entertainment-partnerships'],
  ];
  let slugOk = true;
  for (const [input, want] of slugCases) {
    const got = slugifyTitle(input);
    if (got !== want) { slugOk = false; fail(`slugifyTitle(${JSON.stringify(input)}) = ${JSON.stringify(got)}, expected ${JSON.stringify(want)}`); }
  }
  if (slugOk) pass(`slugifyTitle matches the observed convention across ${slugCases.length} titles`);

  // fieldText: array field joins multiple sources into one combined string.
  const job = { title: 'Eng', company: 'X', location: 'US', workMode: 'remote', department: 'Audio' };
  if (fieldText(job, ['location', 'workmode']) === 'US remote') {
    pass('fieldText(array) joins multiple sources (location + workmode)');
  } else {
    fail(`fieldText(['location','workmode']) = ${JSON.stringify(fieldText(job, ['location', 'workmode']))}`);
  }

  // experiencelevel field: reads the source's own seniority label, '' when absent.
  if (
    fieldText({ experienceLevel: 'Junior-Associate' }, 'experiencelevel') === 'Junior-Associate' &&
    fieldText({ title: 'Senior Programmer' }, 'experiencelevel') === '' &&
    fieldText({ title: 'Game Programmer', experienceLevel: 'Junior-Associate' }, ['experiencelevel', 'title']) === 'Junior-Associate Game Programmer'
  ) {
    pass('fieldText experiencelevel reads the board value; [experiencelevel, title] joins it ahead of the title');
  } else {
    fail(`experiencelevel field wrong: ${JSON.stringify(fieldText({ title: 'Game Programmer', experienceLevel: 'Junior-Associate' }, ['experiencelevel', 'title']))}`);
  }

  // A Seniority group keyed on [experiencelevel, title] rates a title-less "Game
  // Programmer" as Junior when the board says so — the whole point of the wiring.
  const senGroup = {
    id: 'sen', name: 'Seniority', field: ['experiencelevel', 'title'], combine: 'max',
    filters: [
      { id: 'jr', name: 'Junior', keywords: ['Junior', 'Associate'], weight: 1.2 },
      { id: 'sr', name: 'Senior', keywords: ['Senior'], weight: 0.5 },
      { id: 'mid', name: 'Mid', else: true, weight: 0.7 },
    ],
  };
  const boardJunior = { title: 'Game Programmer', experienceLevel: 'Junior-Associate' };
  const boardless = { title: 'Game Programmer' }; // no board value → title-only, falls to Mid
  const labels = (j) => matchGroup(j, senGroup).filter((f) => !f.else).map((f) => f.name);
  if (
    labels(boardJunior).includes('Junior') &&           // board value promotes it
    labels(boardless).length === 0                        // no board value, no title word → Mid (else)
  ) {
    pass('Seniority group on [experiencelevel, title] uses the board value, falls back to title when absent');
  } else {
    fail(`seniority wiring wrong: junior=${JSON.stringify(labels(boardJunior))} boardless=${JSON.stringify(labels(boardless))}`);
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

// ── unless guard — filter references (cross-group) ───────────────
console.log('\n17b. unless guard — filter references');
try {
  const { isExcluded, matchGroup, buildFilterIndex } = await import(pathToFileURL(join(ROOT, 'rank.mjs')).href);

  // "Poland" location exclude (weight 0) guarded by `unless: [Remote]`. The
  // Remote filter lives in a SEPARATE group keyed on workmode, so the guard must
  // resolve cross-group and test workMode — not Poland's own location text.
  const groups = [
    { id: 'loc', field: 'location', combine: 'min',
      filters: [{ id: 'pl', name: 'Poland', keywords: ['Poland'], weight: 0, unless: ['Remote'] }] },
    { id: 'wm', field: 'workmode', combine: 'min',
      filters: [{ id: 'rm', name: 'Remote', keywords: ['remote'], weight: 1.5 }] },
  ];
  const onsitePL = { location: 'Warsaw, Poland', workMode: 'onsite' };
  const remotePL = { location: 'Warsaw, Poland', workMode: 'remote' };
  if (isExcluded(onsitePL, groups) && !isExcluded(remotePL, groups)) {
    pass('unless [Remote] voids the Poland exclude only when the job matches the Remote filter (workmode), cross-group');
  } else {
    fail(`unless cross-group: onsite excluded=${isExcluded(onsitePL, groups)} (want true), remote excluded=${isExcluded(remotePL, groups)} (want false)`);
  }

  // An unresolved reference is inert — it must NOT void the exclusion (fail-safe:
  // a typo'd guard can't silently let blocked jobs through).
  const badRef = [{ id: 'loc', field: 'location', combine: 'min',
    filters: [{ id: 'pl', name: 'Poland', keywords: ['Poland'], weight: 0, unless: ['Nonexistent'] }] }];
  if (isExcluded(remotePL, badRef)) {
    pass('unresolved unless reference is inert (exclusion still applies — fail-safe)');
  } else {
    fail('unresolved unless reference wrongly voided the exclusion');
  }

  // The index resolves a reference by label — `name`, or the first keyword when
  // `name` is absent (filterLabel rule). Reference the Remote filter by keyword.
  const byKw = [
    { id: 'loc', field: 'location', combine: 'min',
      filters: [{ id: 'pl', keywords: ['Poland'], weight: 0, unless: ['remote'] }] },
    { id: 'wm', field: 'workmode', combine: 'min',
      filters: [{ id: 'rm', keywords: ['remote'], weight: 1.5 }] },
  ];
  const idx = buildFilterIndex(byKw);
  if (idx.has('remote') && idx.has('poland') && !isExcluded(remotePL, byKw)) {
    pass('buildFilterIndex keys filters by label (name or first keyword); reference resolves by keyword');
  } else {
    fail(`label index / keyword reference wrong: hasRemote=${idx.has('remote')} hasPoland=${idx.has('poland')} excluded=${isExcluded(remotePL, byKw)}`);
  }
} catch (e) {
  fail(`unless-guard tests crashed: ${e.message}`);
}

// ── priority rescue — group-scoped exception (the crown flag) ─────
console.log('\n17c. priority rescue — voids a group\'s excludes when a flagged filter matches');
try {
  const { isExcluded, matchGroup, scoreGroup, buildFilterIndex } = await import(pathToFileURL(join(ROOT, 'rank.mjs')).href);

  // A Region group: "Poland" is a hard exclude (weight 0); "Remote" is flagged
  // priority. A remote Polish job must be rescued (exclude voided); an onsite one
  // must still be dropped. Both filters live in the SAME group (group-scoped).
  const groups = [{
    id: 'region', field: ['location', 'workmode'], combine: 'avg',
    filters: [
      { id: 'pl', name: 'Poland', keywords: ['Poland'], weight: 0 },
      { id: 'rm', name: 'Remote', keywords: ['remote'], weight: 1.3, priority: true },
    ],
  }];
  const onsitePL = { location: 'Warsaw, Poland', workMode: 'onsite' };
  const remotePL = { location: 'Warsaw, Poland', workMode: 'remote' };
  if (isExcluded(onsitePL, groups) && !isExcluded(remotePL, groups)) {
    pass('priority filter (Remote) rescues the group\'s weight-0 exclude only when it also matches');
  } else {
    fail(`priority rescue: onsite excluded=${isExcluded(onsitePL, groups)} (want true), remote excluded=${isExcluded(remotePL, groups)} (want false)`);
  }

  // The rescued job drops the weight-0 filter from its match set, so the priority
  // filter's own weight drives the score (not the 0).
  const idx = buildFilterIndex(groups);
  const matched = matchGroup(remotePL, groups[0], idx);
  if (!matched.some((f) => f.weight === 0) && matched.some((f) => f.id === 'rm') && scoreGroup(remotePL, groups[0], idx) > 0) {
    pass('rescue drops the zero-weight exclude from the match set; the priority filter\'s weight scores the job');
  } else {
    fail(`rescue match set wrong: hasZero=${matched.some((f) => f.weight === 0)} hasRemote=${matched.some((f) => f.id === 'rm')} score=${scoreGroup(remotePL, groups[0], idx)}`);
  }

  // Priority is group-scoped: it must NOT rescue an exclude in a DIFFERENT group.
  const twoGroups = [
    { id: 'region', field: ['location', 'workmode'], combine: 'avg',
      filters: [{ id: 'rm', name: 'Remote', keywords: ['remote'], weight: 1.3, priority: true }] },
    { id: 'role', field: 'title', combine: 'min',
      filters: [{ id: 'art', name: 'Artist', keywords: ['Artist'], weight: 0 }] },
  ];
  const remoteArtist = { title: 'Senior Artist', location: 'Anywhere', workMode: 'remote' };
  if (isExcluded(remoteArtist, twoGroups)) {
    pass('priority is group-scoped — a Region priority does not rescue a Role exclude');
  } else {
    fail('priority wrongly rescued an exclude in a different group');
  }
} catch (e) {
  fail(`priority-rescue tests crashed: ${e.message}`);
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

// ── Provider — games-jobs-direct ────────────────────────────────

console.log('\n17b. Provider — games-jobs-direct');

try {
  const gjd = (await import(pathToFileURL(join(ROOT, 'providers/gamesjobsdirect.mjs')).href)).default;
  const { parseGamesJobsDirectPage } = await import(pathToFileURL(join(ROOT, 'providers/gamesjobsdirect.mjs')).href);

  if (gjd.id === 'games-jobs-direct') pass('games-jobs-direct.id is "games-jobs-direct"');
  else fail(`games-jobs-direct.id is ${JSON.stringify(gjd.id)}`);

  const hit = gjd.detect({ careers_url: 'https://www.gamesjobsdirect.com/' });
  if (hit && hit.url === 'https://www.gamesjobsdirect.com/all-jobs') {
    pass('games-jobs-direct.detect() claims gamesjobsdirect.com careers URLs');
  } else {
    fail(`games-jobs-direct.detect() returned ${JSON.stringify(hit)}`);
  }

  if (
    gjd.detect({ careers_url: 'https://boards.greenhouse.io/x' }) === null &&
    gjd.detect({ careers_url: 'https://evil-gamesjobsdirect.com' }) === null &&
    gjd.detect({ careers_url: 'https://evil.example/gamesjobsdirect.com/jobs' }) === null &&
    gjd.detect({ careers_url: null }) === null
  ) {
    pass('games-jobs-direct.detect() rejects lookalike hosts, path-spoofs, and non-string URLs');
  } else {
    fail('games-jobs-direct.detect() must reject spoofed/invalid careers URLs');
  }

  // Two cards: one remote (globe tooltip) + sector/date, one onsite with a
  // non-work-mode tooltip (la-user "Junior") that must NOT become a workMode,
  // plus a malformed card with no job-title link that must be skipped.
  const sampleHtml = `
    <ul class="job-list-container">
    <li class="list-group-item job-list featured"><div class="row"><div class="col-sm-9">
      <p><a href="/job/keen-games/sales-and-ecommerce-manager/341414" class="job-title" title="Sales &amp; E-commerce Manager">Sales &amp; E-commerce Manager</a><span class="label job-status">New</span></p>
      <p class="job-info"><span class="job-location">Frankfurt am Main</span><span class="job-salary">N/A</span><span class="job-company">Keen Games</span><span class="job-sector"> Marketing</span></p>
      <p class="job-posteddate">Posted - 07 May 2026</p>
      <div class="margin-t-2"><ul class="list-inline"><li><i class="la la-globe" title="" data-toggle="tooltip" data-original-title="Remote"></i></li></ul></div>
    </div></li>
    <li class="list-group-item job-list "><div class="row"><div class="col-sm-9">
      <p><a href="/job/atra/3d-artist/342000" class="job-title" title="3D Artist">3D Artist</a></p>
      <p class="job-info"><span class="job-location">Romania</span><span class="job-company">ATRA</span><span class="job-sector"> Art</span></p>
      <p class="job-posteddate">Posted - 12 Jun 2026</p>
      <div class="margin-t-2"><ul class="list-inline"><li><i class="la la-user" title="" data-toggle="tooltip" data-original-title="Junior"></i></li></ul></div>
    </div></li>
    <li class="list-group-item job-list "><div class="row"><div class="col-sm-9">
      <p>No job-title link here</p>
    </div></li>
    </ul>`;
  const jobs = parseGamesJobsDirectPage(sampleHtml);
  if (jobs.length === 2) pass('parseGamesJobsDirectPage keeps cards with a job-title link, skips malformed');
  else fail(`parseGamesJobsDirectPage returned ${jobs.length} jobs (expected 2)`);

  if (
    jobs[0]?.title === 'Sales & E-commerce Manager' &&
    jobs[0]?.url === 'https://www.gamesjobsdirect.com/job/keen-games/sales-and-ecommerce-manager/341414' &&
    jobs[0]?.company === 'Keen Games' &&
    jobs[0]?.location === 'Frankfurt am Main' &&
    jobs[0]?.department === 'Marketing' &&
    jobs[0]?.workMode === 'remote' &&
    jobs[0]?.postedDate === '2026-05-07T00:00:00.000Z'
  ) {
    pass('parseGamesJobsDirectPage extracts title/url/company/location/sector/date/workMode + decodes entities');
  } else {
    fail(`row 0 = ${JSON.stringify(jobs[0])}`);
  }

  if (jobs[1]?.workMode === undefined && jobs[1]?.title === '3D Artist') {
    pass('parseGamesJobsDirectPage ignores non-globe tooltips (job-level icon ≠ workMode)');
  } else {
    fail(`row 1 = ${JSON.stringify(jobs[1])}`);
  }

  if (parseGamesJobsDirectPage(null).length === 0 && parseGamesJobsDirectPage('').length === 0) {
    pass('parseGamesJobsDirectPage handles null/empty input without crashing');
  } else {
    fail('parseGamesJobsDirectPage should yield empty result for null/empty input');
  }

  // exclude_sectors blocklist — whole-industry board sector filter.
  const { buildSectorFilter } = await import(pathToFileURL(join(ROOT, 'providers/gamesjobsdirect.mjs')).href);

  if (buildSectorFilter(undefined) === null && buildSectorFilter([]) === null && buildSectorFilter(['', '  ', 42]) === null) {
    pass('buildSectorFilter returns null when nothing valid is configured (no filtering)');
  } else {
    fail('buildSectorFilter should return null for empty/invalid config');
  }

  const filt = buildSectorFilter(['Gambling', '  web development  ']);
  if (
    filt &&
    filt({ department: 'Gambling' }) === false &&        // exact block
    filt({ department: 'WEB DEVELOPMENT' }) === false && // case-insensitive + trimmed config
    filt({ department: 'Programming' }) === true &&      // unblocked sector kept
    filt({ department: '' }) === true &&                 // fail-safe: missing sector kept
    filt({}) === true                                    // fail-safe: no department field kept
  ) {
    pass('buildSectorFilter blocks listed sectors case-insensitively and keeps cards with no parsed sector (fail-safe)');
  } else {
    fail('buildSectorFilter blocklist/fail-safe behavior is wrong');
  }

  // Detail-page enrichment — location + experience level come from the detail page.
  const { needsCountryEnrichment, extractCountry, extractLocation, extractExperienceLevel } = await import(pathToFileURL(join(ROOT, 'providers/gamesjobsdirect.mjs')).href);

  if (
    needsCountryEnrichment('Guildford') === true &&                  // bare city → look up
    needsCountryEnrichment('Frankfurt am Main') === true &&          // bare city w/ spaces
    needsCountryEnrichment('Daresbury, United Kingdom') === false && // already "City, Country"
    needsCountryEnrichment('Romania') === false &&                   // already a bare country
    needsCountryEnrichment('Singapore') === false &&                 // city-state recognised as country
    needsCountryEnrichment('') === false &&                          // nothing to enrich
    needsCountryEnrichment(null) === false
  ) {
    pass('needsCountryEnrichment flags bare cities, skips comma-locations and bare countries');
  } else {
    fail('needsCountryEnrichment gate is wrong');
  }

  if (
    extractCountry('<label class="control-label">Country</label> <p class="">United Kingdom</p>') === 'United Kingdom' &&
    extractCountry('<label>Country</label>\n   <p class="x">  Czech&nbsp;Republic </p>') === 'Czech Republic' &&
    extractCountry('<p>no country field here</p>') === '' &&
    extractCountry(null) === ''
  ) {
    pass('extractCountry reads the detail-page Country field and decodes/trims, empty when absent');
  } else {
    fail('extractCountry parsing is wrong');
  }

  if (
    extractLocation('<label class="control-label">Location</label> <p class="">Las Vegas, United States</p>') === 'Las Vegas, United States' &&
    extractLocation('<label>Location</label>\n   <p id="">  Kraków,&nbsp;Poland </p>') === 'Kraków, Poland' &&
    extractLocation('<p>no location field here</p>') === '' &&
    extractLocation(null) === ''
  ) {
    pass('extractLocation reads the detail-page Location field (full "City, Country"), empty when absent');
  } else {
    fail('extractLocation parsing is wrong');
  }

  if (
    extractExperienceLevel('<label class="control-label">Experience Level</label> <p class="" id="">Mid-Senior Level</p>') === 'Mid-Senior Level' &&
    extractExperienceLevel('<label>Experience Level</label> <p>Junior-Associate</p>') === 'Junior-Associate' &&
    extractExperienceLevel('<label>Experience Level</label> <p>  Not specified </p>') === '' && // placeholder → omitted
    extractExperienceLevel('<p>no experience field</p>') === '' &&
    extractExperienceLevel(null) === ''
  ) {
    pass('extractExperienceLevel reads the detail-page Experience Level field, drops "Not specified" placeholder');
  } else {
    fail('extractExperienceLevel parsing is wrong');
  }

  // End-to-end. Default now fetches EVERY posting's detail page (experience level
  // lives only there) and grabs the authoritative location at the same time.
  const enrichListing = `<ul>
    <li class="list-group-item job-list "><div><p><a href="/job/skillsearch/experienced-programmer/345511" class="job-title" title="Experienced Programmer">Experienced Programmer</a></p>
      <p class="job-info"><span class="job-location">Guildford</span><span class="job-company">Skillsearch</span><span class="job-sector"> Programming</span></p></div></li>
    <li class="list-group-item job-list "><div><p><a href="/job/x/y/2" class="job-title" title="Artist">Artist</a></p>
      <p class="job-info"><span class="job-location">Daresbury, United Kingdom</span><span class="job-company">X</span><span class="job-sector"> Art</span></p></div></li>
    </ul>`;
  // Detail responses keyed by URL slug so each posting can return distinct fields.
  const detailByUrl = {
    '345511': '<label class="control-label">Location</label> <p>Guildford, United Kingdom</p><label>Experience Level</label> <p>Junior-Associate</p>',
    '/2': '<label class="control-label">Location</label> <p>Daresbury, United Kingdom</p><label>Experience Level</label> <p>Director</p>',
  };
  const makeCtx = () => {
    const counts = { pages: 0, details: 0 };
    return {
      counts,
      async fetchText(url) {
        if (url.includes('/all-jobs')) { counts.pages++; return counts.pages === 1 ? enrichListing : ''; }
        counts.details++;
        const key = Object.keys(detailByUrl).find((k) => url.endsWith(k));
        return key ? detailByUrl[key] : '';
      },
    };
  };
  const onCtx = makeCtx();
  const enriched = await gjd.fetch({ pages: 5 }, onCtx);
  const prog = enriched.find((j) => j.title === 'Experienced Programmer');
  const artist = enriched.find((j) => j.title === 'Artist');
  if (
    onCtx.counts.details === 2 &&                          // every posting fetched (experience needs it)
    prog?.location === 'Guildford, United Kingdom' &&      // bare city → authoritative detail location
    prog?.experienceLevel === 'Junior-Associate' &&
    artist?.location === 'Daresbury, United Kingdom' &&    // already full — detail confirms
    artist?.experienceLevel === 'Director'
  ) {
    pass('games-jobs-direct.fetch() grabs location + experience level from every detail page by default');
  } else {
    fail(`enrichment e2e wrong: details=${onCtx.counts.details} jobs=${JSON.stringify(enriched.map((j) => ({ l: j.location, x: j.experienceLevel })))}`);
  }

  // enrich_experience:false, enrich_country:true → only bare-city cards fetched (cheap location-only mode).
  const locOnlyCtx = makeCtx();
  const locOnly = await gjd.fetch({ pages: 5, enrich_experience: false }, locOnlyCtx);
  if (
    locOnlyCtx.counts.details === 1 &&                                                 // only the bare-city card
    locOnly.find((j) => j.title === 'Experienced Programmer')?.location === 'Guildford, United Kingdom' &&
    locOnly.every((j) => j.experienceLevel === undefined)                             // no experience level set
  ) {
    pass('games-jobs-direct.fetch() honors enrich_experience:false (location-only, bare-city fetches only)');
  } else {
    fail(`enrich_experience:false wrong: details=${locOnlyCtx.counts.details} jobs=${JSON.stringify(locOnly.map((j) => ({ l: j.location, x: j.experienceLevel })))}`);
  }

  // Both off → no detail fetches at all; listing locations kept as-is.
  const offCtx = makeCtx();
  const unenriched = await gjd.fetch({ pages: 5, enrich_country: false, enrich_experience: false }, offCtx);
  if (offCtx.counts.details === 0 && unenriched.find((j) => j.title === 'Experienced Programmer')?.location === 'Guildford') {
    pass('games-jobs-direct.fetch() skips all detail fetches when both enrichments are off (city-only kept)');
  } else {
    fail(`both-off not honored: details=${offCtx.counts.details}`);
  }
} catch (e) {
  fail(`games-jobs-direct provider tests crashed: ${e.message}`);
}

// ── Provider — ingame-job ────────────────────────────────────────

console.log('\n17c. Provider — ingame-job');

try {
  const igj = (await import(pathToFileURL(join(ROOT, 'providers/ingamejob.mjs')).href)).default;
  const { parseIngameJobPage, parseRelativePostedDate } = await import(pathToFileURL(join(ROOT, 'providers/ingamejob.mjs')).href);

  if (igj.id === 'ingame-job') pass('ingame-job.id is "ingame-job"');
  else fail(`ingame-job.id is ${JSON.stringify(igj.id)}`);

  const hit = igj.detect({ careers_url: 'https://ingamejob.com/en/jobs' });
  const subHit = igj.detect({ careers_url: 'https://gb.ingamejob.com/en/jobs' });
  if (hit && hit.url === 'https://ingamejob.com/en/jobs' && subHit && subHit.url === 'https://gb.ingamejob.com/en/jobs') {
    pass('ingame-job.detect() claims ingamejob.com and its regional subdomains');
  } else {
    fail(`ingame-job.detect() returned ${JSON.stringify(hit)} / ${JSON.stringify(subHit)}`);
  }

  if (
    igj.detect({ careers_url: 'https://boards.greenhouse.io/x' }) === null &&
    igj.detect({ careers_url: 'https://evil-ingamejob.com' }) === null &&
    igj.detect({ careers_url: 'https://evil.example/ingamejob.com/jobs' }) === null &&
    igj.detect({ careers_url: null }) === null
  ) {
    pass('ingame-job.detect() rejects lookalike hosts, path-spoofs, and non-string URLs');
  } else {
    fail('ingame-job.detect() must reject spoofed/invalid careers URLs');
  }

  // Relative-date parser — anchored to a fixed "now" so results are deterministic.
  const NOW = Date.parse('2026-07-01T18:00:00.000Z');
  if (
    parseRelativePostedDate('Posted just now', NOW) === '2026-07-01T18:00:00.000Z' &&
    parseRelativePostedDate('Posted 7 hours ago', NOW) === '2026-07-01T11:00:00.000Z' &&
    parseRelativePostedDate('Posted a day ago', NOW) === '2026-06-30T18:00:00.000Z' &&
    parseRelativePostedDate('Posted 2 days ago', NOW) === '2026-06-29T18:00:00.000Z' &&
    parseRelativePostedDate('Posted 1 week ago', NOW) === '2026-06-24T18:00:00.000Z' &&
    parseRelativePostedDate('whenever', NOW) === '' &&
    parseRelativePostedDate('', NOW) === ''
  ) {
    pass('parseRelativePostedDate converts relative "Posted N unit ago" to ISO, empty when unparseable');
  } else {
    fail('parseRelativePostedDate is wrong');
  }

  // Two well-formed cards (one remote, one onsite w/ city) + one malformed card
  // with no /en/job/ link that must be skipped.
  const sampleHtml = `
    <div class="employer-job-listing-single shadow-sm bg-white mb-3 p-3"><div class="listing-job-info container"><div class="row text-muted">
      <div class="col-12 p-0"><h5><a href="https://ingamejob.com/en/job/middlesenior-unity-developer-27"> Senior/Lead Unity Developer </a></h5></div>
      <div class="col-sm-6 p-0">
        <p class="m-0"><strong><i class="la la-building-o"></i> Junkineering &amp; Co</strong></p>
        <p class="m-0"><i class="text-muted la la-map-marker"></i> Remote </p>
        <p class="m-0"><i class="la la-clock-o"></i> Posted 5 days ago</p>
      </div></div></div></div>
    <div class="employer-job-listing-single shadow-sm bg-white mb-3 p-3"><div class="listing-job-info container"><div class="row text-muted">
      <div class="col-12 p-0"><h5><a href="https://ingamejob.com/en/job/senior-unity-developer-255"> Senior Unity Developer </a></h5></div>
      <div class="col-sm-6 p-0">
        <p class="m-0"><strong><i class="la la-building-o"></i> Plummy Games</strong></p>
        <p class="m-0"><i class="text-muted la la-map-marker"></i> Remote, Warsaw </p>
        <p class="m-0"><i class="la la-clock-o"></i> Posted 2 days ago</p>
      </div></div></div></div>
    <div class="employer-job-listing-single shadow-sm bg-white mb-3 p-3"><div class="listing-job-info container">
      <p>No job link here</p>
    </div></div>`;
  const jobs = parseIngameJobPage(sampleHtml, NOW);
  if (jobs.length === 2) pass('parseIngameJobPage keeps cards with an /en/job/ link, skips malformed');
  else fail(`parseIngameJobPage returned ${jobs.length} jobs (expected 2)`);

  if (
    jobs[0]?.title === 'Senior/Lead Unity Developer' &&
    jobs[0]?.url === 'https://ingamejob.com/en/job/middlesenior-unity-developer-27' &&
    jobs[0]?.company === 'Junkineering & Co' &&        // entity-decoded
    jobs[0]?.location === '' &&                        // "Remote" lifted out of location text
    jobs[0]?.workMode === 'remote' &&
    jobs[0]?.postedDate === '2026-06-26T18:00:00.000Z'
  ) {
    pass('parseIngameJobPage extracts title/url/company + lifts workMode from "Remote", decodes entities');
  } else {
    fail(`row 0 = ${JSON.stringify(jobs[0])}`);
  }

  if (jobs[1]?.location === 'Warsaw' && jobs[1]?.workMode === 'remote') {
    pass('parseIngameJobPage splits "Remote, Warsaw" into location=Warsaw + workMode=remote');
  } else {
    fail(`row 1 = ${JSON.stringify(jobs[1])}`);
  }

  if (parseIngameJobPage(null).length === 0 && parseIngameJobPage('').length === 0) {
    pass('parseIngameJobPage handles null/empty input without crashing');
  } else {
    fail('parseIngameJobPage should yield empty result for null/empty input');
  }

  // End-to-end: walks pages until an empty one, dedupes by URL across queries,
  // and honors the custom host + per-query page cap.
  const page1 = `<div class="employer-job-listing-single"><div><h5><a href="https://ingamejob.com/en/job/a-1"> A </a></h5></div>
    <p><i class="la la-building-o"></i> Co A</p><p><i class="la la-map-marker"></i> Kyiv</p><p><i class="la la-clock-o"></i> Posted 1 day ago</p></div>`;
  const dupPage = `<div class="employer-job-listing-single"><div><h5><a href="https://ingamejob.com/en/job/a-1"> A </a></h5></div>
    <p><i class="la la-building-o"></i> Co A</p></div>`;
  const reqs = [];
  const ctx = {
    async fetchText(url) {
      reqs.push(url);
      if (url.includes('p/unity-developer') && url.includes('page=1')) return page1;
      if (url.includes('p/c-developer') && url.includes('page=1')) return dupPage; // same job, different query
      return ''; // any page 2 (or other) is empty → stop
    },
  };
  const e2e = await igj.fetch({ queries: ['p/unity-developer', 'p/c-developer'], host: 'gb.ingamejob.com' }, ctx);
  if (
    e2e.length === 1 &&                                            // deduped across queries by URL
    e2e[0].url === 'https://ingamejob.com/en/job/a-1' &&
    reqs.every((u) => u.startsWith('https://gb.ingamejob.com/')) && // custom host honored
    reqs.some((u) => u.includes('/en/jobs/p/unity-developer?page=1'))
  ) {
    pass('ingame-job.fetch() walks to empty page, dedupes by URL across queries, honors custom host');
  } else {
    fail(`ingame-job e2e wrong: jobs=${JSON.stringify(e2e.map((j) => j.url))} reqs=${JSON.stringify(reqs)}`);
  }

  // Bad host config falls back to the global default (never points elsewhere).
  const reqs2 = [];
  await igj.fetch({ queries: [''], host: 'https://evil.example/' }, { async fetchText(u) { reqs2.push(u); return ''; } });
  if (reqs2.every((u) => u.startsWith('https://ingamejob.com/'))) {
    pass('ingame-job.fetch() falls back to global host when config host is not an ingamejob.com host');
  } else {
    fail(`bad-host fallback wrong: ${JSON.stringify(reqs2)}`);
  }
} catch (e) {
  fail(`ingame-job provider tests crashed: ${e.message}`);
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
  const ps = await import(pathToFileURL(join(ROOT, 'probe', 'probe-studios.mjs')).href);
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

  // classifyCanary: ROT-SAFETY. A throttle/error disables the ATS, but a clean 404
  // or unparseable 2xx (the canary company left the ATS) only flags STALE — it must
  // NEVER disable, so a discontinued canary can't silently kill a working ATS.
  const cc = ps.classifyCanary;
  if (cc({ kind: 'data', data: { jobs: [] } }) === 'ok' &&          // empty board = still live
      cc({ kind: 'data', data: null }) === 'stale-2xx' &&           // 2xx unparseable = maybe rot
      cc({ kind: 'notfound' }) === 'stale-404' &&                   // 404 = company left → stale, NOT disabled
      cc({ kind: 'uncertain', reason: 'throttled' }) === 'disabled' &&
      cc({ kind: 'dnsfail', reason: 'dns_notfound' }) === 'disabled') {
    pass('classifyCanary: throttle/error→disabled, but a stale 404/2xx canary only warns (rot-safe)');
  } else {
    fail('classifyCanary rot-safety contract wrong');
  }

  // Namesake vetting — country/location cross-check. inferCountry fires only on
  // clear place signals; locContradicts is true only when both sides are known and
  // differ (bare "Remote" never contradicts → no false rejects).
  const { inferCountry, locContradicts } = ps;
  if (inferCountry('Palo Alto') === 'US' && inferCountry('Eindhoven, Nederland') === 'NL' &&
      inferCountry('Seoul, Korea') === 'KR' && inferCountry('Remote') === '' && inferCountry('') === '') {
    pass('inferCountry: reads clear place signals, returns empty for bare "Remote"/unknown');
  } else {
    fail(`inferCountry wrong: ${inferCountry('Palo Alto')}/${inferCountry('Eindhoven, Nederland')}/${inferCountry('Remote')}`);
  }
  if (locContradicts('NL', 'Palo Alto') === true &&        // NL studio, US-only role → namesake
      locContradicts('NL', 'Amsterdam') === false &&       // matches → fine
      locContradicts('NL', 'Remote') === false &&          // undeterminable → can't disprove
      locContradicts('', 'Palo Alto') === false &&         // unknown studio country → no judgement
      locContradicts('SE', 'Stockholm') === false) {
    pass('locContradicts: true only when studio country and a determinable hit location differ');
  } else {
    fail('locContradicts contract wrong');
  }

  // tierFor common-word review gate: a lone everyday-word slug on a namesake-prone
  // ATS is VERIFY; a distinctive name-slug is MEDIUM.
  const np = { id: 'ashby', namesakeProne: true, endpoints: [] };
  if (ps.tierFor(np, {}, 'vector') === 'verify' && ps.tierFor(np, {}, 'architect') === 'verify' &&
      ps.tierFor(np, {}, 'playerunknown') === 'medium') {
    pass('tierFor: everyday-word slug → VERIFY (review gate), distinctive slug → MEDIUM');
  } else {
    fail(`tierFor review gate wrong: vector=${ps.tierFor(np, {}, 'vector')} pu=${ps.tierFor(np, {}, 'playerunknown')}`);
  }

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

  // ── hit confidence tier (namesake quarantine) ──
  // Only a TRUSTED hit (high/medium) closes a studio. A verify-tier hit (generic
  // slug, namesake risk) or a legacy hit with no recorded tier keeps it OPEN so it
  // re-surfaces for review instead of silently counting as a resolved win.
  const lt = new Map([
    ['hi', { name: 'Hi', version: ps.SCAN_VERSION, hit: 'greenhouse', hitConf: 'high', missed: new Set(), last: 'x' }],
    ['me', { name: 'Me', version: ps.SCAN_VERSION, hit: 'lever', hitConf: 'medium', missed: new Set(), last: 'x' }],
    ['ve', { name: 'Ve', version: ps.SCAN_VERSION, hit: 'breezy', hitConf: 'verify', missed: new Set(['greenhouse']), last: 'x' }],
    ['lg', { name: 'Lg', version: ps.SCAN_VERSION, hit: 'breezy', hitConf: '', missed: new Set(['greenhouse']), last: 'x' }],
  ]);
  const openHi = ps.ledgerOpen(lt, 'hi', ids);
  const openMe = ps.ledgerOpen(lt, 'me', ids);
  const openVe = ps.ledgerOpen(lt, 've', ids);
  const openLg = ps.ledgerOpen(lt, 'lg', ids);
  if (openHi.size === 0 && openMe.size === 0 &&
      openVe.size === 2 && !openVe.has('greenhouse') &&
      openLg.size === 2 && !openLg.has('greenhouse')) {
    pass('ledgerOpen: high/medium hit → resolved (skip), verify/legacy hit → stays open (needs review)');
  } else {
    fail(`ledgerOpen tier gate wrong: hi=${openHi.size} me=${openMe.size} ve=${[...openVe]} lg=${[...openLg]}`);
  }
  // mergeLedger records the probe's confidence on a hit, and carries the prior
  // tier through a later no-hit pass (must not blank an earlier hit's confidence).
  const lc = new Map();
  ps.mergeLedger(lc, 'x', 'X', { ats: 'breezy', confidence: 'verify', missedAts: ['greenhouse'] });
  const afterHit = lc.get('x');
  ps.mergeLedger(lc, 'x', 'X', { ats: null, missedAts: ['lever'] }); // a later no-hit pass
  const afterMiss = lc.get('x');
  if (afterHit.hit === 'breezy' && afterHit.hitConf === 'verify' &&
      afterMiss.hit === 'breezy' && afterMiss.hitConf === 'verify') {
    pass('mergeLedger: records hit confidence, carries it through a later no-hit pass');
  } else {
    fail(`mergeLedger confidence wrong: hit=${JSON.stringify(afterHit)} miss=${JSON.stringify(afterMiss)}`);
  }
  // loadLedger backward compatibility: a legacy 6-column row parses (hitConf '')
  // and a 7-column row reads its tier. Round-trips through a temp file.
  const tmpLed = join(mkdtempSync(join(tmpdir(), 'probe-ledger-')), 'state.tsv');
  writeFileSync(tmpLed, [
    '# header',
    'legacy\tLegacy Co\t' + ps.SCAN_VERSION + '\tbreezy\tgreenhouse\t2026-06-14',          // 6 cols (old)
    'tiered\tTiered Co\t' + ps.SCAN_VERSION + '\tlever\t\t2026-06-14\tmedium',             // 7 cols (new)
  ].join('\n') + '\n');
  const loaded = ps.loadLedger(tmpLed);
  rmSync(dirname(tmpLed), { recursive: true, force: true });
  if (loaded.get('legacy')?.hitConf === '' && loaded.get('tiered')?.hitConf === 'medium' &&
      loaded.get('legacy')?.hit === 'breezy' && loaded.get('legacy')?.missed.has('greenhouse')) {
    pass('loadLedger: legacy 6-col row → empty tier (untrusted); 7-col row reads its tier');
  } else {
    fail(`loadLedger back-compat wrong: ${JSON.stringify([...loaded])}`);
  }

  // --quick must NOT close a provider that has an untried domain endpoint (it
  // skips the custom-domain sweep), so a later full run still probes it. A
  // slug-only provider IS fully covered by quick and DOES close. We re-import
  // with --quick in argv (cache-busted) since QUICK is read at module load.
  const savedArgv = process.argv;
  process.argv = [...savedArgv, '--quick'];
  const psQ = await import(pathToFileURL(join(ROOT, 'probe', 'probe-studios.mjs')).href + '?quick=1');
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

// ── Provider — personio search.json fallback + rehm single-studio ───

console.log('\n22. Provider — personio search.json + rehm single-studio');

try {
  const { parsePersonioSearchJson } = await import(pathToFileURL(join(ROOT, 'providers/personio.mjs')).href);
  const sample = JSON.stringify([
    { id: 1111501, name: 'QA Internship (m/f/d)', office: 'Ingelheim', department: 'QA' },
    { id: 432429, name: 'Game Designer (m/f/d)', office: 'Remote or Berlin' },
    { name: 'Missing id' },                    // no id → skipped
    { id: 999, name: '' },                     // empty title → skipped
    { id: 1111501, name: 'Duplicate id' },     // dup url → skipped
  ]);
  const pj = parsePersonioSearchJson(sample, 'https://envision-entertainment.jobs.personio.com', 'Envision');
  if (pj.length === 2) pass('parsePersonioSearchJson keeps valid rows, skips missing/empty/dup');
  else fail(`parsePersonioSearchJson returned ${pj.length} (expected 2): ${JSON.stringify(pj.map(j=>j.title))}`);

  if (pj[0]?.url === 'https://envision-entertainment.jobs.personio.com/job/1111501' &&
      pj[0]?.location === 'Ingelheim' && pj[0]?.department === 'QA' && pj[0]?.company === 'Envision') {
    pass('parsePersonioSearchJson builds /job/{id} URL + maps office→location, department, company');
  } else {
    fail(`row 0 = ${JSON.stringify(pj[0])}`);
  }

  if (parsePersonioSearchJson('not json', 'https://x', 'X').length === 0 &&
      parsePersonioSearchJson('{}', 'https://x', 'X').length === 0 &&
      parsePersonioSearchJson('', 'https://x', 'X').length === 0) {
    pass('parsePersonioSearchJson returns [] on invalid/non-array/empty input (fail-safe)');
  } else {
    fail('parsePersonioSearchJson should yield [] for invalid input');
  }

  const { recordMatchesStudio } = await import(pathToFileURL(join(ROOT, 'providers/rehm.mjs')).href);
  if (recordMatchesStudio({ source_studio: 'amber', company: 'Amber' }, 'amber') &&
      recordMatchesStudio({ source_studio: 'capcomusa', company: 'Capcom' }, 'capcom')) {
    pass('recordMatchesStudio matches on exact source_studio slug or company name');
  } else {
    fail('recordMatchesStudio failed to match a real studio');
  }

  // The substring trap: "cloud-chamber" contains "...ch-amber" — must NOT match.
  if (!recordMatchesStudio({ source_studio: 'cloud-chamber', company: 'Cloud Chamber' }, 'amber') &&
      !recordMatchesStudio({ source_studio: 'x', company: 'y' }, '') &&
      !recordMatchesStudio(null, 'amber')) {
    pass('recordMatchesStudio is exact (no substring), and safe on empty/null');
  } else {
    fail('recordMatchesStudio must not substring-match and must be null/empty-safe');
  }
} catch (e) {
  fail(`personio/rehm provider tests crashed: ${e.message}`);
}

// ── Provider — jobvite (legacy table + modern card markup) ──────────

console.log('\n23. Provider — jobvite legacy + modern board markup');

try {
  const { parseJobviteList } = await import(pathToFileURL(join(ROOT, 'providers/jobvite.mjs')).href);

  // Legacy table boards (e.g. playground-games): /jobs serves <td> rows.
  const tableHtml = `
    <table><tbody>
      <tr>
        <td class="jv-job-list-name"><a href="/playground-games/job/oABC">Game Designer</a></td>
        <td class="jv-job-list-location">Hybrid, Leamington Spa, United Kingdom</td>
      </tr>
      <tr>
        <td class="jv-job-list-name"><a href="/playground-games/job/oDEF">Media Lead</a></td>
        <td class="jv-job-list-location">Leamington Spa, United Kingdom</td>
      </tr>
    </tbody></table>`;
  const tj = parseJobviteList(tableHtml, 'Playground Games');
  if (tj.length === 2 && tj[0].title === 'Game Designer' &&
      tj[0].url === 'https://jobs.jobvite.com/playground-games/job/oABC' &&
      tj[0].workMode === 'hybrid' && tj[0].location === 'Leamington Spa, United Kingdom' &&
      tj[0].company === 'Playground Games') {
    pass('parseJobviteList parses legacy <td> table rows (href, title, workMode, location, company)');
  } else {
    fail(`legacy table parse = ${JSON.stringify(tj)}`);
  }

  // Modern card boards (e.g. amberstudiocareers): /jobs/positions serves
  // <li class="job-item"> cards, and repeats some openings in a Featured block
  // (different markup, same job URL) which must dedupe out.
  const cardHtml = `
    <ul class="list-unstyled"><li class="jv-featured-job m1 flex-col flex-center">
      <a href="/amberstudiocareers/job/oqFkAfwJ"><div class="jv-featured-job-title">2D Animator</div></a>
    </li></ul>
    <ul class="list-unstyled">
      <li class="job-item">
        <a href="/amberstudiocareers/job/oqFkAfwJ" class="jv-button jv-button--hollow">
          <span>
            <div class="jv-job-list-name">2D Animator</div>
            <div class="jv-job-list-location">Remote<span>,</span> Bucharest, Romania</div>
          </span>
        </a>
      </li>
      <li class="job-item">
        <a href="/amberstudiocareers/job/ouf0yfw1" class="jv-button">
          <div class="jv-job-list-name">2D Illustrator</div>
          <div class="jv-job-list-location">Manila, Philippines</div>
        </a>
      </li>
    </ul>`;
  const cj = parseJobviteList(cardHtml, 'Amber');
  if (cj.length === 2 && cj[0].title === '2D Animator' &&
      cj[0].url === 'https://jobs.jobvite.com/amberstudiocareers/job/oqFkAfwJ' &&
      cj[0].workMode === 'remote' && cj[0].location === 'Bucharest, Romania' &&
      cj[1].title === '2D Illustrator') {
    pass('parseJobviteList parses modern <li class="job-item"> cards and dedupes the Featured block');
  } else {
    fail(`modern card parse = ${JSON.stringify(cj)}`);
  }

  if (parseJobviteList('', 'X').length === 0 &&
      parseJobviteList('<div>no jobs here</div>', 'X').length === 0) {
    pass('parseJobviteList returns [] on empty/iframe-only board (fail-safe)');
  } else {
    fail('parseJobviteList should yield [] when no rows present');
  }
} catch (e) {
  fail(`jobvite provider tests crashed: ${e.message}`);
}

// ── Provider — zohorecruit (entity-encoded JSON island) ─────────────

console.log('\n24. Provider — zohorecruit JSON island');

try {
  const { parseZohoHtml } = await import(pathToFileURL(join(ROOT, 'providers/zohorecruit.mjs')).href);

  // The career site embeds the whole list as an HTML-entity-encoded JSON array
  // inside <input id="jobs" value="…">. Quotes arrive as &#34; / &quot;.
  const island = JSON.stringify([
    { Posting_Title: 'Senior Unreal Developer', id: '491343000016162049', City: 'Québec', Country: 'Canada', Remote_Job: false, Publish: true },
    { Job_Opening_Name: 'Game Designer', id: '758428000002963001', City: null, Country: null, Remote_Job: true, Publish: true },
    { Posting_Title: 'Draft Role (hidden)', id: '999', City: 'X', Country: 'Y', Publish: false },
  ]).replace(/"/g, '&#34;').replace(/&(?!#34;)/g, '&amp;');
  const html = `<input type="hidden" id="jobs" value="${island}"><input type="hidden" id="pageJson" value="{}">`;
  const zj = parseZohoHtml(html, 'BKOM Studios', 'https://jobs.bkom.com');
  if (zj.length === 2 &&
      zj[0].title === 'Senior Unreal Developer' &&
      zj[0].url === 'https://jobs.bkom.com/jobs/Careers/491343000016162049' &&
      zj[0].location === 'Québec, Canada' && zj[0].company === 'BKOM Studios' && !zj[0].workMode &&
      zj[1].title === 'Game Designer' && zj[1].location === '' && zj[1].workMode === 'remote') {
    pass('parseZohoHtml decodes the island, builds /jobs/Careers/{id} URLs, maps City/Country + Remote_Job, drops unpublished');
  } else {
    fail(`zoho island parse = ${JSON.stringify(zj)}`);
  }

  if (parseZohoHtml('', 'X', 'https://x.zohorecruit.com').length === 0 &&
      parseZohoHtml('<div>no jobs input here</div>', 'X', 'https://x.zohorecruit.com').length === 0 &&
      parseZohoHtml('<input id="jobs" value="not json">', 'X', 'https://x.zohorecruit.com').length === 0) {
    pass('parseZohoHtml returns [] on missing input / non-JSON value (fail-safe)');
  } else {
    fail('parseZohoHtml should yield [] when the island is absent or unparseable');
  }
} catch (e) {
  fail(`zohorecruit provider tests crashed: ${e.message}`);
}

// ── Provider — huntflow (same-origin /api/vacancy JSON) ─────────────

console.log('\n25. Provider — huntflow /api/vacancy');

try {
  const { parseHuntflowPage } = await import(pathToFileURL(join(ROOT, 'providers/huntflow.mjs')).href);

  // A /api/vacancy page: {total(page count), page, items:[...]}. Each item has
  // slug/position/division/city/archived_at. archived rows are closed.
  const page = {
    total: 1,
    page: 1,
    items: [
      { id: 26840, slug: 'animator-1', position: 'Animator', division: null, city: null, archived_at: null },
      { id: 25388, slug: 'lead-game-designer', position: 'Lead Game Designer', division: 'Game Design', city: null, archived_at: null },
      { id: 26348, slug: 'unreal-engine-render-developer', position: 'Unreal Engine Graphics Programmer', division: null, city: 'Remote, Europe timezone', archived_at: null },
      { id: 999, slug: 'old-role', position: 'Closed Role', division: null, city: null, archived_at: '2026-01-01T00:00:00Z' },
    ],
  };
  const hj = parseHuntflowPage(page, 'Saber Interactive', 'https://saberjobs.huntflow.io');
  if (hj.length === 3 &&
      hj[0].title === 'Animator' &&
      hj[0].url === 'https://saberjobs.huntflow.io/vacancy/animator-1' &&
      hj[0].company === 'Saber Interactive' && hj[0].location === '' && !hj[0].workMode &&
      hj[1].department === 'Game Design' &&
      hj[2].location === 'Remote, Europe timezone' && hj[2].workMode === 'remote') {
    pass('parseHuntflowPage maps slug→/vacancy/{slug}, division→department, infers remote from city, drops archived');
  } else {
    fail(`huntflow page parse = ${JSON.stringify(hj)}`);
  }

  // Dedup across pages via a shared seen-set; malformed payloads yield [].
  const seen = new Set();
  const a = parseHuntflowPage({ items: [{ slug: 'x', position: 'X' }] }, 'C', 'https://x.huntflow.io', seen);
  const b = parseHuntflowPage({ items: [{ slug: 'x', position: 'X dup' }] }, 'C', 'https://x.huntflow.io', seen);
  if (a.length === 1 && b.length === 0 &&
      parseHuntflowPage(null, 'C', 'https://x.huntflow.io').length === 0 &&
      parseHuntflowPage({ items: 'nope' }, 'C', 'https://x.huntflow.io').length === 0 &&
      parseHuntflowPage({ items: [{ position: 'no slug' }] }, 'C', 'https://x.huntflow.io').length === 0) {
    pass('parseHuntflowPage dedups by slug across pages and returns [] on missing/malformed payloads (fail-safe)');
  } else {
    fail('parseHuntflowPage should dedup and fail safe on bad input');
  }
} catch (e) {
  fail(`huntflow provider tests crashed: ${e.message}`);
}

// ── Provider — gamejobs.co (sitemap slug-parse + JSON-LD enrichment) ─

console.log('\n26. Provider — gamejobs-co sitemap + JSON-LD');

try {
  const { jobFromSlug, parseSitemapJobs } =
    await import(pathToFileURL(join(ROOT, 'providers/gamejobs.mjs')).href);
  const { parseJobPostingLd } =
    await import(pathToFileURL(join(ROOT, 'providers/_jsonld.mjs')).href);

  // Slug parse: split on the LAST "-at-", strip a trailing "-{n}" dedup suffix,
  // hyphens → spaces. No "-at-" → whole slug is the title, empty company.
  const s1 = jobFromSlug('https://gamejobs.co/Senior-Producer-at-Triband');
  const s2 = jobFromSlug('https://gamejobs.co/Product-Manager-at-MobilityWare-5431');
  const s3 = jobFromSlug('https://gamejobs.co/Just-A-Title');
  if (s1.title === 'Senior Producer' && s1.company === 'Triband' &&
      s2.title === 'Product Manager' && s2.company === 'MobilityWare' &&
      s3.title === 'Just A Title' && s3.company === '') {
    pass('jobFromSlug splits on last -at-, strips dedup suffix, fails safe with no -at-');
  } else {
    fail(`jobFromSlug = ${JSON.stringify([s1, s2, s3])}`);
  }

  // Sitemap: keep only "-at-" job URLs (skip homepage + nested sitemaps), dedupe.
  const xml = `<?xml version="1.0"?><urlset>
    <url><loc>https://gamejobs.co</loc></url>
    <url><loc>https://gamejobs.co/Tools-Programmer-at-Studio-X</loc></url>
    <url><loc>https://gamejobs.co/Tools-Programmer-at-Studio-X</loc></url>
    <url><loc>https://gamejobs.co/sitemap-2.xml</loc></url>
  </urlset>`;
  const sm = parseSitemapJobs(xml);
  if (sm.length === 1 && sm[0].company === 'Studio X' &&
      parseSitemapJobs('').length === 0 && parseSitemapJobs(null).length === 0) {
    pass('parseSitemapJobs keeps -at- URLs, drops homepage/nested-sitemap, dedupes, fails safe');
  } else {
    fail(`parseSitemapJobs = ${JSON.stringify(sm)}`);
  }

  // JSON-LD: pick the JobPosting (even inside @graph), map org/location/date, and
  // read a TELECOMMUTE flag as remote. address may be a string or PostalAddress.
  const html = `<html><head>
    <script type="application/ld+json">{"@type":"BreadcrumbList"}</script>
    <script type="application/ld+json">{"@graph":[{"@type":"JobPosting",
      "title":"Unity Tools Developer (Core Tech)",
      "datePosted":"2026-06-23T10:58:13Z",
      "hiringOrganization":{"@type":"Organization","name":"Triband"},
      "jobLocation":{"@type":"Place","address":{"addressLocality":"Copenhagen","addressCountry":"DK"}},
      "jobLocationType":"TELECOMMUTE"}]}</script>
  </head></html>`;
  const ld = parseJobPostingLd(html);
  if (ld && ld.title === 'Unity Tools Developer (Core Tech)' && ld.company === 'Triband' &&
      ld.location === 'Copenhagen, DK' && ld.workMode === 'remote' &&
      ld.postedDate === '2026-06-23T10:58:13.000Z') {
    pass('parseJobPostingLd reads JobPosting from @graph, maps org/address/date, TELECOMMUTE→remote');
  } else {
    fail(`parseJobPostingLd = ${JSON.stringify(ld)}`);
  }

  // Fail-safe: no JobPosting / unparseable / missing input → null, never throws.
  if (parseJobPostingLd('<script type="application/ld+json">not json</script>') === null &&
      parseJobPostingLd('<html>no ld</html>') === null &&
      parseJobPostingLd('') === null && parseJobPostingLd(null) === null) {
    pass('parseJobPostingLd returns null on missing/invalid/non-JobPosting input (fail-safe)');
  } else {
    fail('parseJobPostingLd should return null on bad input');
  }
} catch (e) {
  fail(`gamejobs-co provider tests crashed: ${e.message}`);
}

// ── Provider — gamedevjobs.com (sitemap-index + JSON-LD enrichment) ─

console.log('\n27. Provider — gamedevjobs sitemap-index + JSON-LD');

try {
  const { jobFromSlug, parseSitemapIndex, parseJobsSitemap } =
    await import(pathToFileURL(join(ROOT, 'providers/gamedevjobs.mjs')).href);

  // Slug parse: /jobs/{title}-{hexid} → title only (company/location come from the
  // page). Strip the trailing 8+ hex id; seed postedDate from <lastmod>. Fail-safe
  // on a URL that doesn't fit the pattern.
  const s1 = jobFromSlug('https://gamedevjobs.com/jobs/senior-unity-c-developer-83170d42', '2026-06-30');
  const s2 = jobFromSlug('https://gamedevjobs.com/jobs/lead-game-designer-75a24f0a');
  if (s1.title === 'Senior Unity C Developer' && s1.company === '' &&
      s1.postedDate === '2026-06-30T00:00:00.000Z' &&
      s2.title === 'Lead Game Designer' && s2.postedDate === undefined) {
    pass('gamedevjobs jobFromSlug strips hex id, title-only, seeds date from lastmod');
  } else {
    fail(`gamedevjobs jobFromSlug = ${JSON.stringify([s1, s2])}`);
  }

  // Sitemap index: keep only the jobs sub-sitemaps (skip pages.xml), dedupe.
  const idx = `<?xml version="1.0"?><sitemapindex>
    <sitemap><loc>https://gamedevjobs.com/sitemaps/pages.xml</loc></sitemap>
    <sitemap><loc>https://gamedevjobs.com/sitemaps/jobs-0.xml</loc></sitemap>
    <sitemap><loc>https://gamedevjobs.com/sitemaps/jobs-1.xml</loc></sitemap>
  </sitemapindex>`;
  const subs = parseSitemapIndex(idx);
  if (subs.length === 2 && subs.every((u) => /jobs-\d+\.xml$/.test(u)) &&
      parseSitemapIndex('').length === 0 && parseSitemapIndex(null).length === 0) {
    pass('parseSitemapIndex keeps jobs-*.xml, drops pages.xml, fails safe');
  } else {
    fail(`parseSitemapIndex = ${JSON.stringify(subs)}`);
  }

  // Jobs sub-sitemap: one job per <url>, carry <lastmod> into postedDate, dedupe.
  const jobsXml = `<?xml version="1.0"?><urlset>
    <url><loc>https://gamedevjobs.com/jobs/gameplay-developer-79e1b187</loc><lastmod>2026-06-30</lastmod></url>
    <url><loc>https://gamedevjobs.com/jobs/gameplay-developer-79e1b187</loc><lastmod>2026-06-30</lastmod></url>
    <url><loc>https://gamedevjobs.com/jobs/ui-ux-designer-57d6fa6b</loc></url>
  </urlset>`;
  const sm = parseJobsSitemap(jobsXml);
  if (sm.length === 2 && sm[0].title === 'Gameplay Developer' &&
      sm[0].postedDate === '2026-06-30T00:00:00.000Z' && sm[1].postedDate === undefined &&
      parseJobsSitemap('').length === 0 && parseJobsSitemap(null).length === 0) {
    pass('parseJobsSitemap parses url+lastmod, dedupes, fails safe');
  } else {
    fail(`parseJobsSitemap = ${JSON.stringify(sm)}`);
  }
} catch (e) {
  fail(`gamedevjobs provider tests crashed: ${e.message}`);
}

// ── Aggregator-host registry consistency ────────────────────────
// Every multi-studio BOARD provider (one that serves its own URLs across many
// studios) declares `aggregatorHosts` on its default export. Those hosts MUST be
// in scan.mjs's DEFAULT_AGGREGATORS or snapshot dedup can't collapse the board's
// mirrors of first-party postings — exactly the gap that let gamejobs.co +
// gamedevjobs duplicate silently before they were listed. This guard makes the
// next new board impossible to forget: declare the field, or the reverse check
// flags an orphan list entry. (Direct ATS providers omit the field; rehm omits it
// too because it emits each studio's real source_url, not a board URL.)

console.log('\n28. Aggregator-host registry ⇄ scan.mjs dedup lists');

try {
  const { DEFAULT_AGGREGATORS, DEFAULT_LAST_RESORT } =
    await import(pathToFileURL(join(ROOT, 'scan.mjs')).href);
  const norm = (h) => String(h).toLowerCase().replace(/^www\./, '');
  const aggSet = new Set(DEFAULT_AGGREGATORS.map(norm));
  const lastSet = new Set(DEFAULT_LAST_RESORT.map(norm));

  const dir = join(ROOT, 'providers');
  const files = readdirSync(dir).filter(f => f.endsWith('.mjs') && !f.startsWith('_'));
  const declared = new Set();      // every host declared by any provider
  const lastDeclared = new Set();  // hosts declared by a lastResort provider
  let forwardOk = true;
  let lastOk = true;

  for (const f of files) {
    const p = (await import(pathToFileURL(join(dir, f)).href)).default;
    if (!p || !Array.isArray(p.aggregatorHosts)) continue;
    for (const raw of p.aggregatorHosts) {
      const h = norm(raw);
      declared.add(h);
      // Forward: a declared board host must be in DEFAULT_AGGREGATORS.
      if (!aggSet.has(h)) { forwardOk = false; fail(`${f}: aggregatorHost "${h}" missing from scan.mjs DEFAULT_AGGREGATORS`); }
      if (p.lastResort === true) {
        lastDeclared.add(h);
        // A last-resort board's hosts must also be in DEFAULT_LAST_RESORT.
        if (!lastSet.has(h)) { lastOk = false; fail(`${f}: lastResort host "${h}" missing from scan.mjs DEFAULT_LAST_RESORT`); }
      }
    }
  }

  if (forwardOk && declared.size >= 7) pass(`all ${declared.size} declared board hosts are in DEFAULT_AGGREGATORS`);
  else if (declared.size < 7) fail(`expected >= 7 board providers declaring aggregatorHosts, found ${declared.size}`);

  if (lastOk && lastDeclared.size >= 1) pass(`all ${lastDeclared.size} lastResort host(s) are in DEFAULT_LAST_RESORT`);
  else if (lastDeclared.size < 1) fail('expected >= 1 provider declaring lastResort:true (gamedevjobs)');

  // Reverse: no orphan host in DEFAULT_AGGREGATORS that no provider declares
  // (catches a host left in the list after its provider was removed/renamed).
  const orphans = [...aggSet].filter(h => !declared.has(h));
  if (orphans.length === 0) pass('no orphan hosts in DEFAULT_AGGREGATORS (every entry is backed by a provider)');
  else fail(`DEFAULT_AGGREGATORS has orphan host(s) with no declaring provider: ${orphans.join(', ')}`);

  // Internal consistency: last-resort ⊆ aggregators (a last-resort host still wins-
  // against by direct postings via the aggregator gate).
  const notAgg = [...lastSet].filter(h => !aggSet.has(h));
  if (notAgg.length === 0) pass('DEFAULT_LAST_RESORT ⊆ DEFAULT_AGGREGATORS');
  else fail(`DEFAULT_LAST_RESORT host(s) not in DEFAULT_AGGREGATORS: ${notAgg.join(', ')}`);
} catch (e) {
  fail(`aggregator-host registry tests crashed: ${e.message}`);
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
