// @ts-check
/** @typedef {import('../_types.js').Enricher} Enricher */

// Experience enricher — pulls the HEADLINE years-of-experience requirement out of
// a posting's description and stores it as a small display chip:
//
//   experience: { years: 5, label: '5+ yrs', industry: true,
//                 context: '5+ years of professional Unreal development',
//                 skills: ['unreal'] }
//
// It is a TAG, not a filter: the board shows `label` on the card (with `context`
// as a hover tooltip) and never scores or hides a job by it. Only the number and
// the one capped sentence reach jobs.json — never the whole JD, so the board stays
// a light payload the same way the skills tags keep it light.
//
// "industry" is captured on purpose: "5+ years of experience" and "5+ years of
// INDUSTRY experience" are different bars, and the qualifier almost always sits in
// the same clause as the number, so it's cheap to read. `industry: true` is set
// only when that clause matches one of the qualifier signals, which live in
// skills.yml (`experience.industry_signals`) so the list is tunable without code.
//
// The context sentence is run back through the skills vocabulary (skills.mjs) so
// the chip can say what the years are FOR ("5+ yrs · unreal") using machinery we
// already run — as close to semantic attribution as a zero-token scan gets. True
// LLM understanding is deliberately out: the scanner never spends tokens per job.
//
// The headline is the LOWEST required threshold stated — the floor a candidate must
// actually clear, not the biggest number in the ad. Mentions under a "preferred" /
// "nice-to-have" heading (or trailing "…is a plus") are skipped entirely, so an
// aspirational "8+ years preferred" never masquerades as the requirement.
//
// PRECISION ON BARE "N years": a "5+ years" / "3–5 years" / "5 years or more" form is
// almost always a requirement. A BARE "N years" (no +, no range) very often is NOT —
// it's the STUDIO's age ("20 years of history", "for over 25 years"), a benefit or
// tenure milestone ("7 years of employment", "at 5 years of service"), a contract or
// programme length ("1 year FTC", "3 year degree"), or an age gate ("18 years of
// age"). So a bare mention is only kept when it carries a real experience anchor —
// the word "experience"/"expertise", or a requirement qualifier ("at least N years
// in/as/of <role>") — and is dropped on any longevity / duration / age signal. This
// is a whitelist by design: a NEW way to phrase "our studio is N years old" simply
// won't match, so the safe failure is a missing chip, never a misleading one.
//
// No JD (Lever, Ashby) → `needs: 'text'` skips this entirely → no chip, never a
// false "0 years". A description that states no requirement → null, same result.

import { readFileSync, existsSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import yaml from 'js-yaml';

import { keyToRegExp } from '../../rank.mjs';
import { detectSkills } from './skills.mjs';

const CONTEXT_CAP = 160; // hard cap on the tooltip sentence; longer → windowed

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SKILLS_PATH = process.env.CAREER_OPS_SKILLS || path.join(ROOT, 'skills.yml');

// Number words we accept spelled out ("at least five years"). Digits handled too.
const WORDS = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6,
  seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12,
};

// A years-of-experience phrase: an optional qualifier ("at least", "minimum of"…),
// a number (digits or word), an optional "+"/range, then "years"/"yrs". The lower
// number is the threshold a candidate must clear ("3-5 years" → 3, "5+ years" → 5).
// Group 1 captures the qualifier (a "required floor" signal used to trust bare years);
// group 2 the number; groups 3/5 the "+"; group 4 the range upper bound.
const YEARS_RE = new RegExp(
  '\\b(at least\\s+|minimum\\s+(?:of\\s+)?|min\\.?\\s+|over\\s+|more than\\s+|around\\s+|approx\\.?\\s+)?' +
    '(\\d{1,2}|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)' +
    '\\s*(\\+|plus)?\\s*(?:(?:-|–|—|to)\\s*(\\d{1,2}))?\\s*(\\+)?\\s*(?:years?|yrs?)\\b',
  'gi',
);

// A bare "N years" mention whose immediately following words name a non-experience
// noun — age gate, tenure/benefit, contract or programme length, company history —
// is never an experience requirement. Tested against the text right after the match.
const NON_REQ_AFTER =
  /^\W*(?:of\s+)?(?:age|service|employment|history|creation|tenure|seniority)\b|^\W*(?:year\s+)?(?:apprenticeship|traineeship|internship|sabbatical|contract|degree|programme|program|duration|rotation)\b/i;

// Company-longevity / duration narrative around a bare mention: "for over N years",
// "N years of history/now", "we've been…", "average tenure…", a franchise's age. The
// number describes the studio or the role's length, not the candidate's background.
const LONGEVITY_RE =
  /\b(?:for (?:over|more than|nearly|almost)\s+\S+\s+years?\b|years?\s+(?:of\s+history|now\b)|we[''`’]?ve\b|we have\b|has been\b|have been\b|had been\b|been (?:around|in the business)\b|spent\b|founded\b|established\b|operating\b|entertaining\b|average tenure\b|our (?:mission|journey|story|games|history)\b|franchise\b|flagship\b|welcomed\b|pioneer|generations of players\b|celebrat|anniversary)/i;

// Signals that the years are qualified as real-world work, not hobby/study time.
// Loaded from skills.yml (`experience.industry_signals`) so the list is tunable
// without editing code, exactly like the skills vocabulary. The defaults below are
// used verbatim when the file or key is missing, so the enricher never goes dumb.
const DEFAULT_INDUSTRY_SIGNALS = [
  'industry', 'professional', 'commercial', '/games? industry/',
  '/game dev(elopment)?/', 'shipped', 'AAA', 'studio', 'production',
];

/**
 * Compile the industry-signal keywords into regexes using the shared filter engine
 * (bare word = word-start, /slashes/ = regex). Reads skills.yml once; falls back to
 * the built-in defaults when the file, the `experience:` block, or a usable list is
 * absent. Exported for tests.
 *
 * @param {string} [file]
 * @returns {RegExp[]}
 */
export function loadIndustrySignals(file = SKILLS_PATH) {
  let list = DEFAULT_INDUSTRY_SIGNALS;
  if (existsSync(file)) {
    try {
      const doc = yaml.load(readFileSync(file, 'utf8'));
      const cfg = doc && typeof doc === 'object' ? doc.experience : null;
      const sig = cfg && typeof cfg === 'object' ? cfg.industry_signals : null;
      if (Array.isArray(sig) && sig.length) list = sig;
    } catch {
      // Malformed YAML → keep defaults rather than dropping the qualifier entirely.
    }
  }
  return list.map(keyToRegExp).filter(Boolean);
}

// Compiled once per process. `isIndustry` tests a clause against any signal.
const INDUSTRY_SIGNALS = loadIndustrySignals();

/**
 * @param {string} context
 * @param {RegExp[]} [signals]
 * @returns {boolean}
 */
export function isIndustry(context, signals = INDUSTRY_SIGNALS) {
  return signals.some((re) => {
    if (re.global) re.lastIndex = 0;
    return re.test(context);
  });
}

// Section cues. A years mention that sits under a "preferred / nice-to-have" heading
// (or trails one inline: "…is a plus") is NOT a requirement, so it never becomes the
// headline. A "required / must-have" cue nearer the mention overrides an earlier
// optional one (sections reset). These are heading-style phrases, not soft inline
// qualifiers — "ideally 5+ years" is still a real stated bar and is kept.
const OPTIONAL_RE = /\b(?:preferred|nice[- ]to[- ]haves?|bonus|desirable|desired|a (?:big )?plus|plus(?:s)?es|good to have|would be (?:a plus|nice)|advantageous|not required|optional(?:ly)?)\b/i;
const REQUIRED_RE = /\b(?:required|requirements?|must[- ]have|minimum|essential|what you(?:'ll| will)? bring|what we(?:'re| are)? looking|responsibilities|you (?:will |'ll )?need|key skills|about you)\b/i;

// Index of the LAST match of `re` in `str`, or -1 — used to find the nearest
// preceding section heading before a mention.
function lastMatchIndex(str, re) {
  const g = new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g');
  let idx = -1;
  let mm;
  while ((mm = g.exec(str)) !== null) {
    idx = mm.index;
    if (mm.index === g.lastIndex) g.lastIndex++;
  }
  return idx;
}

// True when the mention at `i` belongs to a preferred / nice-to-have section: either
// its own clause carries an optional cue (heading merged in, or a trailing "…a plus"),
// or the nearest preceding heading is optional rather than required.
function inOptionalSection(text, i, context) {
  if (OPTIONAL_RE.test(context)) return true;
  const before = text.slice(0, i);
  const opt = lastMatchIndex(before, OPTIONAL_RE);
  const req = lastMatchIndex(before, REQUIRED_RE);
  return opt >= 0 && opt > req;
}

// Drop the obvious non-requirement uses of "N years": "over the past 5 years",
// "5 years ago", "5 year contract/plan". (Hyphenated forms like "5-year-old" fail
// the regex on their own — the '-' is not followed by a digit.)
function isFalsePositive(text, m) {
  const before = text.slice(Math.max(0, m.index - 12), m.index);
  const after = text.slice(m.index + m[0].length);
  if (/\b(?:past|last|next|this|every|each|per)\s*$/i.test(before)) return true;
  if (/^\s*(?:ago|old|['’]s\b)/i.test(after)) return true;
  if (/^\s*(?:contract|plan|roadmap|warranty|lease|deal|anniversary)/i.test(after)) return true;
  return false;
}

function toNum(tok) {
  const w = WORDS[tok.toLowerCase()];
  return w != null ? w : parseInt(tok, 10);
}

// Expand [start,end) out to the nearest sentence / line / bullet boundary, collapse
// whitespace, and window+ellipsize if the clause runs longer than CONTEXT_CAP.
export function boundedContext(text, start, end) {
  let lo = start;
  let hi = end;
  while (lo > 0 && !/[.!?\n\r•·;]/.test(text[lo - 1])) lo--;
  while (hi < text.length && !/[.!?\n\r•·;]/.test(text[hi])) hi++;
  if (hi < text.length && /[.!?]/.test(text[hi])) hi++; // keep the terminator
  let raw = text.slice(lo, hi);
  let clipped = false;
  if (raw.length > CONTEXT_CAP) {
    // Window the raw slice, centered on the match, before collapsing whitespace.
    const mid = Math.floor((start - lo + (end - lo)) / 2);
    let a = Math.max(0, mid - Math.floor(CONTEXT_CAP / 2));
    const b = Math.min(raw.length, a + CONTEXT_CAP);
    a = Math.max(0, b - CONTEXT_CAP);
    raw = (a > 0 ? '…' : '') + raw.slice(a, b) + (b < raw.length ? '…' : '');
    clipped = true;
  }
  let s = raw.replace(/\s+/g, ' ').trim();
  if (!clipped) s = s.replace(/^[\s•·\-–—*,:;.]+/, '').trim();
  return s;
}

/**
 * The single headline experience requirement stated in the text, or null. Exported
 * for tests; pass a skills detector to test the co-occurring tags in isolation.
 *
 * @param {unknown} text
 * @param {(t: string) => string[]} [skillsFn]
 * @param {RegExp[]} [industrySignals]
 * @returns {{years:number,label:string,industry:boolean,context:string,skills:string[]}|null}
 */
export function detectExperience(text, skillsFn = detectSkills, industrySignals = INDUSTRY_SIGNALS) {
  if (typeof text !== 'string' || !text.trim()) return null;
  YEARS_RE.lastIndex = 0;
  let best = null;
  let m;
  while ((m = YEARS_RE.exec(text)) !== null) {
    if (isFalsePositive(text, m)) continue;
    const qualifier = m[1]; // "at least" / "minimum" / "over"… — a required-floor signal
    const years = toNum(m[2]);
    if (!Number.isFinite(years) || years < 1 || years > 25) continue;
    const end = m.index + m[0].length;
    const after = text.slice(end, end + 48);
    // Age / tenure / contract / company-history nouns → not an experience requirement,
    // regardless of the "+" form (kills "18+ years of age", "for over 25 years").
    if (NON_REQ_AFTER.test(after)) continue;
    const context = boundedContext(text, m.index, end);
    if (inOptionalSection(text, m.index, context)) continue; // preferred / nice-to-have → not a bar
    const upper = m[4] ? toNum(m[4]) : null; // range upper bound, if any
    // "+" before "years", or a trailing "years+" / "years or more" → a real floor.
    const trailingPlus = /^\W*(?:\+|or\s+(?:more|above|greater|over|up)|and\s+(?:above|up|over))\b/i.test(after);
    const plus = Boolean(m[3] || m[5] || trailingPlus);
    const strong = plus || (upper && upper > years);
    // A BARE "N years" is trusted only with a real experience anchor; on any longevity
    // or duration narrative it's the studio's/role's clock, not the candidate's — drop.
    if (!strong) {
      if (LONGEVITY_RE.test(text.slice(Math.max(0, m.index - 48), m.index) + m[0] + after)) continue;
      const hasExpWord = /\b(?:experience|expertise|track record)\b/i.test(context);
      const looksRequirement = Boolean(qualifier) && !/^\W*(?:to|for|ago|old|now)\b/i.test(after);
      if (!hasExpWord && !looksRequirement) continue;
    }
    const industry = isIndustry(context, industrySignals);
    const label = upper && upper > years
      ? `${years}–${upper} yrs`
      : plus
        ? `${years}+ yrs`
        : years === 1 ? '1 yr' : `${years} yrs`;
    // Headline = LOWEST required threshold (the true floor a candidate must clear).
    // On a tie, prefer the industry-qualified mention.
    if (!best || years < best.years || (years === best.years && industry && !best.industry)) {
      best = { years, label, industry, context, skills: skillsFn(context) };
    }
  }
  return best;
}

/** @type {Enricher} */
export default {
  id: 'experience',
  needs: 'text', // no description → no chip; the abstain question doesn't apply (display-only)
  enrich(detail) {
    const exp = detectExperience(detail && detail.text);
    if (!exp) return null;
    const out = { years: exp.years, label: exp.label, context: exp.context };
    if (exp.industry) out.industry = true; // omitted when false — keeps jobs.json lean
    if (exp.skills.length) out.skills = exp.skills;
    return { experience: out };
  },
};
