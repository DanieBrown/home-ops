# Mode: tracker -- Listings Tracker

Read and summarize `data/listings.md`.

## Primary Uses

- show the full home-search tracker
- filter by city, score, or status
- update a listing status
- surface the current shortlist
- identify stale or low-confidence entries that need follow-up

## Tracker Format

`data/listings.md` uses this table:

`| # | Date | Address | City | Price | Beds/Baths | SqFt | Score | Status | Report | Notes |`

## Canonical States

Use only the labels from `templates/states.yml`:
- New
- Evaluated
- Interested
- Tour Scheduled
- Toured
- Offer Submitted
- Under Contract
- Closed
- Passed
- Sold
- SKIP

If the user asks to change a status, normalize the requested wording to one of those canonical labels.

## What to Show

At minimum, include:
- total tracked listings
- listings by status
- average score
- city breakdown
- current shortlist: score 4.0 or higher, plus anything marked `Interested` or beyond

## Update Rules

- If updating a row, keep the existing report link unless the report changed.
- Keep notes short and decision-oriented.
- Do not create duplicates for the same address.

## Suggested Filters

If the user does not specify a filter, default to a useful overview:
- strongest current options
- recent evaluations
- anything needing a decision next
