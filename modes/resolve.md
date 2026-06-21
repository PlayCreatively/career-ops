# Mode: resolve — Wire up unresolved studios (backlog → scannable)

Work through the backlog of companies that `scan.mjs` can't yet scan, and turn
each into a zero-token feed: assign a shared ATS provider, capture a custom
`recipe:`, stub a `parser:` script, or tag it as a dead-end. This is the
companion to `scan` — `scan` *uses* feeds, `resolve` *creates* them.

**Goal: spend AI/browser tokens ONCE per company, then never again.** Everything
you discover gets written back to `studios.yml` so the next scan is free.

## Invocation

- `/career-ops resolve` → process the top **10** unresolved companies.
- `/career-ops resolve N` → process the top N.
- `/career-ops resolve "Studio Name"` → resolve one named company.

Run as a subagent (Playwright + many fetches) so it doesn't eat main context.

## The backlog (what counts as "unresolved")

In priority order:
1. `studios.yml` entries with `status: unresolved` (or no feed field at all).
2. `studios.yml` entries tagged `recipe: {kind: browser}` (flagged for a Playwright pass).
3. Open items in `data/ats-research.md` (the research queue) **not** yet in `studios.yml`.

Skip (do not re-spend tokens on):
- Anything `track-check.mjs` reports as `tracked` (already scannable).
- `recipe: {kind: blocked}` entries unless `--force` (they were judged hopeless;
  only revisit if `last_probe` is old or the user asks).

## Workflow (per company)

### 0. Dedup first — ALWAYS, before any browser/network use
```
node track-check.mjs "Company Name" --url theirdomain.com
```
- `tracked` → skip, it's already covered. Do not duplicate.
- `backlog` → resolve the EXISTING entry (update it in place; never add a second).
- `unknown` → new; you'll add an entry at the end.

### Tooling order — CLI first, ALWAYS fall back to web tools (MANDATORY)

Spend the cheapest tool that works, but **never let a CLI failure end the probe.**
A studio is only a confirmed dead-end after the web tools have also been tried.
For each studio, escalate in this order and stop at the first that answers:

1. **Tokenless CLI** — `node track-check.mjs` (dedup), `node probe/probe-studios.mjs
   --backlog` (ATS-guess the whole backlog in one shot; tag-aware, so it probes
   unresolved/browser entries instead of skipping them; add `--include-blocked`
   to re-probe dead-ends), `node scan.mjs --company "Name"` (validate a recipe).
   Zero tokens.
2. **`curl`** the candidate feed (e.g. `{origin}/jobs.json` for Teamtailor).
3. **Web tools (REQUIRED fallback)** — if the CLI/curl route errors, times out,
   or is unreachable (`000`, `ECONNREFUSED`, SSL/cert error, 403, sandbox block),
   **do NOT tag it blocked on that basis.** Escalate:
   - `WebSearch` "{studio} careers jobs" → find the real careers URL / ATS.
   - `WebFetch` that URL → identify the ATS, list openings, find any JSON/API.
   A CLI failure means *our environment* couldn't reach it, not that the studio
   has no feed. Only the web tools can tell those apart — so they are not optional.
4. **Playwright (when available)** — for pages that render the job list with JS,
   or that block `fetch`/`WebFetch` but load in a real browser. `browser_navigate`
   → `browser_snapshot`, then **open the Network tab and capture the request that
   returns the jobs**. This is the tool that clears the `recipe: {kind: browser}`
   queue. If the env has no Playwright MCP (e.g. headless batch), leave the entry
   `kind: browser` — that tag literally means "a Playwright pass is still owed."

**Does Playwright build the scraper?** It builds the *recipe*, not a scan-time
browser. The point of the browser pass is to find the cheapest replayable feed and
**write it down so scanning stays tokenless**, in this order:
- Spot a JSON XHR in the Network tab → capture `recipe: {kind: json}` (best — the
  scan then hits that endpoint directly, no browser needed ever again).
- No XHR, jobs in the rendered DOM → capture `recipe: {kind: html}` selectors.
- The site *only* works when driven (login, multi-step, heavy JS, no stable
  endpoint) → write a Tier-3 `parsers/{slug}.mjs` that drives Playwright itself
  and prints JSON. That's the one case where a browser runs at scan time — rare,
  heavier, more fragile, so it's the last resort, not the default.
So: Playwright is a *discovery* tool that converts an expensive render into a
cheap recipe. scan.mjs stays pure-HTTP for everything except the rare Tier-3 parser.

### 1. Identify the careers source (cheapest signal first)
Using the tooling order above, inspect the studio's `/careers` (or `/jobs`) page
(Playwright when available, else `WebFetch`). In the **Network tab / page source**,
look for, in this order:

1. **A known ATS host** → Tier 1. Just set `provider:` + `careers_url:` and stop.
   `boards.greenhouse.io`, `jobs.lever.co` / `jobs.eu.lever.co`, `jobs.ashbyhq.com`,
   `*.teamtailor.com` (or custom TT domain), `*.recruitee.com`, `smartrecruiters.com`,
   `apply.workable.com`, `*.bamboohr.com`, `*.myworkdayjobs.com`, `*.careers.haileyhr.app`,
   `cdn.jobylon.com`. (See `data/ats-research.md` for host→provider mapping.)
2. **An XHR returning JSON** (the homemade-but-clean case) → Tier 2 `recipe: kind: json`.
   Note the endpoint URL, the path to the jobs array, and the field names for
   title/url/location. This is the BEST outcome for a custom site — robust + zero-dep.
3. **Server-rendered HTML list** (no JSON, jobs in the initial HTML) → Tier 2
   `recipe: kind: html`. Note the repeating container selector and per-field
   sub-selectors (`a@href` for the link).
4. **Too complex for a recipe** (pagination, token handshake, multi-step, messy
   nested markup) → Tier 3 `parser:`. Write a small `parsers/{slug}.mjs` that
   prints `[{title,url,location}]` JSON to stdout, and point the entry at it.
5. **Bot-stopped / JS-gated / email-only / no machine feed** → Tier 4 tag.
   **The `reason:` is MANDATORY and must state the SPECIFIC evidence you saw** —
   not a vague "no feed". It's the audit trail that justifies never re-spending
   tokens here, and the signal for whether to revisit later. Good reasons:
   - `email-only (jobs@studio.com); no ATS`
   - `2-person studio; landing page only, no careers section`
   - `Cloudflare JS-gate — no JSON endpoint after browser render`
   - `runs Jobvite (jobs.jobvite.com/studio) — no provider yet` (a Tier-1 lead!)
   Bad reasons (rejected): `blocked`, `no feed`, `couldn't reach it`, `unreachable
   from CLI` (that last one means escalate to web tools first — see Tooling order).
   Tag: `recipe: {kind: blocked, reason: "<specific evidence>"}`.

### 2. Validate before writing (recipe/ATS only)
Hit the candidate feed once to confirm it returns ≥1 job with a real title:
- ATS: curl the API host (e.g. `https://boards-api.greenhouse.io/v1/boards/{slug}/jobs`).
- recipe: after writing the entry, run `node scan.mjs --company "Studio Name"` and
  confirm it lists real roles. If 0 with no error and the site clearly has jobs,
  the recipe is wrong — fix the selectors/paths, don't commit a silent zero.

### 3. Write the result back to studios.yml
- **`unknown`** → write a TSV-free, hand-authored entry under the right section.
- **`backlog`** → edit the existing entry in place (you MAY edit studios.yml to
  update an entry; only adding *new* tracker rows is forbidden, and that's
  `applications.md`, not this file).
- Always set `last_probe: <today>` so stale dead-ends can be revisited later.
- Mirror the outcome into `data/ats-research.md` (check off / annotate the row).

### 4. Report
Per company: one line — `✅ {name} → {tier} ({provider/kind})` or
`⏭️ {name} → blocked ({reason})`. End with a tally and:
`→ Run "node scan.mjs" to pull the newly-wired studios (zero tokens).`

## Recipe cheat-sheet (full schema in providers/custom.mjs)

```yaml
# kind: json  — site fetches its own JSON
recipe:
  kind: json
  endpoint: https://studio.com/api/jobs   # the XHR you found (or careers_url)
  list_path: data.jobs                     # dot-path to the array; '' = root array
  fields: { title: title, url: applyUrl, location: location.city, company: org.name }
  url_template: https://studio.com/jobs/{id}   # optional, if items carry an id not a url
  url_base: https://studio.com                 # optional, resolves relative urls

# kind: html  — jobs in server-rendered HTML
recipe:
  kind: html
  endpoint: https://studio.com/careers     # optional; defaults to careers_url
  list_selector: ".job-card"               # one match per job
  fields: { title: "h3", url: "a@href", location: ".job-loc" }
  url_base: https://studio.com
```

## Rules
- **Never spend tokens re-researching a `tracked` company.** Run `track-check.mjs` first, every time.
- **Never add a duplicate.** A `backlog` hit means update-in-place.
- **Prefer the highest rung that fits:** ATS > json recipe > html recipe > parser > tag.
  A shared provider helps every studio on that ATS; a per-company recipe/parser helps one.
- **Every `blocked`/`browser` tag MUST carry a specific `reason:`** with the
  concrete evidence you observed (see step 1, item 5). No vague reasons. This is the
  rule that keeps the backlog auditable and prevents silent over-blocking.
- **A CLI failure is NEVER grounds to tag `blocked`.** If `curl`/`scan`/`probe`
  can't reach a site, escalate to `WebSearch` + `WebFetch` first (Tooling order).
  Tag `blocked` only on positive evidence of no feed; tag `browser` if the feed
  likely exists but neither CLI nor web tools could confirm it from here.
- **A blocked tag is a valid, good outcome.** Tagging a *confirmed* dead-end stops
  the backlog from re-spending tokens on it forever.
