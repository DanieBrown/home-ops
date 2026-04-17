# Architecture

## System Overview

Home-ops is a local decision-support system for home search. The active workflow has eight modes:

- `profile`: interview the buyer and update the buyer-layer files
- `init`: launch or confirm the hosted browser session for portal login
- `hunt`: run reset, then scan, then evaluate in one sequential workflow
- `evaluate`: review one listing against buyer requirements, or batch-evaluate pending pipeline homes when no target is supplied
- `compare`: rank several homes side by side
- `scan`: collect new listings from configured portal URLs
- `tracker`: manage the canonical markdown tracker
- `deep`: research schools, neighborhood sentiment, and development risk

All modes read the shared operating rules from `modes/_shared.md`, then apply buyer-specific guidance from `modes/_profile.md` and `config/profile.yml`.

## Profile Flow

The profile mode uses an interactive questionnaire to refresh the buyer-layer files.

Expected behavior:

1. Ask the buyer for identity, areas, hard requirements, soft preferences, deal-breakers, commute, and financial assumptions.
2. Ask 0-100 importance questions for the neighborhood and school weighting factors.
3. Normalize those raw scores into `config/profile.yml` weights.
4. Update `buyer-profile.md`, `config/profile.yml`, and `modes/_profile.md`.
5. Run `profile-sync-check.mjs`.

The normalized weights currently influence agent judgment and research emphasis. They are not yet backed by a separate deterministic scoring engine that consumes structured neighborhood, school, and development source records.

## Hunt Flow

The hunt mode is a sequential orchestrator around the existing workflows.

Expected behavior:

1. Confirm that the hosted browser session from `init` is already open and reusable.
2. Run `reset` to clear generated state while preserving buyer files and browser sessions.
3. Run `scan` to refill the pipeline with fresh candidates.
4. Run `evaluate` with no explicit target against that refreshed pipeline.
5. Report the combined outcome.

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
10. Audit the generated report with `research-coverage-audit.mjs` when you need to confirm whether neighborhood, school, and development evidence was actually sourced.

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
2. Evaluate with no explicit target can write up to the top ten viable homes into `data/shortlist.md` as the latest saved review cohort, and compare can overwrite that same file with a comparison-derived top ten.
3. Deep reads that current shortlist file when the user asks for a batch deep dive on the saved top ten.
4. Deep can run a hosted-browser Facebook and Nextdoor extraction pass against that shortlist before the worker research begins.
5. Deep launches one subagent per shortlisted home, writes a combined brief such as `reports/deep-shortlist-{YYYY-MM-DD}.md`, and keeps the final rerank in the main agent.
6. Deep reruns the compare framework on that shortlisted set using the new research, updates `data/shortlist.md` with the refined top three, validates them with `shortlist-finalist-gate.mjs`, and only then opens the refined finalists in separate browser tabs.

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
| `research-coverage-audit.mjs` | Audits evaluation reports for explicit neighborhood, school, and development evidence coverage |
| `sentiment-browser-extract.mjs` | Reuses the hosted browser session over CDP and captures deterministic Facebook and Nextdoor sentiment evidence into `output/sentiment/` |
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
