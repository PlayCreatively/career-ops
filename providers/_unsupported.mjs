// @ts-check
//
// _unsupported.mjs — NOT A PROVIDER. Documentation only.
//
// The leading underscore means scan.mjs's loader SKIPS this file (same rule as
// _http.mjs / _types) — it is never imported as a provider, so it can't break a
// scan. It lives here, beside the real providers, so the "why don't we have a
// provider for X?" answer is one folder away from where you'd add one.
//
// Two buckets: (A) infeasible — a tokenless HTTP feed doesn't exist, don't try;
// (B) feasible but not built yet — a real candidate, here's the lead.
//
// Update this when a resolve/scan pass burns time discovering an ATS has no
// clean feed — record it so the next pass doesn't repeat the work. (Mirrors the
// per-studio `recipe: {kind: blocked, reason}` tag, but at the ATS level.)

// ── (A) Infeasible — no clean public feed; needs a browser or per-tenant work ──
export const INFEASIBLE = [
  {
    ats: 'varbi',
    reason:
      "No public JSON feed. recruit.varbi.com endpoints 404; boards are server-" +
      "rendered per-tenant HTML with no syndication. Would need bespoke HTML " +
      "parsing per customer. Skip unless a must-have studio is Varbi-only.",
    seen_on: 'various Nordic studios',
  },
  {
    ats: 'workday (bot-gated tenants)',
    reason:
      "We HAVE providers/workday.mjs, but some tenants sit behind Cloudflare/bot " +
      "protection and return HTTP 422/403 to the public cxs endpoint headless " +
      "(King, EA, Cloud Imperium Games). The wday/cxs JSON call only works for " +
      "ungated tenants — gated ones need a real browser session. Tag the studio " +
      "recipe: {kind: browser}, not a new provider.",
    seen_on: 'King, EA, Cloud Imperium Games',
  },
  {
    ats: 'custom JS-SPA careers (bot-protected)',
    reason:
      "Homemade careers pages that render the job list client-side AND block " +
      "plain fetch/WebFetch (Cloudflare JS challenge). No JSON XHR reachable " +
      "without executing JS. These are the genuine Playwright cases: resolve via " +
      "a browser pass (capture a recipe if an XHR appears once rendered), else " +
      "recipe: {kind: browser}. Not an ATS — no shared provider possible.",
    seen_on: 'Fall Damage, Ringtail Interactive (unreachable)',
  },
  {
    ats: 'jobvite',
    reason:
      "INVESTIGATED 2026-06-08, no clean keyless feed. Modern careersites " +
      "(jobs.jobvite.com/{slug}) are SPAs that load jobs via an opaque flow keyed " +
      "on careersiteName + careersiteSourceTypeId — no /api/jobs, no embedded jobs " +
      "array, no schema.org JobPosting. The legacy XML feed " +
      "(app.jobvite.com/CompanyJobs/Xml.aspx?c=ID) 302-redirects to a Recruiter " +
      "LOGIN (auth required); jobs.rss returns the HTML shell; /api/v2/jobFeed 404s. " +
      "Also: Splash Damage (the only games user we had) LEFT — its slug now " +
      "redirects to ?invalid=1. Not worth building: needs auth/reverse-engineering " +
      "AND no current target studio. Tag any Jobvite studio recipe: {kind: browser}.",
    seen_on: 'Splash Damage (departed)',
  },
  {
    ats: 'email-only / contact-form "careers"',
    reason:
      "Not an ATS at all — applications go to a jobs@ address or a name/CV web " +
      "form. No machine-readable feed exists anywhere. Always tag the studio " +
      "recipe: {kind: blocked, reason}; never spend more time here.",
    seen_on: 'Flamebait, Midjiwan, Frictional, RobTop, Iron Gate, Landfall',
  },
];

// ── (B) Feasible but NOT built yet — real candidates (highest leverage first) ──
export const NOT_BUILT = [
  {
    ats: 'bamboohr',
    reason:
      "The agent scan flow (modes/scan.md) documents BambooHR's list+detail JSON " +
      "(https://{company}.bamboohr.com/careers/list → /careers/{id}/detail), but " +
      "there's no providers/bamboohr.mjs yet — so scan.mjs can't pull it tokenless. " +
      "Straightforward to add from the documented endpoints.",
    seen_on: '(general — common ATS)',
    lead: 'https://{company}.bamboohr.com/careers/list',
  },
  // personio — DONE (providers/personio.mjs). smartrecruiters/recruitee/workable/
  // jobylon/hailey/teamtailor/lever-eu — DONE. Keep this list current as you build.
];

export default null; // explicit: importing this yields no provider.
