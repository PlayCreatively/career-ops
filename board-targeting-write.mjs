#!/usr/bin/env node
/**
 * board-targeting-write.mjs — The inverse of project-targeting.mjs: take the
 * board's in-browser filter state (the runtime "groups" shape) and write it back
 * into a portals.yml-style config's `targeting:` block.
 *
 * Used by board-dev.mjs to serve a localhost-only "Save to portals.yml" button:
 * you tweak filters in the UI, click save, and your YAML is rewritten — then the
 * watcher reprojects it and the board reseeds itself from the file. One loop.
 *
 * Only the `targeting:` block is regenerated; everything above it (the file's
 * header comments, any other top-level keys) is preserved byte-for-byte. The
 * comments *inside* the old targeting block don't survive — the block is rebuilt
 * from the saved state, which is now the source of truth for those filters.
 */
import { readFileSync, writeFileSync } from 'fs';
import yaml from 'js-yaml';

// Collapse a single-element field array back to a plain string (the schema
// accepts either; a 1-source group reads cleaner as a scalar, matching how the
// hand-written defaults look). Multi-source groups stay an array.
function normField(field) {
  if (Array.isArray(field)) return field.length === 1 ? field[0] : field.slice();
  return field;
}

/**
 * Strip the browser runtime shape back to the portals.yml group schema:
 *  - drop the synthetic `id`s,
 *  - omit empty filter names (the first keyword becomes the label),
 *  - omit `weight` when null (an inactive/greyed filter — projectTargeting and
 *    groupsFromSeed both treat a missing weight as null),
 *  - emit `else: true` (catch-all, no keywords) and `muted: true` only when set.
 * Key order mirrors the hand-written defaults so a round-tripped file reads
 * naturally (name, field, combine, weight, filters / name, keywords, weight).
 */
export function runtimeToSchema(groups) {
  return (Array.isArray(groups) ? groups : []).map((g) => {
    const out = {
      name: typeof g.name === 'string' ? g.name : 'Group',
      field: normField(g.field),
      combine: g.combine || 'min',
      weight: typeof g.weight === 'number' ? g.weight : 0.1,
    };
    out.filters = (Array.isArray(g.filters) ? g.filters : []).map((f) => {
      const ff = {};
      if (f.name) ff.name = f.name;
      if (f.else) ff.else = true;
      else ff.keywords = (Array.isArray(f.keywords) ? f.keywords : []).slice();
      if (f.weight != null) ff.weight = f.weight;
      if (f.muted) ff.muted = true;
      return ff;
    });
    return out;
  });
}

/**
 * Render the `targeting:` block YAML for a set of runtime groups. Block style for
 * the groups/filters tree, flow style for the leaf keyword arrays (flowLevel 6),
 * so it matches the look of the hand-written config. js-yaml handles all scalar
 * quoting — regexes (`/…/`) and special chars (`&`, `,`, `\b`) come out safe.
 */
export function dumpTargeting(groups) {
  return yaml.dump(
    { targeting: { groups: runtimeToSchema(groups) } },
    { lineWidth: -1, flowLevel: 6, quotingType: "'", forceQuotes: false },
  );
}

/**
 * Rewrite the `targeting:` block of a YAML file in place, preserving everything
 * outside it. Returns the schema that was written. Throws on unreadable source.
 */
export function writeTargetingBlock(srcPath, groups) {
  const raw = readFileSync(srcPath, 'utf-8');
  const block = dumpTargeting(groups).replace(/\n$/, '');
  const lines = raw.split('\n');
  const start = lines.findIndex((l) => /^targeting:\s*(#.*)?$/.test(l));

  let next;
  if (start === -1) {
    // No existing targeting block — append it after a blank line.
    next = raw.replace(/\s*$/, '') + '\n\n' + block + '\n';
  } else {
    // Replace from `targeting:` to just before the next top-level key (a line
    // starting with a non-space, non-comment char) or EOF. Comments and indented
    // lines belong to the block; a bare top-level key ends it.
    let end = lines.length;
    for (let i = start + 1; i < lines.length; i++) {
      if (/^[^\s#]/.test(lines[i])) { end = i; break; }
    }
    next = [...lines.slice(0, start), ...block.split('\n'), ...lines.slice(end)].join('\n');
  }
  writeFileSync(srcPath, next);
  return runtimeToSchema(groups);
}
