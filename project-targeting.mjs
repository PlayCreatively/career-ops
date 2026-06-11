#!/usr/bin/env node
/**
 * project-targeting.mjs — Project a group-schema targeting config into the JSON
 * the board reads, WITHOUT running a full network scan. Pure file→file, instant.
 *
 *   node project-targeting.mjs                       # portals.yml → site/data/targeting.local.json
 *   node project-targeting.mjs portals.personal.yml  # explicit source
 *   node project-targeting.mjs <src.yml> <out.json>  # explicit source + output
 *
 * Output defaults to site/data/targeting.LOCAL.json — a gitignored personal
 * override. The board fetches that first, then falls back to the committed,
 * NEUTRAL site/data/targeting.json. So projecting your personal filters here
 * lets you preview them locally WITHOUT leaking them to the public board (the
 * committed default is never touched). For a live "edit YAML → board updates"
 * loop, run `npm run board:dev`.
 *
 * Two source-of-truth YAMLs feed this:
 *   • portals.yml / portals.personal.yml → your PERSONAL filters (→ override)
 *   • targeting.default.yml              → the PUBLIC board default
 *       npm run board:default   # targeting.default.yml → site/data/targeting.json
 */
import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { fileURLToPath } from 'url';
import path from 'path';
import yaml from 'js-yaml';

/**
 * Read a group-schema YAML config and write { groups } JSON for the board.
 * Returns { groups, pills }. Throws if the source isn't on the group schema.
 */
export function projectTargeting(src = 'portals.yml', out = 'site/data/targeting.local.json') {
  const cfg = yaml.load(readFileSync(src, 'utf-8')) || {};
  const groups = cfg.targeting?.groups;
  if (!Array.isArray(groups)) {
    throw new Error(`${src} has no \`targeting.groups\` — it's still the legacy flat schema.`);
  }
  mkdirSync(path.dirname(out) || '.', { recursive: true });
  writeFileSync(out, JSON.stringify({ groups }));
  const pills = groups.reduce((n, g) => n + (g.filters?.length || 0), 0);
  return { groups, pills };
}

function main() {
  const src = process.argv[2] || 'portals.yml';
  const out = process.argv[3] || 'site/data/targeting.local.json';
  try {
    const { groups, pills } = projectTargeting(src, out);
    console.log(`✓ ${src} → ${out}  (${groups.length} groups, ${pills} filters)`);
    console.log(`  Refresh the board, or use \`npm run board:dev\` for a live loop.`);
  } catch (err) {
    console.error(`✗ ${err.message}`);
    console.error(`  Put a group-schema config there (see portals.personal.yml) and re-run.`);
    process.exit(1);
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main();
}
