# Mode: pipeline — URL Inbox (Second Brain)

Process job URLs stored in `data/pipeline.md`. The user adds URLs at any time and then executes `/career-ops pipeline` to process them all.

## Workflow

0. **Pre-rank and gate to the top N (default 20).** The board can surface
   thousands of jobs; deep CV-aware evaluation is the expensive step, so never
   evaluate the whole board blindly. The ranking has ONE source of truth: the job
   board. `data/ranked.md` is written BY the board — when served locally
   (`npm run board:fresh`, then open it) the web view POSTs its exact visible,
   fit-sorted, exclude-filtered list to board-dev.mjs, which writes the markdown.
   So `data/ranked.md` always mirrors the web board. If it looks stale, open the
   local board to refresh it.

   **Choosing N:**
   - If the user passed `--top {x}` (e.g. `/career-ops pipeline --top 30`), use `x`.
   - Else if the user passed `--all`, evaluate every ranked item (use with care).
   - Else read `config/profile.yml` → `pipeline_top_default`. If absent, default to **20**.

   Take the **top N** rows directly from `data/ranked.md`, in rank order. Each row's
   Role cell is a markdown link to the posting (`[title](<url>)`) and the row carries
   Company + Location — that's everything the deep eval needs; no inbox mapping. Mention
   to the user how many you're evaluating and how many you're skipping (e.g.
   "Evaluating top 20 of 4231 ranked — run `--top 50` or `--all` for more").

1. **Read** the top-N rows from `data/ranked.md` (extract the posting URL from each
   Role-cell link, plus Company and Role). A user who pastes specific URLs to
   evaluate ad hoc should use the paste-a-URL auto-pipeline flow instead.
2. **For each selected URL** (the top-N from step 0):
   a. Calculate the next sequential `REPORT_NUM` (read `reports/`, take the highest number + 1)
   b. **Extract JD** using Playwright (browser_navigate + browser_snapshot) → WebFetch → WebSearch
   c. If the URL is not accessible → mark as `- [!]` with a note and continue
   d. **Execute full auto-pipeline**: Evaluation A-F → Report .md → PDF (if score >= `auto_pdf_score_threshold`) → Tracker
   e. **Move from "Pending" to "Processed"**: `- [x] #NNN | URL | Company | Role | Score/5 | PDF ✅/❌`

   **About the PDF gate (configurable):** Read `config/profile.yml` → `auto_pdf_score_threshold`. If the key does not exist, default to `3.0` (this mode's original gate). If the evaluation score is less than the threshold, skip PDF generation: write the report normally, show in the header `**PDF:** not generated — run /career-ops pdf {company-slug} to create on demand`, and mark PDF ❌ in the tracker. If the score is ≥ threshold, generate the PDF as usual.

   **Tuning it:** Generating a tailored PDF costs ~30–60s per entry (Playwright launch + HTML render) and produces files that often go unused — most roles score in the 2.x/3.x range and never reach the application stage. Raise `auto_pdf_score_threshold` (e.g. `4.0`) to write only the report for marginal offers and produce the PDF on demand via `/career-ops pdf {slug}`; set `0` to generate one for every offer. Both modes (Path A `/career-ops pipeline` and Path B `batch/batch-runner.sh`) read the same key, so behavior is identical regardless of which path processes an offer.
3. **If there are 3+ pending URLs**, launch agents in parallel (Agent tool with `run_in_background`) to maximize speed.
4. **At the end**, show summary table:

```
| # | Company | Role | Score | PDF | Recommended action |
```

## Format of pipeline.md

```markdown
## Pending
- [ ] https://jobs.example.com/posting/123
- [ ] https://boards.greenhouse.io/company/jobs/456 | Company Inc | Senior PM
- [!] https://private.url/job — Error: login required

## Processed
- [x] #143 | https://jobs.example.com/posting/789 | Acme Corp | AI PM | 4.2/5 | PDF ✅
- [x] #144 | https://boards.greenhouse.io/xyz/jobs/012 | BigCo | SA | 2.1/5 | PDF ❌
```

## Intelligent JD detection from URL

1. **Playwright (preferred):** `browser_navigate` + `browser_snapshot`. Works with all SPAs.
2. **WebFetch (fallback):** For static pages or when Playwright is unavailable.
3. **WebSearch (last resort):** Search in secondary portals that index the JD.

**Special cases:**
- **LinkedIn**: May require login → mark `[!]` and ask the user to paste the text
- **PDF**: If the URL points to a PDF, read it directly with the Read tool
- **`local:` prefix**: Read the local file. Example: `local:jds/linkedin-pm-ai.md` → read `jds/linkedin-pm-ai.md`

## Automatic numbering

1. List all files in `reports/`
2. Extract the number from the prefix (e.g., `142-medispend...` → 142)
3. New number = maximum found + 1

## Source synchronization

Before processing any URL, verify sync:
```bash
node cv-sync-check.mjs
```
If there is a desynchronization, warn the user before continuing.
