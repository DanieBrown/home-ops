# Mode: evaluate -- Single Listing Evaluation

Use this mode when the user provides one listing URL, pasted listing text, or a specific address to evaluate.

## Goal

Produce a decision-ready home evaluation for one property.

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

If available, also read:
- relevant existing reports in `reports/`
- `portals.yml` for platform-specific login prompts

## Workflow

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

## Tracker Row Format

When updating `data/listings.md`, use this row shape:

`| {num} | {date} | {address} | {city} | ${price} | {beds}/{baths} | {sqft} | {score}/5 | {status} | [{num}](reports/{file}) | {one-line note} |`

Rules:
- Reuse the existing row if the same normalized address and city already exist.
- `status` should be `SKIP` for obvious no-fit listings, otherwise `Evaluated`.
- The note should explain the main decision in one sentence.

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