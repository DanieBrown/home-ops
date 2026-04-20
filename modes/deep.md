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

## Run-to-Completion Contract

Once the deep command has started, run every numbered step in the branch below to completion in one turn. Do not pause for user approval between steps, do not ask the user "should I continue?", and do not treat writing the combined brief as the finish line -- steps 12 through 16 (shortlist update, rerank, finalist gate, PDF render, tab replacement) are part of the same command and must run in the same turn.

The only legitimate stop points are:

1. **Missing prerequisite the user must supply.** Example: `data/shortlist.md` has no populated top-10 rows and no compare or evaluate run has established a cohort. Ask once, then proceed when the user answers.
2. **Destructive override.** Example: the finalist gate fails and the user must explicitly authorize a bypass before the refined top-3 is promoted. Surface the gate result, ask once, and continue based on the answer.
3. **Hard external failure that blocks all downstream steps.** Example: the hosted browser session is closed and cannot be reopened, and every subsequent step depends on it. Say so, close out the run, and stop.

Every other condition -- partial results, one missing sentiment file, a single worker returning thin evidence, NCDOT timing out -- must be recorded in the brief and the run must continue. "Say that explicitly and continue" in the steps below means surface the gap in the brief and keep running, not pause for approval.

When each numbered step starts, announce it in one short sentence ("Step 6: launching plan + sentiment + construction in parallel") so the user sees progress without being asked to confirm it.

## Shortlist Batch Branch

When the user asks for a batch deep dive on the shortlist, or when the latest `evaluate` or `compare` workflow clearly established a current top-10 cohort:

1. Read `data/shortlist.md` and use the populated rows in the current top-10 table as the target set.
2. Accept cohorts created by either `evaluate` or `compare`. If the current top-10 table is empty, ask the user what set deep should review instead of guessing.
3. Load the existing evaluation reports for those same shortlisted homes.
4. If any shortlisted home has not been fully evaluated yet, run the evaluate workflow first before doing the deep batch.
5. Run `research-coverage-audit.mjs` against those shortlisted evaluation reports before reranking so the deep batch knows which homes still have weak neighborhood, school, or development evidence.
6. **Parallel fan-out (steps 6a, 6b, 6c run concurrently).** These three commands are independent and must be launched together, not serialized. On Windows PowerShell use `Start-Job` or three separate `run_in_background` Bash invocations; wait for all three to finish before moving to step 7. Add `--quick` to every command in this step when the user asks for a fast progressive deep pass or when the shortlist has five or more homes.
   - 6a: `node research-source-plan.mjs --shortlist --type all` (no browser, fast). Produces the concrete lookup plan for every shortlisted home.
   - 6b: `node sentiment-browser-extract.mjs --shortlist --profile chrome-host --concurrency 4` captures deterministic Facebook and Nextdoor evidence into `output/sentiment/`. The 6-hour sentiment cache short-circuits any shortlist sibling that shares a subdivision, so re-runs within the same session are essentially free. Add `--quick` to cap queries per source at three. If the hosted session is missing, closed, or not logged into those portals, say that explicitly and continue with public sources instead of pretending the sentiment pass was completed.
   - 6c: `node construction-check.mjs --shortlist` fetches the NCDOT project index and writes `output/construction/{slug}.json` for every shortlisted home. Add `--quick` to skip the secondary STIP URL when the primary page is enough.
7. Wait for all three parallel jobs from step 6 to finish before continuing. If any failed, surface the error in the brief rather than silently proceeding.
8. Run `node deep-research-packet.mjs --shortlist` or `npm.cmd run prepare:deep -- --shortlist` so every shortlisted home gets one deterministic packet under `output/deep-packets/`. Each packet must carry the baseline evaluation summary, research-audit blockers, configured sentiment, school, and development source plans, profile weights, any matching browser-captured Facebook or Nextdoor evidence, and the construction pressure record from step 6c. If a matching sentiment or construction file is missing, the packet must say that explicitly instead of implying capture.
9. Launch one subagent per shortlisted home, up to ten homes total. Every Agent call must be issued in a single message so the runtime fans them out in parallel -- never serialize worker launches. Each worker receives exactly one deep packet plus the matching evaluation report path, researches all deep-dive axes for one home, and returns a structured result. Workers must not edit `data/listings.md`, `data/shortlist.md`, or `reports/` directly.
10. Stream worker results back into the combined brief as they land so the user sees progress before every worker finishes. Do not wait for the slowest worker before starting the brief skeleton; append each home's section as its Agent call returns. Streaming is for visible progress only -- do not pause for user input between worker returns.
11. The main agent reviews the worker output internally, resolves conflicts, and writes one combined batch brief to `reports/deep-shortlist-{YYYY-MM-DD}.md`. This review is not a user checkpoint. Writing the brief is not the end of the command; immediately proceed to step 12.
12. Update `data/shortlist.md` with:
	- deep batch status
	- deep batch report path
	- refined top 3 after deeper research
13. End by rerunning the compare framework across that same top-10 cohort using the returned deep findings, the research-audit gaps, the deep packets, and any browser-backed sentiment extraction, then narrow it to the best three homes, not just the original evaluation summaries. Treat `constructionEvidence.level` from each packet as a resale-risk modifier: a `high` level should depress a home's rerank unless the matches are clearly benign. The final ranking belongs to the main agent, not the workers.
14. Run `node shortlist-finalist-gate.mjs` or `npm.cmd run gate:finalists` before promoting the refined top 3. If the gate passes, continue to step 15 immediately. If the gate fails, this is a legitimate stop point: surface the exact blockers, ask once whether the user wants to bypass, and continue based on the answer. Do not ask "should I continue?" if the gate passes.
15. Close the remaining non-finalist tabs across the full hosted Chrome session and leave only the refined top 3 in individual browser tabs so the user can review the finalists immediately. Prefer the direct listing URL from the underlying report. If a direct listing URL is unavailable, open the report file instead. Use `node review-tabs.mjs shortlist-top3 --replace` or `npm.cmd run browser:review -- shortlist-top3 --replace` on Windows PowerShell. The review helper now enforces the same finalist gate unless `--skip-finalist-gate` is used explicitly. If the hosted Chrome session is closed, reopen it and restore the three finalist links into fresh tabs. This step must run before step 16 so the briefing PDF is not closed as a side effect of the tab replacement.
16. Render the top-3 finalist briefing PDF and open it in the same hosted Chrome session using `node briefing-pdf.mjs` or `npm.cmd run brief:top3` on Windows PowerShell. The PDF lands under `output/briefings/` as `top3-briefing-{YYYY-MM-DD}.pdf` and opens as a new tab via CDP `/json/new` alongside the three finalist listing tabs from step 15. The final state must be exactly four tabs in the hosted session: the three finalist listings plus the briefing PDF. If the hosted session is closed, the PDF still renders so the user can open it manually -- surface that fact in the final summary.

If the shortlist contains fewer than ten populated viable homes, research only the populated rows and say that the current shortlist is smaller than ten. This is not a stop condition; continue the run on the populated subset.

The deep command is finished only after step 16 completes. At that point, post a final summary line listing: which report was written, whether the finalist gate passed, where the briefing PDF landed, and that four tabs (three finalists plus the briefing PDF) are open in the hosted session. Do not stop earlier.

## Research Axes

Organize the deep dive around these sections:

1. Immediate Area and Neighborhood Identity
2. School Ecosystem
3. Development Pipeline and Future Change
4. Commute and Daily Convenience
5. Risk Review
6. Resale Outlook
7. Buyer-Specific Verdict

**Quick mode axes (when --quick was passed to the step 6 commands):** Each worker focuses on axes 1, 3, 5, and 7 only -- the highest-signal axes for a progressive decision. Axes 2, 4, and 6 can be filled in a second targeted pass if the shortlist narrows but more evidence is still needed. Quick mode is not an excuse to skip evidence; it is a way to get a fast first read that can be deepened later.

## What to Research

### 1. Immediate Area and Neighborhood Identity
- subdivision reputation if identifiable
- street character and traffic feel
- family-friendliness and community feel
- recurring praise or complaints from locals

### 2. School Ecosystem
- assigned schools and ratings
- parent sentiment patterns
- school-crowding or redistricting concerns
- extracurricular or support-program strength

### 3. Development Pipeline and Future Change
- nearby subdivisions or rezoning
- commercial growth that could improve or hurt convenience
- road projects and widening plans
- any signs of overbuilding or infrastructure strain

### 4. Commute and Daily Convenience
- access to Raleigh and RTP
- grocery, parks, urgent care, and family amenities
- bottlenecks or road chokepoints

### 5. Risk Review
- flood or drainage issues
- road noise
- adjacency to unattractive uses
- HOA or municipal-service concerns

### 6. Resale Outlook
- likely buyer appeal in 3 to 7 years
- whether the home type and area should remain liquid
- risks that could hurt future marketability

### 7. Buyer-Specific Verdict
- why this area does or does not fit Daniel's stated priorities
- what would need to be validated in person before moving forward

## Output Requirements For Shortlist Batches

Each worker result must include these fields, even when some sources are blocked or missing:

1. `address`
2. `sourceCoverage` with explicit statuses for Facebook, Nextdoor, Reddit or public sentiment fallback, NCDOT, county planning, municipal planning, and school sources. Use `captured`, `blocked`, `no-match`, `reviewed`, or `missing` instead of vague language.
3. `sentimentMetrics` mapped to the configured `config/profile.yml` weights for `crime_safety`, `traffic_commute`, `community`, `school_quality`, and `livability`, including the source used for each metric.
4. `schoolMetrics` mapped to the configured school-sentiment weights, including rating evidence and parent or community confidence.
5. `developmentMetrics` that explicitly call out whether NCDOT and local planning sources were reviewed, what they showed, and how they affect traffic, crowding, or resale risk.
6. `deepScoreAdjustments` that explain how the deeper evidence changes the prior evaluation score or ranking position.
7. `keyPositives`
8. `keyNegatives`
9. `unresolvedQuestions`
10. `tentativeVerdict`

When deep mode is operating on the current compare shortlist, the final brief should contain:

1. Per-home deep findings for the shortlisted set
2. Cross-home risk comparison
3. Deep-adjusted top 3
4. Best fit after deeper research
5. Runner-up after deeper research
6. Why the homes outside the refined top 3 fell back
7. What changed from the original evaluate or compare top-10 order

## Output Style

- Prefer a direct research brief over a generic prompt.
- If the user explicitly asks for a reusable prompt, provide one tailored to the address or area.
- Distinguish clearly between evidence, inference, and unresolved questions.
- Use the research-audit output to distinguish evidence-backed findings from inherited evaluation gaps. Deep mode should not silently treat missing neighborhood, school, or development research as completed just because the shortlist exists.
- Use `research-source-plan.mjs` as the default bridge from `portals.yml` into actual sentiment, school, and development lookups, with development checks first when time is limited.
- When the hosted browser session is available, prefer `sentiment-browser-extract.mjs` for Facebook and Nextdoor evidence before falling back to public-source neighborhood sentiment.
- Use `deep-research-packet.mjs` as the handoff contract for shortlist workers so the packet, not memory, carries the source plan, audit blockers, profile weights, and captured browser evidence.
- If Facebook, Nextdoor, or NCDOT were not actually reviewed, say that directly and lower confidence instead of smoothing over the gap.
- The final brief should include a per-home source-coverage ledger and weighted-adjustment rationale, not just narrative prose.
- When the shortlist batch branch is active, use one subagent per home as the default pattern and make it clear that the main agent owns the final top-3 rerank.
- When running the shortlist batch branch, persist the refined top 3 back into `data/shortlist.md` after writing the batch brief.
- When the shortlist batch branch finishes, the hosted Chrome window should contain exactly four tabs: the three finalist home listings plus the rendered briefing PDF. All other tabs must be closed. Open the briefing PDF after the tab replacement so it is not evicted. The finalist set must pass the strict research gate unless the user explicitly overrides it.
