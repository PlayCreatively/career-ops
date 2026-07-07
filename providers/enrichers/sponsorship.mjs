// @ts-check
/** @typedef {import('../_types.js').Enricher} Enricher */

// Sponsorship enricher — reads a posting's description prose and decides whether
// the employer says it will NOT sponsor a work visa ('none') or explicitly WILL
// ('offered'). No ATS exposes this as a structured field; it's always a sentence
// in the JD (verified across Greenhouse/Lever/Ashby/Rippling), e.g.:
//
//   "At this time, we are unable to provide visa sponsorship. Applicants must
//    have the right to work in the UK."
//
// This is a detail-phase enricher: it runs on the description text a provider's
// fetchDetail() returns, decoupled from any one ATS. Drop-in — scan.mjs loads
// everything in providers/enrichers/ and applies it wherever detail text exists.
//
// PRECISION over recall. A missing signal (return null) NEVER means "will
// sponsor" — it means the JD didn't say. We only fire on explicit sponsorship
// phrasing; a bare "must have the right to work in X" is common boilerplate that
// sponsoring employers also write, so it does NOT trigger 'none' on its own.
// 'none' is checked first: a false 'offered' would let a dead-end role look fine,
// whereas the board only badges (hides nothing), so a stray 'none' is cheap.

// A posting that states it will NOT sponsor / requires existing work rights.
// Ordering matters only relative to OFFERED (none wins); within the list any hit
// is enough. Tested against lowercased, whitespace-collapsed text.
const NONE = [
  /\bno\s+(?:visa\s+)?sponsorship\b/,
  /\b(?:visa\s+)?sponsorship\s+(?:is\s+|will\s+)?(?:not\s+(?:available|offered|provided|possible|considered|be\s+\w+)|unavailable)\b/,
  /\bunable\s+to\s+(?:provide|offer|support|give)\b[^.!?]{0,24}sponsor\w*/,
  /\bnot\s+able\s+to\s+(?:provide|offer|support|sponsor)\b[^.!?]{0,24}sponsor\w*/,
  /\b(?:cannot|can\s?not|can'?t|will\s+not|won'?t|do(?:es)?\s*n[o']?t|don'?t)\s+(?:currently\s+|presently\s+)?(?:provide|offer|support|give)\s+(?:visa\s+|any\s+)?sponsor\w*/,
  /\b(?:cannot|can\s?not|can'?t|will\s+not|won'?t|do(?:es)?\s*n[o']?t|don'?t)\s+sponsor\b/,
  /\bnot\s+(?:be\s+)?(?:in\s+a\s+position|able)\s+to\s+(?:provide|offer|support|sponsor)\b[^.!?]{0,24}sponsor\w*/,
  /\bnot\s+eligible\s+for\s+(?:visa\s+)?sponsor\w*/,
  /\bwithout\s+(?:the\s+need\s+for\s+(?:visa\s+)?|requiring\s+(?:visa\s+)?)?sponsor\w*/,
];

// A posting that explicitly OFFERS sponsorship. Kept tight — only affirmative
// phrasing, since any negated form ("unable to offer sponsorship") is caught by
// NONE first and returned before these ever run.
const OFFERED = [
  /\b(?:visa\s+)?sponsorship\s+(?:is\s+|may\s+be\s+|can\s+be\s+)?(?:available|offered|provided|possible)\b/,
  /\b(?:we|they|our\s+\w+|the\s+company)\s+(?:can\s+|will\s+|do\s+|are\s+(?:able|happy|pleased|willing)\s+to\s+)?(?:provide|offer|support|sponsor)\s+(?:visa\s+|work\s+visa\s+|relocation\s+and\s+(?:visa\s+)?)?sponsor\w*/,
  /\b(?:we|they)\s+(?:can|will|do)\s+sponsor\b/,
  /\bvisa\s+(?:sponsorship\s+and\s+)?(?:support|assistance)\s+(?:is\s+)?(?:available|provided|offered)\b/,
];

/**
 * Classify the visa-sponsorship stance stated in a posting's description text.
 * Returns 'none' | 'offered' | null (null = not mentioned; never assume sponsor).
 * Exported for unit tests.
 *
 * @param {unknown} text
 * @returns {('none'|'offered'|null)}
 */
export function detectSponsorship(text) {
  if (typeof text !== 'string' || !text) return null;
  const t = text.toLowerCase().replace(/\s+/g, ' ');
  if (!t.includes('sponsor')) return null; // fast bail — every pattern needs it
  for (const re of NONE) if (re.test(t)) return 'none';
  for (const re of OFFERED) if (re.test(t)) return 'offered';
  return null;
}

/** @type {Enricher} */
export default {
  id: 'sponsorship',
  needs: 'text',
  enrich(detail) {
    const s = detectSponsorship(detail && detail.text);
    return s ? { sponsorship: s } : null;
  },
};
