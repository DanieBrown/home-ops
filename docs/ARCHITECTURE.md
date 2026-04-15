# Architecture

## System Overview

Home-ops is a local decision-support system for home search. The active workflow has five modes:

- `evaluate`: review one listing against buyer requirements
- `compare`: rank several homes side by side
- `scan`: collect new listings from configured portal URLs
- `tracker`: manage the canonical markdown tracker
- `deep`: research schools, neighborhood sentiment, and development risk

All modes read the shared operating rules from `modes/_shared.md`, then apply buyer-specific guidance from `modes/_profile.md` and `config/profile.yml`.

## Core Data Flow

```text
buyer-profile.md         -> narrative buyer brief
config/profile.yml       -> hard requirements, weights, finance assumptions
modes/_profile.md        -> buyer-specific prompt overrides
portals.yml              -> listing sources and login requirements
data/pipeline.md         -> pending listing inbox
data/listings.md         -> canonical tracker
reports/*.md             -> per-listing evaluation reports
templates/states.yml     -> canonical status model
```

## Evaluation Flow

1. Verify the listing is active when possible.
2. Extract structured facts from the listing page.
3. Apply the hard requirement gate.
4. Research neighborhood sentiment.
5. Review assigned schools and school sentiment.
6. Check development, infrastructure, flood, and risk signals.
7. Estimate financial fit using the buyer profile.
8. Score the listing from 1.0 to 5.0.
9. Save a markdown report and update `data/listings.md`.

## Scan Flow

The scan mode reads `portals.yml` and uses Playwright-backed browsing plus web research fallbacks to discover candidate listings. Qualified results go into:

- `data/pipeline.md` for pending follow-up
- `data/scan-history.tsv` for deduplication and scan history

## Tracker Model

The tracker is a markdown table in `data/listings.md` with these columns:

`# | Date | Address | City | Price | Beds/Baths | SqFt | Score | Status | Report | Notes`

Canonical statuses come from `templates/states.yml` and currently cover:

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

## Maintenance Scripts

| Script | Purpose |
|--------|---------|
| `doctor.mjs` | Validates required files and creates missing system directories |
| `profile-sync-check.mjs` | Checks buyer-layer consistency |
| `verify-pipeline.mjs` | Validates tracker rows, links, statuses, and duplicates |
| `normalize-statuses.mjs` | Normalizes status aliases to canonical states |
| `dedup-tracker.mjs` | Removes duplicate listings keyed by address and city |
| `merge-tracker.mjs` | Merges staged tracker additions into `data/listings.md` |
| `check-liveness.mjs` | Uses Playwright to verify listing activity |

## Dashboard

The `dashboard/` folder contains a Go terminal UI for the listing tracker.

Current behavior:

- Reads `data/listings.md`
- Groups listings by canonical status
- Shows score, address, city, price, and core facts
- Opens markdown reports from `reports/`
- Opens the original listing URL when the report header includes one
- Lets the user update tracker status inline
