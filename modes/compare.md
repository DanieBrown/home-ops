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

Read before comparing:
- `buyer-profile.md`
- `config/profile.yml`
- `modes/_shared.md`
- `modes/_profile.md`
- `data/listings.md`

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

## Output Structure

1. Ranking Table
2. Hard Requirement Comparison
3. Neighborhood and School Comparison
4. Financial Comparison
5. Key Risks and Tradeoffs
6. Best Fit for Daniel
7. Runner-Up
8. Listings to Avoid

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

Only update the tracker if you had to run a fresh evaluation for a listing that was not already recorded.