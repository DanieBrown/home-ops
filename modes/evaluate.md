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
4. Research the neighborhood sentiment using the source hierarchy in `_shared.md`.
5. Research assigned schools and supporting school sentiment.
6. Check development and infrastructure risk within about 20 miles.
7. Produce a financial snapshot using the buyer financing assumptions.
8. Compute the final 1.0 to 5.0 score with confidence level.
9. Write a report in `reports/` using the shared format.
10. Add or update the row in `data/listings.md`.

## Pending-Pipeline Workflow

When `evaluate` is invoked with no explicit listing target:

1. Read unchecked `- [ ]` items from the `Pending` section of `data/pipeline.md`.
2. Normalize and deduplicate the pending items by address + city when available. If address data is missing, fall back to canonical URL deduplication.
3. Treat one physical property as one evaluation even when the pipeline contains Zillow, Redfin, and Realtor.com variants.
4. Choose one primary listing source per property for the first pass. Prefer `Zillow`, then `Redfin`, then `Realtor.com`, but keep alternate URLs available as verification fallbacks.
5. Partition the deduplicated canonical properties into worker slices of up to 5 properties each.
6. Launch one subagent per 5-property slice. Each worker should process its assigned slice and return a structured result for every handled property to the main agent.
7. Keep Playwright-backed listing verification serialized. Do not run multiple portal/browser checks in parallel against the same hosted browser session. If needed, serialize the browser verification step across the worker slices instead of running those checks concurrently.
8. The main agent owns report numbering, tracker staging, merge operations, and final pipeline edits. Workers should return structured results rather than editing `data/listings.md` directly.
9. After each worker returns, stage one tracker addition per handled property under `batch/tracker-additions/` using the canonical 11-column home-ops TSV order. Then merge with `node merge-tracker.mjs --verify` or `npm.cmd run merge -- --verify` on Windows PowerShell.
10. Update `data/pipeline.md` as work completes. Move handled items from `Pending` to `Processed` and keep a concise outcome summary that includes report number, score, and final recommendation.
11. Suggested tracker statuses in batch mode:
   - `Sold` for clearly inactive or unavailable listings
   - `SKIP` for obvious no-fit listings or major hard-requirement failures
   - `Evaluated` for completed reviews with a report
   - Reserve `Interested`, `Tour Scheduled`, `Toured`, `Offer Submitted`, and `Under Contract` for explicit user workflow decisions unless the user asks for automatic shortlisting behavior
12. Keep dispatching 5-property worker slices until the full deduplicated pending pipeline has been attempted. Only leave backlog behind when a hard blocker, runtime ceiling, or explicit user stop prevents completion, and clearly report what remains pending.

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

## Batch Output Summary

When running the pending-pipeline workflow, return a concise summary with:
- pending pipeline entries read
- canonical properties deduplicated
- 5-property worker slices dispatched
- reports written
- tracker rows added or updated
- counts by final status
- remaining pending backlog, if any