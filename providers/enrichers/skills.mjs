// @ts-check
/** @typedef {import('../_types.js').Enricher} Enricher */

// Skills enricher — turns a posting's description prose into a short list of
// tags (`skills: ['unity', 'c++', 'gameplay']`) using the vocabulary in
// skills.yml. The JD text is read once at scan time and thrown away; only the
// tags reach site/data/jobs.json, which is what keeps the board a ~6 MB payload
// instead of a ~100 MB one. The board then treats `skills` as one more filter
// group source, alongside title / company / location (see rank.mjs fieldText).
//
// ABSENT ≠ EMPTY, and the distinction is the whole safety story:
//   - `skills: ['unity']`  → we read the JD and it matched these tags.
//   - `skills: []`         → we read the JD and it matched nothing. A group's
//                            catch-all (`else`) filter may legitimately fire.
//   - no `skills` key      → we never had the description. Lever and Ashby
//                            expose none, so ~39 wired studios land here. A
//                            skills group ABSTAINS on these jobs: it scores
//                            them neutral and its hard excludes (weight 0)
//                            cannot fire. A posting is never hidden for data
//                            we failed to fetch.
//
// Missing or empty skills.yml makes this enricher inert (every job unknown →
// every skills group abstains), which fails safe in the same direction.

import { readFileSync, existsSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import yaml from 'js-yaml';

import { keyToRegExp } from '../../rank.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SKILLS_PATH = process.env.CAREER_OPS_SKILLS || path.join(ROOT, 'skills.yml');

/**
 * Compile skills.yml into [tag, RegExp[]] pairs. Keywords use the same engine as
 * every other filter in the system (keyToRegExp): bare keywords are word-stems,
 * /slashes/ are regexes. A tag whose keywords all fail to compile is dropped.
 *
 * @param {string} file
 * @returns {Array<[string, RegExp[]]>}
 */
export function loadVocabulary(file = SKILLS_PATH) {
  if (!existsSync(file)) return [];
  let doc;
  try {
    doc = yaml.load(readFileSync(file, 'utf8'));
  } catch (err) {
    console.error(`⚠️  skills.yml: not parsed — ${err.message}. Skills tagging is off this scan.`);
    return [];
  }
  const table = doc && typeof doc === 'object' ? doc.skills : null;
  if (!table || typeof table !== 'object') return [];

  const vocab = [];
  for (const [tag, keys] of Object.entries(table)) {
    if (!Array.isArray(keys)) continue;
    const res = keys.map(keyToRegExp).filter(Boolean);
    if (res.length) vocab.push([String(tag), res]);
  }
  return vocab;
}

// Compiled once per process — the regexes are reused across every posting.
const VOCAB = loadVocabulary();

/**
 * Tags from the vocabulary that this description text matches. Exported for
 * tests; pass an explicit vocabulary to test without touching skills.yml.
 *
 * @param {unknown} text
 * @param {Array<[string, RegExp[]]>} [vocab]
 * @returns {string[]}
 */
export function detectSkills(text, vocab = VOCAB) {
  if (typeof text !== 'string' || !text.trim()) return [];
  const t = text.replace(/\s+/g, ' ');
  const tags = [];
  for (const [tag, res] of vocab) {
    for (const re of res) {
      if (re.global) re.lastIndex = 0;
      if (re.test(t)) { tags.push(tag); break; }
    }
  }
  return tags;
}

/** @type {Enricher} */
export default {
  id: 'skills',
  // No `needs: 'text'` — this enricher must run on every detail payload so it can
  // tell "read the JD, matched nothing" (skills: []) apart from "no JD" (no key).
  enrich(detail) {
    if (!VOCAB.length) return null;
    const text = detail && detail.text;
    if (typeof text !== 'string' || !text.trim()) return null; // unknown → abstain
    return { skills: detectSkills(text) };
  },
};
