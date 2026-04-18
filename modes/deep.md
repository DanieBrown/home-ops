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

## Shortlist Batch Branch

When the user asks for a batch deep dive on the shortlist, or when the latest `evaluate` or `compare` workflow clearly established a current top-10 cohort:

1. Read `data/shortlist.md` and use the populated rows in the current top-10 table as the target set.
2. Accept cohorts created by either `evaluate` or `compare`. If the current top-10 table is empty, ask the user what set deep should review instead of guessing.
3. Load the existing evaluation reports for those same shortlisted homes.
4. If any shortlisted home has not been fully evaluated yet, run the evaluate workflow first before doing the deep batch.
5. Run `research-coverage-audit.mjs` against those shortlisted evaluation reports before reranking so the deep batch knows which homes still have weak neighborhood, school, or development evidence.
6. Run `node research-source-plan.mjs --shortlist --type all` or `npm.cmd run plan:research -- --shortlist --type all` so the configured sentiment, development, and school inventories become a concrete lookup plan for every shortlisted home before the deeper pass starts.
7. Run `node sentiment-browser-extract.mjs --shortlist --profile chrome-host` or `npm.cmd run extract:sentiment -- --shortlist --profile chrome-host` so the hosted browser session captures deterministic Facebook and Nextdoor evidence into `output/sentiment/` before subagents start. If the hosted session is missing, closed, or not logged into those portals, say that explicitly and continue with public sources instead of pretending the sentiment pass was completed.
8. Run `node deep-research-packet.mjs --shortlist` or `npm.cmd run prepare:deep -- --shortlist` so every shortlisted home gets one deterministic packet under `output/deep-packets/`. Each packet must carry the baseline evaluation summary, research-audit blockers, configured sentiment, school, and development source plans, profile weights, and any matching browser-captured Facebook or Nextdoor evidence. If a matching sentiment file is missing, the packet must say that explicitly instead of implying capture.
9. Launch one subagent per shortlisted home, up to ten homes total. Each worker should receive exactly one deep packet plus the matching evaluation report path, research all deep-dive axes for one home, and return a structured result. Workers must not edit `data/listings.md`, `data/shortlist.md`, or `reports/` directly.
10. The main agent must review the worker output, resolve conflicts, and write one combined batch brief to `reports/deep-shortlist-{YYYY-MM-DD}.md`.
11. Update `data/shortlist.md` with:
	- deep batch status
	- deep batch report path
	- refined top 3 after deeper research
12. End by rerunning the compare framework across that same top-10 cohort using the returned deep findings, the research-audit gaps, the deep packets, and any browser-backed sentiment extraction, then narrow it to the best three homes, not just the original evaluation summaries. The final ranking belongs to the main agent, not the workers.
13. Run `node shortlist-finalist-gate.mjs` or `npm.cmd run gate:finalists` before promoting the refined top 3. Do not treat blocked homes as finalists until the gate passes or the user explicitly authorizes a bypass.
14. Close the remaining non-finalist tabs across the full hosted Chrome session and leave only the refined top 3 in individual browser tabs so the user can review the finalists immediately. Prefer the direct listing URL from the underlying report. If a direct listing URL is unavailable, open the report file instead. Use `node review-tabs.mjs shortlist-top3 --replace` or `npm.cmd run browser:review -- shortlist-top3 --replace` on Windows PowerShell. The review helper now enforces the same finalist gate unless `--skip-finalist-gate` is used explicitly. If the hosted Chrome session is closed, reopen it and restore the three finalist links into fresh tabs.

If the shortlist contains fewer than ten populated viable homes, research only the populated rows and say that the current shortlist is smaller than ten.

## Research Axes

Organize the deep dive around these sections:

1. Immediate Area and Neighborhood Identity
2. School Ecosystem
3. Development Pipeline and Future Change
4. Commute and Daily Convenience
5. Risk Review
6. Resale Outlook
7. Buyer-Specific Verdict

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
- When the shortlist batch branch finishes, the refined top 3 should be the only remaining home tabs left open in the hosted Chrome window for review, and that finalist set must pass the strict research gate unless the user explicitly overrides it.
