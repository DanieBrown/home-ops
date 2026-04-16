# Architecture

## System Overview

Home-ops is a local decision-support system for home search. The active workflow has six modes:

- `init`: launch or confirm the hosted browser session for portal login
- `evaluate`: review one listing against buyer requirements, or batch-evaluate pending pipeline homes when no target is supplied
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
data/shortlist.md        -> latest compare top-10 tags and deep handoff state
batch/tracker-additions/ -> staged tracker rows for batch merges
data/listings.md         -> canonical tracker
reports/*.md             -> per-listing evaluation reports and deep shortlist briefs
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

When `evaluate` is invoked with no explicit listing target, the mode should switch to a pipeline-batch branch:

1. Read unchecked entries from `data/pipeline.md`.
2. Deduplicate the same property across portal URLs by normalized address + city.
3. Split the canonical property set into worker slices of up to 5 properties each.
4. Assign one subagent per 5-property slice, while keeping browser-backed verification serialized across the run.
5. Stage tracker additions in `batch/tracker-additions/`.
6. Merge the staged results into `data/listings.md` with `merge-tracker.mjs`.
7. Move handled items to the `Processed` section of `data/pipeline.md`.

## Scan Flow

The scan mode reads `portals.yml` and uses Playwright-backed browsing plus web research fallbacks to discover candidate listings. Qualified results go into:

- `data/pipeline.md` for pending follow-up
- `data/scan-history.tsv` for deduplication and scan history

If the scan command includes platform flags such as `--zillow`, `--redfin`, or `--relator`, the workflow should use those flags only to narrow scan scope. Session setup should happen separately through `init`, which records the lifecycle in `batch/logs/browser-sessions.tsv` and updates `output/browser-sessions/<profile>/session-state.json`.

## Init Flow

The init mode reads `portals.yml`, checks the hosted browser session state, and either reuses the existing hosted session or launches a new one for the selected platforms. The user signs in manually once, keeps the hosted browser running, and then scan or verification flows attach over CDP later.

## Compare And Deep Handoff

The compare mode can persist a ranked shortlist into `data/shortlist.md`.

Expected behavior:

1. Compare ranks the current evaluated set.
2. Compare writes up to the top ten viable homes into `data/shortlist.md` with stable rank tags and opens those listing URLs in separate browser tabs for review.
3. Deep can then read that shortlist file when the user asks for a batch deep dive on the current shortlist.
4. Deep writes a combined brief such as `reports/deep-shortlist-{YYYY-MM-DD}.md`.
5. Deep reruns the compare framework on that shortlisted set using the new research, updates `data/shortlist.md` with the refined top three, and opens the refined finalists in separate browser tabs.

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
| `browser-session.mjs` | Opens either a Playwright-managed persistent profile or a hosted real-Chrome profile, derives targets from `portals.yml`, and records repo-local session state |
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
