#!/usr/bin/env node
/**
 * board-dev.mjs — Live local board: edit your YAML, the board updates.
 *
 *   node board-dev.mjs                 # serve site/ on :5173, watch portals.yml
 *   node board-dev.mjs portals.personal.yml
 *   PORT=8080 node board-dev.mjs
 *
 * What it does:
 *   1. Serves site/ as a static server (so the board can fetch its JSON).
 *   2. Watches the source YAML and re-projects it to a gitignored personal
 *      override, site/data/targeting.local.json, on every save (no network scan).
 *   3. The board, when loaded from localhost, polls that override and reseeds
 *      itself when it changes — so saving the YAML updates the page with no
 *      refresh and no "Clear all". The committed neutral targeting.json (the
 *      public default) is never touched, so your personal filters stay local.
 *
 * Job data (site/data/jobs.json) is whatever the last scan produced; this only
 * re-filters jobs already on disk. Stop with Ctrl-C.
 */
import http from 'http';
import { readFile } from 'fs/promises';
import { watch } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { projectTargeting } from './project-targeting.mjs';
import { writeTargetingBlock } from './board-targeting-write.mjs';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const SITE = path.join(ROOT, 'site');
const SRC = process.argv[2] || 'portals.yml';
const OUT = path.join(SITE, 'data', 'targeting.local.json');
const PORT = Number(process.env.PORT) || 5173;

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
};

// ── Read a request body, capped so a stray client can't OOM us ──────
function readBody(req, limit = 2 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let data = '', over = false;
    req.on('data', (c) => {
      if (over) return;
      data += c;
      if (data.length > limit) { over = true; reject(new Error('payload too large')); }
    });
    req.on('end', () => { if (!over) resolve(data); });
    req.on('error', reject);
  });
}

// ── Save handler: board POSTs its live filter state here, we write it back into
// the watched YAML's `targeting:` block. The watcher below then reprojects it
// and the board reseeds from the file — closing the edit→disk→board loop. Only
// reachable from localhost (this server only ever binds there), matching the
// board's own LIVE gate for the button. ────────────────────────────
async function handleSaveTargeting(req, res) {
  try {
    const body = await readBody(req);
    const payload = JSON.parse(body || '{}');
    const groups = payload && payload.groups;
    if (!Array.isArray(groups)) throw new Error('expected { groups: [...] }');
    const schema = writeTargetingBlock(SRC, groups);
    const pills = schema.reduce((n, g) => n + (g.filters?.length || 0), 0);
    console.log(`  💾 saved ${schema.length} groups, ${pills} filters → ${SRC}`);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, file: path.basename(SRC), groups: schema.length, pills }));
  } catch (err) {
    console.error(`  ✗ save failed: ${err.message}`);
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: false, error: err.message }));
  }
}

// ── Static server (site/ only; no directory traversal) ──────────────
const server = http.createServer(async (req, res) => {
  try {
    const url = decodeURIComponent((req.url || '/').split('?')[0]);
    if (req.method === 'POST' && url === '/save-targeting') { await handleSaveTargeting(req, res); return; }
    const rel = url === '/' ? 'index.html' : url.replace(/^\/+/, '');
    const full = path.join(SITE, rel);
    if (!full.startsWith(SITE)) { res.writeHead(403).end('forbidden'); return; }
    const body = await readFile(full);
    res.writeHead(200, {
      'Content-Type': TYPES[path.extname(full)] || 'application/octet-stream',
      'Cache-Control': 'no-store',   // always serve the freshly projected JSON
    });
    res.end(body);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain' }).end('not found');
  }
});

// ── Project once, then re-project on every save (debounced) ─────────
function project(label) {
  try {
    const { groups, pills } = projectTargeting(SRC, OUT);
    console.log(`  ↻ ${label}: ${groups.length} groups, ${pills} filters → ${path.relative(ROOT, OUT)}`);
  } catch (err) {
    console.error(`  ✗ ${err.message}`);
  }
}

let timer = null;
function scheduleProject() {
  clearTimeout(timer);
  timer = setTimeout(() => project('reprojected on save'), 120);
}

server.listen(PORT, () => {
  console.log(`\n🎮 Board dev server\n  Serving  site/   → http://localhost:${PORT}`);
  console.log(`  Watching ${SRC} → ${path.relative(ROOT, OUT)}`);
  console.log(`  Edit ${SRC} and save — the board reloads its filters live (no refresh).\n`);
  project('initial projection');
  try {
    watch(SRC, scheduleProject);
  } catch (err) {
    console.error(`  ⚠️  Could not watch ${SRC} (${err.message}) — re-run after creating it.`);
  }
});
