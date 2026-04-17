# Mode: compare -- Multi-Listing Comparison

Use this mode when the user wants to compare two or more listings, addresses, or existing reports.

## Goal

Rank multiple homes against the buyer's actual criteria and make the tradeoffs obvious.

## Inputs

Accept any mix of:
- direct listing URLs
- addresses
- existing report files in `reports/`
- tracker entries from `data/listings.md`
- the latest tagged shortlist in `data/shortlist.md`

Read before comparing:
- `buyer-profile.md`
- `config/profile.yml`
- `modes/_shared.md`
- `modes/_profile.md`
- `data/listings.md`
- `data/shortlist.md` if it exists

If a prior deep batch report is linked from `data/shortlist.md`, read that report before refining the ranked order.

If any listing has not been fully evaluated yet, run the evaluate workflow first.

## Comparison Framework

For each listing, normalize these fields:
- address
- city
- price
- beds and baths
- square footage
- year built
- HOA
- overall score
- hard requirement misses
- neighborhood sentiment summary
- school summary
- major risks
- estimated monthly cost range

## Top-10 Shortlist Workflow

After every comparison that produces a ranked set of evaluated homes:

1. Persist up to the top ten decision-relevant homes to `data/shortlist.md`.
2. Set the cohort metadata so the file clearly shows `Source Mode: compare`, the compare scope, the trigger, and whether the cohort is smaller than ten.
3. Tag them there as:
	- `Compare Top 10 - Rank 1`
	- `Compare Top 10 - Rank 2`
	- `Compare Top 10 - Rank 3`
	- `Compare Top 10 - Rank 4`
	- `Compare Top 10 - Rank 5`
	- `Compare Top 10 - Rank 6`
	- `Compare Top 10 - Rank 7`
	- `Compare Top 10 - Rank 8`
	- `Compare Top 10 - Rank 9`
	- `Compare Top 10 - Rank 10`
4. Include tracker row numbers, report links, current score, current status, and a one-line reason each home made the compare top 10.
5. Overwrite the previous shortlist cohort rather than appending a second active cohort, even if the previous top-10 cohort came from `evaluate`.
6. If a deep-batch rerank already exists for the same compare cohort, replace the old refined ranking with the new one.
7. Open the saved top-10 cohort in the hosted browser so the user can review the homes side by side. Prefer the listing URL from the underlying report. If no direct listing URL is available, open the report file instead. Use `node review-tabs.mjs shortlist-top10 --group "Top 10"` or `npm.cmd run browser:review -- shortlist-top10 --group "Top 10"` on Windows PowerShell.

Prefer homes that are still alive in the decision process. Exclude `Sold` and `SKIP` homes from the tagged shortlist unless the user explicitly asks to compare eliminated homes too. If fewer than ten viable homes remain, tag fewer and say so clearly.

Use `data/shortlist.md` for tagging. Do not invent new tracker statuses for compare rankings.

## Output Structure

1. Ranking Table
2. Hard Requirement Comparison
3. Neighborhood and School Comparison
4. Financial Comparison
5. Key Risks and Tradeoffs
6. Best Fit for Users
7. Runner-Up
8. Listings to Avoid

The ranking table should show up to the top 10 viable homes when enough evaluated homes exist, and clearly say when the pool is smaller.

Also update `data/shortlist.md` with the current compare top-10 shortlist when the comparison has at least one viable evaluated home. Deep mode then uses that shortlist to narrow the field to a refined top 3.

When compare finishes, the user should also have one browser tab open per shortlisted home for direct review.

## Ranking Rules

- Hard requirement compliance outranks cosmetic appeal.
- If one listing has stronger schools and a quieter setting, that should usually outrank a similarly priced but flashier home.
- New construction should not automatically win over a better-located resale.
- A lower price only matters if the property still clears the family-fit bar.

## Output Style

Be decisive.

Do not merely restate the scores. Explain the real tradeoff in plain language, for example:
- more house but weaker schools
- stronger neighborhood but tighter lot
- better value but higher traffic risk
- prettier finishes but worse resale logic

Only update the tracker if you had to run a fresh evaluation for a listing that was not already recorded. The compare-command tagging state belongs in `data/shortlist.md`, not in tracker status.