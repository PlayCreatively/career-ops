// Type catalog for the provider plugin contract.
//
// This file is documentation-only — pure JSDoc @typedef annotations. The
// project is plain ESM JavaScript with no build step; provider authors can
// reference these types via `/** @typedef {import('./_types.js').Provider} Provider */`
// at the top of a `// @ts-check`-enabled file to get IDE hints. The runtime
// contract is enforced by scan.mjs (id presence, fetch is a function, fetch
// returns an array), not by these annotations.
//
// Files prefixed with _ are never loaded as providers by scan.mjs.

/**
 * Normalized job posting — the unit of currency throughout the scanner.
 *
 * @typedef {object} Job
 * @property {string} title    Required, non-empty after trim.
 * @property {string} url      Required, absolute URL — used as the dedup key.
 * @property {string} company  May be empty when the source can't expose it
 *                             at the list-page level; populated downstream.
 * @property {string} location May be empty.
 * @property {string}  [postedDate] Optional ISO-8601 posting date, when the
 *                                  source exposes one at the list level.
 *                                  Normalise via providers/_util.mjs `toIsoDate`.
 * @property {('remote'|'hybrid'|'onsite'|'anywhere')} [workMode] Optional work
 *                                  arrangement. Set from a structured field
 *                                  (ashby/lever `workplaceType`, recruitee
 *                                  remote/hybrid/on_site, smartrecruiters
 *                                  location.remote) or derived from the location
 *                                  text. 'anywhere' is geography-free remote
 *                                  ("Anywhere"/"Distributed"). Omitted when
 *                                  unknown. Normalise via providers/_util.mjs
 *                                  `normalizeWorkMode`.
 * @property {string}  [department]  Optional department/team label.
 * @property {string}  [experienceLevel] Optional seniority/experience label, in
 *                                  the source's own taxonomy (e.g. games-jobs-direct's
 *                                  "Junior-Associate" / "Mid-Senior Level" / "Director").
 *                                  Set only when the source exposes an explicit field;
 *                                  omitted otherwise (do NOT infer it from the title).
 * @property {('none'|'offered')} [sponsorship] Optional visa-sponsorship signal, set
 *                                  by the detail-phase `sponsorship` enricher from the
 *                                  posting's description prose. 'none' = the posting
 *                                  states it will NOT sponsor / requires existing right
 *                                  to work; 'offered' = it explicitly offers sponsorship.
 *                                  Omitted when the description doesn't mention it — a
 *                                  missing field NEVER means "will sponsor" (see
 *                                  providers/enrichers/sponsorship.mjs).
 */

/**
 * A single `tracked_companies` entry from `portals.yml`.
 *
 * Provider-specific fields are opaque to scan.mjs and validated by the
 * provider itself. Examples in current providers: `api`, `careers_url`.
 * Providers read these directly off the entry object — no schema enforcement
 * at the framework level.
 *
 * @typedef {object} PortalEntry
 * @property {string}             name             User-facing label; appears in logs and placeholders.
 * @property {boolean}            [enabled]        Default: true.
 * @property {string}             [careers_url]    Public listing URL; consumed by detect().
 * @property {string}             [provider]       Explicit provider id — bypasses detect().
 * @property {('http')}           [transport]      Default: 'http'. Reserved for future transports.
 */

/**
 * Returned by `detect()` when a provider claims an entry. `url` is
 * informational (used in logs); routing only checks for a non-null return.
 *
 * @typedef {object} DetectHit
 * @property {string} url
 */

/**
 * Options forwarded to the underlying `fetch` call.
 *
 * @typedef {object} FetchOptions
 * @property {number}                [timeoutMs]
 * @property {Object<string,string>} [headers]
 * @property {string}                [method]
 * @property {(string|null)}         [body]
 */

/**
 * What scan.mjs hands to provider.fetch(). For Phase A only `transport: 'http'`
 * is implemented; the shape reserves room for future transports without
 * breaking the contract.
 *
 * @typedef {object} Context
 * @property {('http')} transport
 * @property {(url: string, opts?: FetchOptions) => Promise<string>}  fetchText
 * @property {(url: string, opts?: FetchOptions) => Promise<unknown>} fetchJson
 */

/**
 * Normalized per-job detail — the enrich phase gets one per job from EITHER of
 * two sources:
 *   - FREE tier (no extra request): the provider's fetch() already had the
 *     description in the list response and hung this off the job as
 *     `job[DETAIL] = { text }` (see providers/_util.mjs DETAIL). Always processed.
 *   - PAID tier: returned by `provider.fetchDetail(job, ctx)`, a real per-job
 *     request, run only when the `--extra-fetch` flag is on (the default).
 * Two roles:
 *   - cross-cutting enrichers read named fields off it (currently `text` — the
 *     posting's plain-text description body — which the `sponsorship` enricher
 *     scans). Add fields here as new enrichers need them.
 *   - `overlay` carries provider-authoritative CORE fields to merge back onto the
 *     job (e.g. the aggregator boards fill company/location/title from each
 *     posting's JSON-LD, which the list page couldn't expose). Only non-empty
 *     values overwrite; absent keys leave the list value intact.
 *
 * A detail fetch may also POSITIVELY drop its job: return `{ drop: true }` when
 * the fetched page proves the posting is dead (e.g. an aggregator that lingers
 * expired listings in its sitemap — the page carries an expiry banner). This is
 * distinct from a detail MISS (null / thrown / network error), which keeps the
 * job with its Phase-1 fields. Only an explicit `drop: true` omits the posting.
 *
 * @typedef {object} DetailPayload
 * @property {string}         [text]     Plain-text description body for enrichers.
 * @property {Partial<Job>}   [overlay]  Core job fields to overwrite (non-empty only).
 * @property {boolean}        [drop]     True = posting proven dead; omit it from the snapshot.
 */

/**
 * A detail-phase enricher — a small module in providers/enrichers/*.mjs that
 * derives an optional Job field from the fetched detail, decoupled from any ATS.
 * Registered by dropping the file in; scan.mjs loads them like providers. Adding
 * a new signal (salary-from-prose, relocation, …) is one file, no fetch edits.
 *
 * @typedef {object} Enricher
 * @property {string} id                                          Unique label (used in logs).
 * @property {string} [needs]                                     DetailPayload key it reads (e.g. 'text').
 *                                                                When set and that key is empty on the
 *                                                                detail, the enricher is skipped for that job.
 * @property {(detail: DetailPayload, job: Job) => (Partial<Job>|null|undefined)} enrich  Pure; returns fields to merge.
 */

/**
 * The provider contract — the default export of every providers/*.mjs file
 * (excluding _-prefixed shared helpers).
 *
 * @typedef {object} Provider
 * @property {string} id                                                       Unique across all loaded providers.
 * @property {((entry: PortalEntry) => (DetectHit | null))} [detect]           Optional auto-detection.
 * @property {(entry: PortalEntry, ctx: Context) => Promise<Job[]>} fetch      Required. Phase 1: the "basics"
 *                                                                             list. A throttle here loses the job
 *                                                                             (as before); the detail pass never can.
 * @property {(job: Job, ctx: Context) => Promise<(DetailPayload|null)>} [fetchDetail]  Optional PAID Phase 2: a real
 *                                                                             per-job request for one posting's detail,
 *                                                                             run only when `--extra-fetch` is on (the
 *                                                                             default; disable with `--no-extra-fetch`).
 *                                                                             Per-job failures are isolated (the job
 *                                                                             keeps its Phase-1 fields, only the detail
 *                                                                             is lost), so a throttling ATS degrades to
 *                                                                             less data, never fewer postings. Providers
 *                                                                             whose LIST response already carries the
 *                                                                             description skip this and attach the detail
 *                                                                             inline via `job[DETAIL]` (free tier) —
 *                                                                             processed on every scan regardless of the
 *                                                                             flag, since it costs no request.
 * @property {number} [detailConcurrency]                                      Parallel PAID detail fetches within one
 *                                                                             entry (default 4). A per-entry
 *                                                                             `enrich_concurrency` overrides it; drop
 *                                                                             it low for throttle-prone ATSes.
 * @property {(jobs: Job[], entry: PortalEntry) => Job[]} [postFetch]          Optional provider-specific pass run
 *                                                                             AFTER the detail phase (e.g. gamedevjobs
 *                                                                             merges a role split across offices, now
 *                                                                             that companies are known).
 * @property {string[]} [aggregatorHosts]                                      Set ONLY by multi-studio BOARD providers
 *                                                                             that serve their own URLs (hitmarker,
 *                                                                             gamejobs.co, …). Every host here MUST be in
 *                                                                             scan.mjs DEFAULT_AGGREGATORS so snapshot dedup
 *                                                                             collapses the board's mirrors of first-party
 *                                                                             postings; test-all.mjs section 28 enforces it.
 *                                                                             Direct single-company ATS providers OMIT this
 *                                                                             (Pass-1 posting-ID dedup covers them), as does
 *                                                                             rehm (it emits each studio's real source_url).
 * @property {boolean} [lastResort]                                            When true, aggregatorHosts must ALSO be in
 *                                                                             scan.mjs DEFAULT_LAST_RESORT — the board hides
 *                                                                             the source link, so any other source wins over
 *                                                                             its mirror.
 */

/**
 * Result of probing one candidate URL — a hit (count + sample location) or null
 * for a miss. `count` may be 0 (a real-but-empty board still proves the ATS).
 *
 * @typedef {object} ProbeHit
 * @property {number} count
 * @property {string} loc     A sample location string (shown in probe output).
 */

/**
 * One candidate endpoint to probe. `kind:'slug'` builds the URL from a slug
 * guessed off the company name; `kind:'domain'` builds it from the studio's own
 * domain host (the custom-domain sweep). `parse` receives the fetched JSON and
 * returns a ProbeHit or null. Pure data + pure functions — no I/O; the probe
 * runner (probe-studios.mjs) does the fetching.
 *
 * @typedef {object} ProbeEndpoint
 * @property {('slug'|'domain')} kind
 * @property {(key: string) => string} url            key = slug (kind:slug) or host (kind:domain)
 * @property {(key: string) => string} where          human-readable "where" label for the hit
 * @property {(data: unknown) => (ProbeHit | null)} parse
 * @property {string} [label]                         override the displayed ATS name (e.g. 'lever-eu')
 * @property {('high'|'medium'|'verify')} [confidence] override the provider's base tier for this endpoint
 */

/**
 * Optional discovery descriptor. Providers that can be FOUND by guessing a
 * slug/domain export this as a named `probe` export; probe-studios.mjs auto-loads
 * every provider that has one. Aggregators (hitmarker/work-with-indies/...) and
 * recipe/parser/complex providers simply omit it and are skipped by the probe —
 * so adding a discoverable ATS is one self-contained provider file, no probe edit.
 *
 * @typedef {object} Probe
 * @property {ProbeEndpoint[]} endpoints
 * @property {('high'|'medium'|'verify')} [confidence]  base tier for a hit (default 'medium')
 * @property {boolean} [namesakeProne]                  downgrade short/generic slug hits to 'verify'
 * @property {(name: string) => string[]} [slugs]       override slug generation (default: name-derived)
 * @property {string} [canary]                          a KNOWN-LIVE slug for this ATS, used as a NON-fatal
 *                                                      preflight before each wave. If the canary returns a
 *                                                      throttle/error (403/429/5xx/timeout) the ATS is
 *                                                      disabled for the run (cheap early exit). If it returns
 *                                                      a clean 404 / unparseable 2xx the canary is only
 *                                                      flagged STALE (the company may have left the ATS) — it
 *                                                      never disables, so a rotted canary can't kill a working
 *                                                      ATS. The real disable trigger is the live 403/429
 *                                                      signal from probe traffic; the canary just catches it
 *                                                      earlier. Omit when no stable live tenant is known.
 */

export {};
