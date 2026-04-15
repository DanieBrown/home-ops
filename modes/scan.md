# Mode: scan -- Listing Scanner

Scan configured real-estate platforms, filter for likely fit, and add new listings to `data/pipeline.md` for later evaluation.

## Read First

- `modes/_shared.md`
- `modes/_profile.md`
- `config/profile.yml`
- `portals.yml`
- `data/listings.md`
- `data/pipeline.md`
- `data/scan-history.tsv` if it exists

## Goal

Discover newly listed homes in the configured NC search areas that appear to meet Daniel's hard requirements.

## Scan Strategy

Use a layered approach:

1. Platform search URLs from `portals.yml`.
2. Listing-card extraction from Zillow, Redfin, and Realtor.com.
3. WebSearch fallback queries only when platform pages are blocked or incomplete.

## Login Rules

- Respect `login_required` entries in `portals.yml`.
- If the session is not logged in, stop and prompt the user using the platform's `login_prompt`.
- Do not fake logged-in access.

## Extraction Targets

For each candidate listing, extract as many of these as possible from the search results card or listing preview:
- URL
- address
- city
- platform
- list price
- beds and baths
- square footage
- days on site or listing age

## Filtering Rules

Filter early using available card data:
- price inside configured range
- at least the minimum beds
- at least the minimum square footage when shown
- listing age inside the configured window when shown
- single-family or house style preferred over townhome or condo when the source makes that clear

If a value is missing on the card, keep the listing as a candidate instead of discarding it immediately.

## Deduplication

Deduplicate against:
- `data/scan-history.tsv` by URL
- `data/pipeline.md` by URL
- `data/listings.md` by normalized address and city

## Verification Rules

- Search-result cards from platform URLs are good enough to add to the pipeline.
- WebSearch results must be verified before adding to the pipeline.
- If a listing is clearly sold, pending, or off market, record it as skipped.

## Pipeline Format

Add new entries to the `Pending` section in this format:

`- [ ] {url} | {platform} | {area} | {address} | ${price}`

If address or price is unknown, omit only that field and keep the rest.

## Scan History Format

Prefer this TSV column order when appending new history rows:

`url\tfirst_seen\tplatform\tarea\taddress\tstatus`

Use these statuses:
- `added`
- `skipped_dup`
- `skipped_filtered`
- `skipped_sold`
- `skipped_blocked`

## Output Summary

Return a concise summary with:
- platforms scanned
- candidate listings found
- duplicates skipped
- filtered-out listings
- listings added to the pipeline
- any login or anti-bot blockers

If no new listings qualify, say so directly.
