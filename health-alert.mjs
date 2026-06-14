// Open / update / close a single GitHub issue from the board's health.json.
//
// Run by the daily board workflow AFTER a successful publish. Idempotent: it
// keeps exactly one issue (matched by a fixed label) instead of opening a new
// one every day —
//   • alerts present, no open issue  → create it
//   • alerts present, issue exists   → edit the body to the current list
//   • alerts cleared, issue open     → close it with a note
//
// Shells out to the `gh` CLI, which is preinstalled on GitHub runners and
// authenticated via the GH_TOKEN env var (set from secrets.GITHUB_TOKEN in the
// workflow). If gh/token is unavailable it no-ops loudly rather than failing
// the board run — an alert delivery problem must never block the publish.
//
// Usage: node health-alert.mjs site/data/health.json

import { readFileSync, existsSync } from 'fs';
import { execFileSync } from 'child_process';

const LABEL = 'ats-health';
const TITLE = '🔴 Job board: companies may have left their ATS';

function gh(args, { allowFail = false } = {}) {
  try {
    return execFileSync('gh', args, { encoding: 'utf-8' }).trim();
  } catch (err) {
    if (allowFail) return null;
    throw err;
  }
}

function main() {
  const healthPath = process.argv[2] || 'site/data/health.json';
  if (!existsSync(healthPath)) {
    console.log(`health-alert: no ${healthPath} (scan skipped publish?) — nothing to do.`);
    return;
  }
  if (!process.env.GH_TOKEN && !process.env.GITHUB_TOKEN) {
    console.log('health-alert: no GH_TOKEN/GITHUB_TOKEN in env — skipping issue sync.');
    return;
  }

  const health = JSON.parse(readFileSync(healthPath, 'utf-8'));
  const alerts = Array.isArray(health.alerts) ? health.alerts : [];
  const threshold = health.threshold ?? 10;

  // Ensure the label exists (idempotent; ignore "already exists").
  gh(['label', 'create', LABEL, '--color', 'B60205',
      '--description', 'A tracked company keeps failing the board scan', '--force'],
     { allowFail: true });

  // Find an existing open issue by label.
  const listed = gh(['issue', 'list', '--label', LABEL, '--state', 'open',
                     '--json', 'number', '--jq', '.[0].number'], { allowFail: true });
  const existing = listed && listed !== '' ? listed : null;

  if (alerts.length === 0) {
    if (existing) {
      gh(['issue', 'close', existing, '--comment',
          '✅ All previously-failing companies are responding again. Auto-closing.']);
      console.log(`health-alert: cleared — closed issue #${existing}.`);
    } else {
      console.log('health-alert: no alerts, no open issue — nothing to do.');
    }
    return;
  }

  const lines = alerts.map((name) => {
    const r = health.companies?.[name] || {};
    return `- **${name}** — ${r.fails ?? threshold} straight failures since ${r.since ?? '?'}` +
           (r.lastError ? ` (last: \`${String(r.lastError).slice(0, 120)}\`)` : '');
  });
  const body = [
    `These companies have failed **${threshold}+ consecutive** board scans from the CI runner's IP,`,
    `so they have most likely **left their ATS** (or changed slug/domain). Check each one's`,
    '`careers_url` / `provider` in `studios.yml` and update or remove it.',
    '',
    ...lines,
    '',
    `<sub>Auto-managed by \`health-alert.mjs\` from \`health.json\` — this issue updates itself and closes when the companies recover. Generated ${new Date().toISOString().slice(0, 10)}.</sub>`,
  ].join('\n');

  if (existing) {
    gh(['issue', 'edit', existing, '--body', body]);
    console.log(`health-alert: updated issue #${existing} (${alerts.length} flagged).`);
  } else {
    const url = gh(['issue', 'create', '--title', TITLE, '--label', LABEL, '--body', body]);
    console.log(`health-alert: opened issue (${alerts.length} flagged) → ${url}`);
  }
}

main();
