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
      "(King, Cloud Imperium Games). The wday/cxs JSON call only works for " +
      "ungated tenants — gated ones need a real browser session. Tag the studio " +
      "recipe: {kind: browser}, not a new provider. (EA used to be here, but it " +
      "left Workday for Avature/jobs.ea.com — now covered by providers/avature.mjs.)",
    seen_on: 'King, Cloud Imperium Games',
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
  // NOTE (2026-06-17): partially RECONSIDERED — see NOT_BUILT below. The
  // 2026-06-08 "302→login" claim did NOT reproduce: Xml.aspx?c={id} returned
  // HTTP 200 text/xml on a clean first request for live game-studio company IDs.
  // Kept here only as a record of the SPA dead-ends (jobs.jobvite.com).
  {
    ats: 'jobvite (jobs.jobvite.com SPA surface)',
    reason:
      "Modern careersites (jobs.jobvite.com/{slug}) are SPAs that load jobs via an " +
      "opaque flow keyed on careersiteName + careersiteSourceTypeId — no /api/jobs, " +
      "no embedded jobs array, no schema.org JobPosting; /api/v2/jobFeed 404s. That " +
      "surface stays infeasible. The legacy app.jobvite.com XML feed is the live " +
      "path — see NOT_BUILT.",
    seen_on: 'jobs.jobvite.com careersites',
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
    ats: 'jobvite (legacy app.jobvite.com XML)',
    reason:
      "RE-CHECKED 2026-06-17. The legacy feed app.jobvite.com/CompanyJobs/Xml.aspx" +
      "?c={companyId} returned HTTP 200 text/xml (NOT a login 302 as the 2026-06-08 " +
      "note claimed) for current game-studio company IDs — companyId comes from the " +
      "apply link app.jobvite.com/CompanyJobs/Job.aspx?c={companyId}&j={jobId}. " +
      "Could NOT confirm the XML job schema in-session: app.jobvite.com sits behind " +
      "Cloudflare and starts returning 'error code: 1015' (rate-limit) after a few " +
      "rapid requests, so a real build needs ONE careful request to capture the " +
      "body, then a tolerant XML parser + polite pacing. Now ~5 game studios use it " +
      "(Amber, Playground Games, ProbablyMonsters, Capcom, …), so it's worth doing.",
    seen_on: 'Amber, Playground Games, ProbablyMonsters, Capcom',
    lead: 'https://app.jobvite.com/CompanyJobs/Xml.aspx?c={companyId}',
  },
  // personio — DONE (providers/personio.mjs). smartrecruiters/recruitee/workable/
  // jobylon/hailey/teamtailor/lever-eu — DONE. avature (jobs.ea.com) — DONE
  // (providers/avature.mjs). bamboohr — DONE (providers/bamboohr.mjs; 20 game
  // studios in studios.yml). Keep this list current as you build.
];

export default null; // explicit: importing this yields no provider.
