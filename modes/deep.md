# Mode: deep -- Listing or Area Deep Dive

Use this mode when the user wants deeper research on a property, subdivision, neighborhood, town, or school cluster.

Read before researching:
- `buyer-profile.md`
- `config/profile.yml`
- `modes/_shared.md`
- `modes/_profile.md`
- `data/listings.md`
- `data/shortlist.md` if it exists
- relevant existing reports in `reports/`

## Goal

Produce a detailed brief that goes beyond the normal evaluation report.

This mode is for questions like:
- "Go deeper on this neighborhood"
- "Research everything around this house"
- "How risky is this area long term?"
- "Compare the school environment around these two subdivisions"

It also handles a shortlist batch branch:
- "Go deep on the top 10"
- "Run deep on the compare shortlist"
- "Batch deep dive the current shortlist"

## Architecture: Three Axis Agents

This mode uses **three axis agents plus the main agent**, regardless of shortlist size. There is no per-home subagent fan-out anymore. The deterministic capture scripts in Phase A do all live browsing; the axis agents in Phase B only interpret pre-captured JSON sidecars.

Total agent count per run = 4 (3 axis + 1 main), down from up to 11 in the old per-home design.

## Run-to-Completion Contract

Once the deep command starts, run every numbered step below to completion in one turn. Do not pause for user approval between steps.

The only legitimate stop points are:

1. **Missing prerequisite the user must supply.** Example: `data/shortlist.md` has no populated top-10 rows and no compare or evaluate run has established a cohort. Ask once, then proceed.
2. **Destructive override.** Example: the finalist gate fails and the user must explicitly authorize a bypass before the refined top-3 is promoted. Surface the gate result, ask once, continue based on the answer.
3. **Hard external failure that blocks all downstream steps.** Example: the hosted browser session is closed and cannot be reopened.

Every other condition (partial results, one missing sentiment file, NCDOT timing out) must be recorded in the brief and the run must continue.

When each numbered step starts, announce it in one short sentence so the user sees progress.

## Shortlist Batch Branch

When the user asks for a batch deep dive on the shortlist, or when the latest `evaluate` or `compare` run clearly established a current top-10 cohort:

1. Read `data/shortlist.md` and use the populated top-10 rows as the target set. Accept cohorts created by either `evaluate` or `compare`. If empty, ask the user what set deep should review.
2. Load existing evaluation reports for those homes. If any home is not yet evaluated, run `evaluate` first.
3. Run `scripts/research/research-coverage-audit.mjs` against the shortlisted reports so deep knows which homes still have weak neighborhood, school, or development evidence.

### Phase A — Deterministic Capture (no agents)

**Steps 4a–4f run concurrently.** These commands are independent and must be launched together; wait for all to finish before Phase B. Use `run_in_background` Bash calls or `Start-Job` on Windows PowerShell. Add `--quick` to every step in this phase when the user asks for a fast progressive pass or when the shortlist has five or more homes.

- **4a:** `node scripts/research/research-source-plan.mjs --shortlist --type all` -- produces the lookup plan.
- **4b:** `node scripts/research/community-lookup.mjs --shortlist --profile chrome-host` -- resolves each home to a named community via mapdevelopers.com. Cached under `output/communities/{slug}.json`. Required input for 4c.
- **4c:** `node scripts/research/sentiment-browser-extract.mjs --shortlist --profile chrome-host --concurrency 4` -- captures Facebook + Nextdoor evidence into `output/sentiment/{slug}.json`. Honors `--quick`.
- **4d:** `node scripts/research/sentiment-public-extract.mjs --shortlist` -- fetches Reddit / Google Maps snippets per `portals.yml` and merges them into the same sentiment files. Sole source for the `traffic_commute` dimension.
- **4e:** `node scripts/research/construction-check.mjs --shortlist` -- NCDOT project pressure into `output/construction/{slug}.json`. Honors `--quick`.
- **4f:** `node scripts/research/county-permits-check.mjs --shortlist` -- geocodes each home (cached at `output/geocode/`), runs a 5-mile spatial query against the configured county GIS feature services (Wake County by default), writes `output/permits/{slug}.json`. Skips with `status: "skipped-by-profile"` if `research_sources.development.county_planning` is false.
- **4g:** `node scripts/research/school-metadata-fetch.mjs --shortlist` -- per-school GreatSchools metadata (rating, enrollment, ratio, ethnicity) into `output/school-metadata/{slug}.json`. Skips if no school sources are opted in.

5. Wait for all Phase A jobs to finish. If any failed, surface the error in the brief rather than silently proceeding.

6. Run `node scripts/research/deep-research-packet.mjs --shortlist` so each shortlisted home gets one packet under `output/deep-packets/{slug}.json`. Each packet carries baseline evaluation, audit blockers, source plans, profile weights, captured sentiment, construction, permits, and school metadata sidecars.

### Phase B — Three Axis Agents (interpretation only)

Launch the three axis agents in **a single message with three Agent tool calls** so the runtime fans them out in parallel. None of the axis agents browse the web; they read pre-written JSON files and return structured findings.

7. **Sentiment Agent.** Inputs: every `output/sentiment/{slug}.json`, the buyer profile weights, deal_breakers, commute destinations. Output per home:
    - `sentimentScores` keyed by dimension (`crime_safety`, `traffic_commute`, `community`, `livability`) with each entry containing `score` (signed, weight-applied), `signalDirection`, `evidenceCount`, `proximityMix` (counts of strong vs. weak vs. general matches), and 2–3 raw `quotes` from the captured snippets.
    - `redFlagsTriggered`: list of buyer deal-breaker phrases that matched any snippet, with the matching quote.
    - `sourceCoverage` per source (`facebook`, `nextdoor`, `reddit`, `google_maps`) using `captured`, `blocked`, `no-community-match`, `skipped-by-profile`, or `missing`.
    - `confidence` -- `high` / `medium` / `low` based on coverage and proximity mix.

8. **Risk Agent** (construction + permits combined). Inputs: every `output/construction/{slug}.json` and `output/permits/{slug}.json`. Output per home:
    - `riskLevel` -- `low` / `moderate` / `high`.
    - `nearbyProjects`: array of the most relevant matches across both sources, each with a one-line description, source, status, and distance/proximity hint.
    - `pressureBreakdown`: NCDOT contribution + county-permit contribution.
    - `resaleRiskNote`: one paragraph explaining how the level should adjust the home's rerank.

9. **Schools Agent.** Inputs: every `output/school-metadata/{slug}.json`. Output per home:
    - `schools`: array per assigned school with `name`, `gradeLevel`, `greatSchoolsRating`, `enrollment`, `studentTeacherRatio`, `ethnicityDistribution`, and a `note` flagging mismatches with the listing-source rating from the report.
    - `weightedSchoolScore`: a normalized 0–1 score derived from the assigned-school ratings vs. `hard_requirements.schools_min_rating`. This score is multiplied by `profile.sentiment.weights.schools` when the main agent reranks.
    - `flags`: parent-of-the-year red flags such as enrollment trending up sharply, ratio above district mean, or rating below the buyer minimum.

The axis agents must NOT make tool calls (no `WebFetch`, no Playwright). If the input JSON for a home is missing, the agent records the gap with `status: "missing-input"` for that home and continues.

### Phase C — Main Agent Synthesis

10. Stream the axis agent results back as they land so the user sees progress. Do not wait for the slowest agent before starting the brief skeleton.

11. The main agent reviews the three axis outputs together with the deep packets and evaluation reports, resolves conflicts, and writes one combined batch brief to `reports/deep-shortlist-{YYYY-MM-DD}.md`. Writing the brief is not the end of the command; immediately proceed to step 12.

12. Update `data/shortlist.md` with deep batch status, the report path, and the refined top 3.

13. Rerank the top-10 cohort using the axis agent outputs, deep packets, and audit gaps. Treat `riskLevel: "high"` as a resale-risk modifier that depresses a home's rank unless the matches are clearly benign. The schools score is multiplied by the `schools` weight from `profile.sentiment.weights` and contributes to the rerank.

14. Run `node scripts/research/shortlist-finalist-gate.mjs` before promoting the refined top 3. If the gate passes, continue. If it fails, surface the blockers, ask once whether the user wants to bypass, and continue based on the answer.

15. Replace tabs with the refined top 3 using `node scripts/browser/review-tabs.mjs shortlist-top3 --replace` (Windows PowerShell: `npm.cmd run browser:review -- shortlist-top3 --replace`). Open the listing URLs from the underlying reports; fall back to the report file when the listing URL is missing.

16. Render the briefing PDF and open it in the same hosted Chrome session via `node scripts/reports/briefing-pdf.mjs` (Windows PowerShell: `npm.cmd run brief:top3`). The PDF lands at `output/briefings/top3-briefing-{YYYY-MM-DD}.pdf`. Final state: exactly four tabs in the hosted session — three finalist listings + the briefing PDF.

If the shortlist contains fewer than ten populated homes, research only the populated rows. Continue the run on the populated subset.

The deep command is finished only after step 16. Post a final summary line listing the brief path, finalist gate result, briefing PDF path, and the four-tab final state.

## Research Axes (for the brief content)

Organize the combined brief around these sections:

1. Immediate Area and Neighborhood Identity
2. School Ecosystem
3. Development Pipeline and Future Change
4. Commute and Daily Convenience
5. Risk Review
6. Resale Outlook
7. Buyer-Specific Verdict

**Quick mode axes (when --quick was passed in Phase A):** focus the brief on axes 1, 3, 5, and 7. Axes 2, 4, and 6 can be filled in a second targeted pass later.

## What to Research per Axis

### 1. Immediate Area and Neighborhood Identity
Sentiment Agent's `sentimentScores.community`, `sentimentScores.livability`, and `redFlagsTriggered` drive this section. Quote 2–3 raw snippets per home.

### 2. School Ecosystem
Schools Agent output. Include the metadata table and any flags about ratings drift, enrollment, or deal-breaker mismatches.

### 3. Development Pipeline and Future Change
Risk Agent output. Combine NCDOT + county permits. Always cite specific case IDs and project descriptions when present in `output/permits/`.

### 4. Commute and Daily Convenience
Sentiment Agent's `traffic_commute` dimension (sourced from Reddit / Google Maps / construction signals). Cross-reference with buyer commute destinations from `config/profile.yml`.

### 5. Risk Review
Combine: Risk Agent's high-pressure projects, Sentiment Agent's red flags, and any audit blockers from the deep packet.

### 6. Resale Outlook
Use the rerank logic. Explain how each axis pushed the home up or down vs. the original evaluation order.

### 7. Buyer-Specific Verdict
Per-home: does this fit the buyer's stated priorities, and what would need in-person validation before moving forward.

## Output Style

- Prefer a direct research brief over a generic prompt. If the user explicitly asks for a reusable prompt, provide one tailored to the address or area.
- Distinguish clearly between evidence, inference, and unresolved questions.
- Include a per-home source-coverage ledger at the top of each home's section showing what was captured, blocked, or missing.
- If sentiment, construction, permits, or school metadata files are missing for a home, say that directly and lower confidence — do not paper over the gap.
- Persist the refined top 3 back into `data/shortlist.md` after writing the batch brief.
- When the shortlist batch branch finishes, the hosted Chrome window should contain exactly four tabs (three finalists + briefing PDF). All other tabs must be closed. Open the briefing PDF after the tab replacement so it is not evicted.

## Single-Home Branch (no shortlist)

When the user asks for a deep dive on one address or neighborhood (not the shortlist):

1. Run the same Phase A capture commands but pass the report path or `--address`/`--city` instead of `--shortlist`.
2. Skip the per-axis-agent fan-out — the main agent reads the captured JSON sidecars directly and writes a single deep brief to `reports/{slug}-deep-{YYYY-MM-DD}.md`.
3. No tab replacement, no briefing PDF, no shortlist update.

The three-axis-agent flow is reserved for batch shortlist runs because that's where the cost savings matter; for single-home requests the main agent handles synthesis directly.
