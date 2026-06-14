// Per-company failure tally for departed-ATS detection.
//
// The board's daily CI scan runs from a stable IP (GitHub Actions), so a
// company that keeps failing there is far more likely to have *left its ATS*
// than to be throttling us. We keep a small persistent counter of CONSECUTIVE
// failed scans per company: any non-success increments it, any reachable fetch
// (even 0 jobs) resets it to zero. After `threshold` straight failures the
// company is flagged so the board can show an alert and CI can open an issue.
//
// State persists across runs by riding inside the deployed board artifact:
// CI fetches the previously published health.json from the live site, feeds it
// here as `prev`, and writes the result back into the snapshot dir so it
// redeploys. Local runs don't pass --health-* flags, so residential throttling
// never reaches this tally.
//
// `mergeHealth` is a PURE function (no I/O, deterministic given `now`) so the
// streak arithmetic is unit-tested directly in test-all.mjs.

/**
 * @typedef {{ fails: number, lastError?: string, kind?: string, since: string }} CompanyHealth
 * @typedef {{ generated?: string, threshold?: number,
 *             companies: Record<string, CompanyHealth>, alerts: string[] }} HealthState
 * @typedef {{ name: string, ok: boolean, error?: string, kind?: string }} Outcome
 */

/**
 * Fold this run's per-company outcomes into the previous tally.
 *
 * @param {Partial<HealthState>|null|undefined} prev  previous state (may be empty/missing)
 * @param {Outcome[]} outcomes  companies actually ATTEMPTED this run
 * @param {{ threshold?: number, now?: Date }} [opts]
 * @returns {HealthState}
 */
export function mergeHealth(prev, outcomes, opts = {}) {
  const threshold = opts.threshold ?? 10;
  const now = opts.now ?? new Date();
  const today = now.toISOString().slice(0, 10);

  const prevCompanies = (prev && prev.companies) || {};
  const attempted = new Set();
  /** @type {Record<string, CompanyHealth>} */
  const companies = {};

  // Carry forward companies NOT attempted this run, unchanged. (A run scoped to
  // one ATS, or a company temporarily dropped from studios.yml, must not reset
  // or lose another company's streak.)
  for (const [name, rec] of Object.entries(prevCompanies)) {
    companies[name] = { ...rec };
  }

  for (const o of outcomes) {
    if (!o || !o.name) continue;
    attempted.add(o.name);
    if (o.ok) {
      // Reachable → streak resets to zero, which we represent as "absent".
      delete companies[name_(o)];
      continue;
    }
    const before = prevCompanies[o.name];
    companies[o.name] = {
      fails: (before?.fails || 0) + 1,
      since: before?.since || today,         // first failure of the current streak
      ...(o.error ? { lastError: String(o.error).slice(0, 300) } : {}),
      ...(o.kind ? { kind: o.kind } : {}),
    };
  }

  const alerts = Object.entries(companies)
    .filter(([, rec]) => rec.fails >= threshold)
    .map(([name]) => name)
    .sort();

  return { generated: now.toISOString(), threshold, companies, alerts };
}

// Tiny helper so the `delete` above reads against the same key we set.
function name_(o) { return o.name; }
