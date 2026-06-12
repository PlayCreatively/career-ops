#!/usr/bin/env node
/**
 * project-targeting.mjs — Project a group-schema targeting config into the JSON
 * the board reads, WITHOUT running a full network scan. Pure file→file, instant.
 *
 *   node project-targeting.mjs                       # portals.yml → site/data/targeting.local.json
 *   node project-targeting.mjs portals.personal.yml  # explicit source
 *   node project-targeting.mjs <src.yml> <out.json>  # explicit source + output
 *   node project-targeting.mjs --watch               # re-project on every save
 *
 * Use --watch (npm `board:watch`) ALONGSIDE your own static server — e.g. VS Code
 * Live Server. Live Server serves the files and reloads the browser, but it can't
 * project YAML→JSON; this watcher does that half. On localhost the board also
 * polls the output and reseeds live, so the page updates with no manual refresh.
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
import { readFileSync, writeFileSync, mkdirSync, watch } from 'fs';
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

// Project once, logging success/failure (a bad save shouldn't kill --watch).
function projectOnce(src, out, label) {
  try {
    const { groups, pills } = projectTargeting(src, out);
    console.log(`✓ ${label}: ${src} → ${out}  (${groups.length} groups, ${pills} filters)`);
    return true;
  } catch (err) {
    console.error(`✗ ${err.message}`);
    return false;
  }
}

function main() {
  const args = process.argv.slice(2);
  const isWatch = args.includes('--watch');
  const positional = args.filter((a) => !a.startsWith('--'));
  const src = positional[0] || 'portals.yml';
  const out = positional[1] || 'site/data/targeting.local.json';

  if (!isWatch) {
    if (!projectOnce(src, out, 'projected')) {
      console.error(`  Put a group-schema config there (see portals.yml) and re-run.`);
      process.exit(1);
    }
    console.log(`  Refresh the board, or use \`npm run board:dev\` / \`board:watch\` for a live loop.`);
    return;
  }

  // Watch mode: re-project on every save (debounced). Pairs with any static
  // server (VS Code Live Server, `npx serve`, …) — this only writes the JSON.
  console.log(`👁  Watching ${src} → ${out}`);
  console.log(`   Edit & save ${src}; the board reseeds live on localhost (no refresh).`);
  console.log(`   Serve site/ however you like (VS Code Live Server is fine). Ctrl-C to stop.\n`);
  projectOnce(src, out, 'initial');
  let timer = null;
  try {
    watch(src, () => {
      clearTimeout(timer);
      timer = setTimeout(() => projectOnce(src, out, 'reprojected on save'), 120);
    });
  } catch (err) {
    console.error(`✗ Could not watch ${src} (${err.message}) — does it exist?`);
    process.exit(1);
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main();
}
