# Design: Portal Extractor Coverage — homes.com & realtor.com

**Date:** 2026-05-04  
**Status:** Approved  
**File:** `scripts/research/extract-listing-details.mjs`

---

## Problem

`extractHomes()` returns all-null output because `pickJsonLdResidence()` does not handle the `@graph` wrapper structure that homes.com uses. `extractRealtor()` works partially but misses `listingAgent`, `mls`, and precise bath counts. Both gaps mean downstream scripts (school-metadata, builder-check, source-plan) anchor on incomplete ground truth.

The existing `buildEmptyListing()` schema is already the correct common data model. The goal is to make all portal extractors fill it as completely as their source data allows.

---

## Scope

Single file: `scripts/research/extract-listing-details.mjs`. No new files. No schema changes.

Out of scope: Zillow and Redfin gaps (garage, builder, agent, MLS) — those fields are not exposed in their structured data and DOM scraping would be fragile.

---

## Architecture

All four extractors share the same pipeline:

```
page → portal-specific extractor → { findings, notes }
                                          ↓
                              merge into buildEmptyListing()
                                          ↓
                              scoreConfidence() → output JSON
```

The fix keeps this pipeline unchanged. Only the internals of the shared `pickJsonLdResidence()` function and the `extractHomes()` / `extractRealtor()` functions change.

---

## Changes

### 1. `pickJsonLdResidence(items)` — @graph unwrap (shared, ~5 lines)

**Problem:** homes.com emits a single top-level JSON-LD object with `@graph` + `@context` but no `@type`. The current loop checks `@type` on top-level items and misses everything.

**Fix:** Before the type-scan loop, check each item for a `@graph` array. If found, append those inner items to the scan list. The existing type-check then finds `SingleFamilyResidence` inside `@graph`.

```
if (item['@graph'] && !item['@type']) {
  expand @graph items into scan list
}
```

This is additive — it does not change how any other portal's JSON-LD is parsed.

---

### 2. `fromJsonLdResidence(item)` — agent + listing date from offers

**Additions:**
- `listingAgent` from `item.offers[0].offeredBy[0].name` (homes.com populates this)
- `daysOnMarket` computed from `item.datePosted` ISO string (days since listing date)

Both are conditional — only populated when the fields are present. No existing field reads change.

---

### 3. `extractHomes(page)` — full rewrite

**Primary source: JSON-LD** (now works via fix #1 above)

Covers: address, city, state, zip, price, beds, sqftFinished, yearBuilt, listingAgent, listingStatus, daysOnMarket.

**Gap: baths** — JSON-LD gives integer (e.g. `4`); DOM gives precise fractional (e.g. `4.5`). DOM value preferred.

**Secondary source: DOM section parser** via `page.evaluate()`

homes.com renders property details as `<h3>Section Name</h3>` followed by a sibling `.amenities-list` or `.property-info-feature-detail` element. The DOM pass scans for these section headers and extracts:

| Section header | Field | Parse rule |
|---|---|---|
| HOA Fees | `hoaMonthly` | Strip `$`, `/mo` → number |
| Parking | `garage` | Extract leading integer from "3 Car Attached" |
| Lot Details | `lotSqft` | Strip commas, "sqft" → number |
| Community Details | `communityName` | Text of first list item |
| MLS | `mls` | Text after "MLS#" label |
| Schools | `assignedSchools` | `<ul>` items, classify by level keyword |

**Baths DOM pass:** query `.property-info-feature-detail` elements near the beds/baths summary block; parse "4.5 Ba" → `4.5`.

**Merge rule:** DOM values win over JSON-LD for baths; JSON-LD wins for all other fields where both exist.

**Confidence:** `high` when JSON-LD address + price + beds + DOM baths all present; `medium` when only JSON-LD layer succeeded; `low` otherwise.

---

### 4. `extractRealtor(page)` — additive only

No existing reads removed. Three additions to the existing `__NEXT_DATA__` block:

| Field | Source path |
|---|---|
| `listingAgent` | `advertisers[0].name` |
| `mls` | `advertisers[0].mls_set[0]?.id ?? advertisers[0].mls_set[0]?.listing_id` |
| `baths` (precise) | `description.baths_full + 0.5 * (description.baths_half ?? 0) + 0.5 * (description.baths_3qtr ?? 0)` — used only when more precise than the existing `baths_consolidated` read |
| `daysOnMarket` | Computed from `listing.list_date` ISO string when `days_on_market` is null |

---

## Field Coverage After Changes

| Field | Zillow | Redfin | Realtor | Homes |
|---|---|---|---|---|
| address / city / state / zip | ✅ | ✅ | ✅ | ✅ |
| price | ✅ | ✅ | ✅ | ✅ |
| beds | ✅ | ✅ | ✅ | ✅ |
| baths (precise) | ~ | ~ | ✅ | ✅ |
| sqftFinished / yearBuilt | ✅ | ✅ | ✅ | ✅ |
| lotSqft | ✅ | ✅ | ✅ | ✅ |
| garage | ❌ | ❌ | ✅ | ✅ |
| hoaMonthly | ✅ | ❌ | ✅ | ✅ |
| builderName | ❌ | ❌ | ✅ | ✅ |
| communityName | ❌ | ❌ | ✅ | ✅ |
| listingAgent | ❌ | ❌ | ✅ | ✅ |
| mls | ❌ | ❌ | ✅ | ✅ |
| daysOnMarket | ✅ | ✅ | ✅ | ✅ |
| assignedSchools | ✅ | ✅ | ✅ | ✅ |
| listingStatus | ✅ | ✅ | ✅ | ✅ |

Zillow/Redfin gaps are structural — those portals do not expose agent, MLS, builder, or garage in their structured data sources.

---

## Error Handling

- Each extractor already catches and logs parse errors to `notes[]` — no change to this pattern.
- DOM section parser is wrapped in `try/catch`; failure pushes a note and returns empty DOM findings rather than crashing the extractor.
- Missing `advertisers` array on realtor.com (e.g. FSBO listings) is guarded with optional chaining.

---

## No Breaking Changes

- `buildEmptyListing()` schema unchanged.
- `PORTAL_EXTRACTORS` dispatch table unchanged.
- Output JSON shape unchanged — confidence scoring picks up improved field presence automatically.
- Downstream scripts (`school-metadata-fetch.mjs`, `builder-check.mjs`, etc.) read the same fields they read today.
