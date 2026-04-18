# Mode: evaluate -- Single Listing or Pending Pipeline Evaluation

Use this mode when the user provides one listing URL, pasted listing text, or a specific address to evaluate.

If the user runs `evaluate` with no explicit listing target, process the unchecked entries in `data/pipeline.md` in batch mode.

## Goal

Produce a decision-ready home evaluation for one property, or process the pending pipeline in batches and merge those evaluations safely into the canonical tracker.

## Input Modes

- Single-listing mode: the user supplies one listing URL, pasted listing text, or one specific address.
- Pending-pipeline mode: the user runs `evaluate` with no explicit listing target and wants Home-Ops to process the unchecked `- [ ]` entries in `data/pipeline.md`.

The output should answer:
- Does this home meet the buyer's hard requirements?
- Is the neighborhood likely to feel good for day-to-day family life?
- Are the schools credible enough to support the move?
- Is there any development, traffic, flood, or resale risk that changes the decision?
- Should the buyer pursue, tour, hold, or pass?

## Required Inputs

Read before evaluating:
- `buyer-profile.md`
- `config/profile.yml`
- `modes/_shared.md`
- `modes/_profile.md`
- `data/listings.md`
- `data/pipeline.md` when no explicit listing target is provided

If available, also read:
- relevant existing reports in `reports/`
- `portals.yml` for platform-specific login prompts

## Single-Listing Workflow

1. Verify the listing is active.
2. Extract normalized listing facts:
   - address
   - city and county
   - source platform
   - list price
   - beds and baths
   - square footage
   - lot size
   - garage spaces
   - HOA
   - year built
   - days on market
3. Build a hard-requirement gate table with `Pass`, `Fail`, or `Unknown` for each required criterion.
4. Run `node research-source-plan.mjs --address "{address}" --city "{city}" --type all` or `npm.cmd run plan:research -- --address "{address}" --city "{city}" --type all` after fact extraction so the configured development and school inventories in `portals.yml` become a concrete lookup plan instead of passive config.
5. Research the neighborhood sentiment using the source hierarchy in `_shared.md`.
6. Research assigned schools and supporting school sentiment.
7. Check development and infrastructure risk within about 20 miles.
8. Produce a financial snapshot using the buyer financing assumptions.
9. Compute the final 1.0 to 5.0 score with confidence level.
10. Write a report in `reports/` using the shared format.
11. Add or update the row in `data/listings.md`.
12. Run `node research-coverage-audit.mjs <report-path>` or `npm.cmd run audit:research -- <report-path>` and surface any explicit neighborhood, school, or development evidence gaps in the summary.

## Pending-Pipeline Workflow

When `evaluate` is invoked with no explicit listing target:

1. Read unchecked `- [ ]` items from the `Pending` section of `data/pipeline.md`.
2. Normalize and deduplicate the pending items by address + city when available. If address data is missing, fall back to canonical URL deduplication.
3. Treat one physical property as one evaluation even when the pipeline contains Zillow, Redfin, and Realtor.com variants.
4. Choose one primary listing source per property for the first pass. Prefer `Zillow`, then `Redfin`, then `Realtor.com`, but keep alternate URLs available as verification fallbacks.
5. Build one canonical work item per deduplicated property and keep the alternate URLs attached as fallbacks.
6. Prefer the checked-in orchestrator `node evaluate-pending.mjs` or `npm.cmd run evaluate:pending` on Windows PowerShell for the deterministic main-agent side of batch mode. It keeps hosted-browser extraction serialized, prepares one packet per canonical home under `output/evaluate-packets/`, stages tracker TSV rows, rewrites `data/pipeline.md`, refreshes `data/shortlist.md`, and serves as the fallback materializer when ad hoc recovery scripts would otherwise be needed.
7. Keep Playwright-backed listing verification serialized. Do not run multiple portal/browser checks in parallel against the same hosted browser session. The main agent or orchestrator should own the browser pass, extract normalized facts, and run `research-source-plan.mjs` as needed so each property has a concrete evidence packet before report drafting starts.
8. After each property's evidence packet is ready, create one report-writing subagent for that property when worker delegation is available. Each worker should turn the supplied facts, source plan, and fallback URLs into a report draft, score, status, tracker note, and shortlist rationale. If runtime is tight, dispatch these per-home workers in waves of up to 5, but do not bundle multiple homes into one worker.
9. If the `Evaluate Worker` agent is unavailable or unreliable in the current environment, preserve the same one-home packet contract and use `evaluate-pending.mjs` to materialize the reports directly instead of improvising new multi-home helper scripts.
10. Do not require a separate user-facing `/create-agent` step. `evaluate` should create and coordinate these report workers internally.
11. The main agent owns report numbering, tracker staging, merge operations, and final pipeline edits. Workers should return report drafts and structured results rather than editing `data/listings.md` directly.
12. After each worker returns, stage one tracker addition per handled property under `batch/tracker-additions/` using the canonical 11-column home-ops TSV order. Then merge with `node merge-tracker.mjs --verify` or `npm.cmd run merge -- --verify` on Windows PowerShell.
13. Update `data/pipeline.md` as work completes. Move handled items from `Pending` to `Processed` and keep a concise outcome summary that includes report number, score, and final recommendation.
14. Rank the viable homes from the just-completed batch by final recommendation and score, and keep up to ten direct-review candidates.
15. Persist those homes to `data/shortlist.md` as the latest top-10 cohort so deep mode can pick them up immediately. Set `Source Mode: evaluate`, overwrite any older cohort, use tags like `Evaluate Top 10 - Rank N`, and include tracker row numbers, report links, current score, current status, and a one-line reason each home made the top 10. If fewer than ten viable homes exist, persist only the populated rows and say so clearly.
16. Open that saved top-10 cohort in the hosted Chrome session inside one tab group named `Top 10`. Prefer each report's `**URL:**` field and fall back to the report file only when a direct listing URL is missing. Use `node review-tabs.mjs shortlist-top10 --group "Top 10"` or `npm.cmd run browser:review -- shortlist-top10 --group "Top 10"` on Windows PowerShell. If the hosted Chrome session is closed, reopen it before opening the review group.
17. Suggested tracker statuses in batch mode:
   - `Sold` for clearly inactive or unavailable listings
   - `SKIP` for obvious no-fit listings or major hard-requirement failures
   - `Evaluated` for completed reviews with a report
   - Reserve `Interested`, `Tour Scheduled`, `Toured`, `Offer Submitted`, and `Under Contract` for explicit user workflow decisions unless the user asks for automatic shortlisting behavior
18. Keep dispatching per-home report workers until the full deduplicated pending pipeline has been attempted. Only leave backlog behind when a hard blocker, runtime ceiling, or explicit user stop prevents completion, and clearly report what remains pending.
19. After the reports are written, run `research-coverage-audit.mjs` against the just-generated report set and report whether neighborhood, school, and development coverage was explicit, weak, or missing.
20. When the audit flags school or development gaps, run `research-source-plan.mjs` on the affected reports so the next pass uses the exact `portals.yml` sources and suggested lookup targets rather than ad hoc searching.

## Tracker Row Format

When updating `data/listings.md`, use this row shape:

`| {num} | {date} | {address} | {city} | ${price} | {beds}/{baths} | {sqft} | {score}/5 | {status} | [{num}](reports/{file}) | {one-line note} |`

Rules:
- Reuse the existing row if the same normalized address and city already exist.
- `status` should be `SKIP` for obvious no-fit listings, otherwise `Evaluated`.
- The note should explain the main decision in one sentence.

For batch evaluation, prefer staged TSV additions plus `merge-tracker.mjs` over concurrent direct edits to `data/listings.md`.

## Report Structure

Use this exact section order:

1. Quick Take
2. Summary Card
3. Hard Requirement Gate
4. Property Fit
5. Neighborhood Sentiment
6. School Review
7. Development and Infrastructure
8. Financial Snapshot
9. Risks and Open Questions
10. Recommendation

## Recommendation Language

End with one of these:
- `Pursue now`
- `Worth touring`
- `Hold pending validation`
- `Pass`

Always say why in plain language.

## Important Rules

- If the listing fails multiple hard requirements, do not hide that behind a soft positive narrative.
- If the schools are weak or unclear, say that directly.
- If the listing looks attractive but sits on a noisy road or risky lot, that must be prominent in the recommendation.
- If verification fails, keep the report conservative and mark confidence accordingly.
- When Facebook or Nextdoor are available in the hosted browser session, check the most recent 7 days of neighborhood-group or feed discussions for recurring traffic, construction, accident, safety, or noise signals. If those portals are not accessible, say so and rely on public sources instead.
- Treat the configured `sentiment_sources`, `school_sources`, and `development_sources` inventories in `portals.yml` as required research surfaces, not decorative config. Use `research-source-plan.mjs` to resolve the school and development inventories into actual source targets, and if a source class was not actually used, say so plainly and let the research audit reflect that gap.

## Batch Output Summary

When running the pending-pipeline workflow, return a concise summary with:
- pending pipeline entries read
- canonical properties deduplicated
- per-home report workers dispatched
- reports written
- tracker rows added or updated
- shortlist cohort updated
- review tabs opened
- counts by final status
- remaining pending backlog, if any