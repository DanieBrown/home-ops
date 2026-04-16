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
- `output/browser-sessions/chrome-host/session-state.json` if it exists
- `batch/logs/browser-sessions.tsv` if it exists

## Goal

Discover newly listed homes in the configured NC search areas that appear to meet Daniel's hard requirements.

## Scan Strategy

Use a layered approach:

1. Platform search URLs from `portals.yml`.
2. Listing-card extraction from Zillow, Redfin, and Realtor.com.
3. WebSearch fallback queries only when platform pages are blocked or incomplete.

## Platform Filter Flags

If the command arguments include any of these flags, treat them as a platform filter only:

- `--zillow`
- `--redfin`
- `--relator`

Treat `--realtor` as a backward-compatible alias, but prefer `--relator` in commands and documentation.

When any of those flags are present:
- Scan only the selected platforms.
- Reuse the existing hosted session when available.
- Reuse and refresh any matching hosted-browser search tab for that platform URL before extracting cards.
- If a selected platform needs login and there is no usable hosted session, stop and tell the user to run `/home-ops init {matching flags}` first.
- Each selected platform should fill up to 3 pending homes per configured area.
- Use the current search results to refill those area buckets even when the URLs appeared in older scan history.
- If Zillow blocks with a sign-in, press-and-hold, or similar human-verification prompt, pause the scan immediately, request the user to sign in or clear the prompt, and do not continue to later areas or other platforms until the user confirms access.

For platforms that reject automated sign-in or keep surfacing anti-bot prompts, prefer the hosted real-Chrome path over the Playwright-managed browser path.

When no platform flags are present:
- Reuse the existing saved session when available.
- Scan all configured platforms unless the user explicitly narrows the scope some other way.

## Login Rules

- Respect `login_required` entries in `portals.yml`.
- Do not bootstrap browser sessions from scan mode. Session setup belongs to `/home-ops init`.
- If the session is not logged in, stop and prompt the user using the platform's `login_prompt`.
- If a refreshed search tab shows Zillow press-and-hold or a similar human-verification prompt, bring that tab to the front and tell the user to clear it in the hosted browser before rerunning the scan.
- Zillow sign-in or verification blockers are a hard stop for the scan command. Pause and request manual sign-in confirmation before continuing.
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
- `data/pipeline.md` by URL and normalized home identity within the same source
- `data/listings.md` by normalized address and city

Rules:
- When the same home appears more than once on the same source, keep the first accepted pending entry and skip later duplicates even if the home appears under another configured area for that same source.
- The pending list may contain Zillow, Redfin, and Realtor.com variants of the same home at the same time.
- `data/scan-history.tsv` is still written for audit and status tracking, but it should not block area-bucket refills.
- When the pending list already contains duplicate URLs or same-source duplicates from older scans, remove those duplicates before filling new scan slots.

## Per-Source Per-Area Pending Cap

Keep at most 3 unchecked pending listings per configured source per configured area.

Rules:
- If a scan starts and a source-area bucket already has 3 or more unchecked pending entries, clear that source-area bucket first and refresh it with current scan results for that source and area.
- If a source-area bucket has fewer than 3 unchecked pending entries, keep them and add only enough new listings from that source and area to reach the 3-list cap.
- Apply the cap independently to each configured area within each source.

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
- per-source cap applied and any sources refreshed before scanning
- any session bootstrap actions taken
- candidate listings found
- duplicates skipped
- filtered-out listings
- listings added to the pipeline
- any login or anti-bot blockers

If no new listings qualify, say so directly.
