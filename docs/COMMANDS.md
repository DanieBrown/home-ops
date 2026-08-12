# Home-Ops Command Reference

Every `npm run` script in `package.json`, grouped by what it is for.

Most of the time you do not run these directly — you use the `/home-ops` modes
(see [`CLAUDE.md`](../CLAUDE.md)) and the mode calls the right runner. This
reference exists for the times you need to run one step by hand, and so the
whole surface is discoverable instead of half-hidden.

**Flags:** every user-facing script answers `--help` (or `-h`) with its full
flag list. The flags below come from that help text, which is the source of
truth. When in doubt:

```bash
node scripts/<path>/<script>.mjs --help
```

**Passing flags through npm:** npm needs `--` before script arguments.

```bash
npm run scan -- --redfin
npm run hazards:check -- --shortlist
```

**Aliases:** several names point at the same script. The canonical name is
listed first and its aliases are noted on the same row; they are the same
capability, not different ones.

`scripts/system/doctor.mjs` fails if a `package.json` script is missing from
this file, so this reference cannot quietly rot.

---

## Setup and health

| Command | Runs | What it does |
|---------|------|--------------|
| `bootstrap` | `scripts/system/bootstrap.mjs` | Install Node dependencies and the Playwright browser binaries. |
| `bootstrap:python` | `scripts/system/bootstrap.mjs --python --install-python` | Also install the optional crawl4ai Python sidecar used for school metadata. |
| `doctor` | `scripts/system/doctor.mjs` | Full setup validation: Node version, dependencies, Playwright, crawl4ai, hosted browser, buyer-layer files, mode files, writable directories, leftover scratch, portal coverage, and this command reference. Exits 1 on a failure. |
| `sync-check` | `scripts/config/profile-sync-check.mjs` | Check the buyer layer is consistent: `buyer-profile.md` is real, `config/profile.yml` is no longer the example, `modes/_shared.md` carries no buyer criteria, and `portals.yml` exists. |
| `temp:check` | `scripts/system/temp-artifact-check.mjs` | Fail if scratch files older than 24 hours are still sitting under `.home-ops/tmp/`. |
| `test` | `scripts/system/test-all.mjs` | The repository test suite: syntax checks, script smoke tests, unit and fixture tests, data-contract validation. `--quick` skips the extended build checks. |
| `portals:generate` | `scripts/config/generate-portals.mjs` | Regenerate `portals.yml` and the `output/*-sources.json` inventories from `config/profile.yml` + `config/city-registry.yml`. Rerun after any search-area or research-source change. |

## Updates and rollback

The update subsystem only ever touches system files (`modes/`, `scripts/`,
`templates/`, `docs/`, `CLAUDE.md`, `VERSION`, …). The buyer layer
(`buyer-profile.md`, `config/profile.yml`, `modes/_profile.md`, `portals.yml`,
`data/`) is never modified, and `update` aborts and hard-resets if it detects
otherwise.

| Command | Runs | What it does |
|---------|------|--------------|
| `update:check` | `scripts/system/update-system.mjs check` | Compare local `VERSION` against upstream. Prints JSON: `up-to-date`, `update-available`, `offline`, `disabled`, or `dismissed`. |
| `update` | `scripts/system/update-system.mjs apply` | Create a `backup-pre-update-*` branch, fetch upstream, check out system paths only, verify no buyer file changed, then report the new version. |
| `rollback` | `scripts/system/update-system.mjs rollback` | Restore system files from the most recent backup branch. |

Upstream comes from a git remote named `upstream`, or from the
`HOME_OPS_UPSTREAM_FETCH_TARGET` and `HOME_OPS_UPSTREAM_VERSION_URL`
environment variables. `node scripts/system/update-system.mjs dismiss` silences
the check until the next apply.

## Hosted browser session

Portals block generic headless browsers. Home-Ops drives one long-lived Chrome
session over CDP instead; these commands manage it.

| Command | Runs | What it does |
|---------|------|--------------|
| `browser:setup` *(aliases: `init`, `browser:init`)* | `bootstrap` + `browser-session.mjs configured --hosted --channel chrome` | Bootstrap and launch the hosted Chrome session for portal login. |
| `browser:setup:edge` | same, with `--channel msedge --profile edge-host` | The same, using Edge under the `edge-host` profile. |
| `browser:status` | `browser-session.mjs --status --profile chrome-host` | Report whether the hosted session is alive and CDP is reachable. |
| `browser:session` | `browser-session.mjs` | Lower-level session control. `--help` lists the subcommands. |
| `browser:refresh` | `refresh-site-data.mjs` | Clear one portal's client-side browser state and open a clean homepage. Takes a platform selector: `--zillow`, `--redfin`, `--relator`, `--homes`. |
| `browser:review` *(aliases: `review-tabs`, `review:tabs`)* | `review-tabs.mjs` | Open a tab group in the hosted session: `shortlist-top10`, `shortlist-top3`, or `urls <url> …`. `--replace` closes the existing tabs first. |
| `review-tabs-top3` *(alias: `review:tabs-top3`)* | `review-tabs.mjs shortlist-top3 --replace` | Shorthand for replacing tabs with the refined top 3. |
| `liveness` | `check-liveness.mjs` | Check whether tracked listings are still active. |
| `skim` | `skim-portals.mjs` | Open pre-filtered search tabs for every configured portal for a quick visual browse. |
| `afford:open` | `open-url-in-hosted-session.mjs --url http://127.0.0.1:4179/` | Open the affordability wizard in the hosted session. |

## Buyer profile and affordability

| Command | Runs | What it does |
|---------|------|--------------|
| `profile:wizard` | `tools/profile-wizard/serve.mjs` | Serve the interactive buyer-profile wizard. |
| `profile:wizard:once` | `… --once` | Serve it, then exit after the first submission. |
| `afford:wizard` | `tools/afford-wizard/serve.mjs` | Serve the affordability wizard. |
| `afford:wizard:once` | `… --once` | Serve it, then exit after the first submission. |
| `afford:calculate` | `calculate-affordability.mjs` | Compute a conservative affordability range. `--input`, `--output`, `--target-price`, `--no-fetch-rates`. |
| `afford:apply` | `apply-affordability.mjs` | Write a calculated price range back into `config/profile.yml`. |

## Scan and evaluate

| Command | Runs | What it does |
|---------|------|--------------|
| `scan` | `scan-listings.mjs` | Scan configured portal searches for new listings into `data/pipeline.md`. Platform selectors: `--zillow`, `--redfin`, `--realtor` / `--relator`, `--homes`, `--no-zillow`; `--profile <name>`. |
| `scan:verify` | `verify-pipeline-write.mjs` | Confirm a scan actually persisted to `data/pipeline.md`, waiting on a running scan's PID if needed. |
| `evaluate:pending` *(alias: `evaluate`)* | `evaluate-pending.mjs` | Batch-evaluate every pending listing in the pipeline and stage tracker rows. |
| `extract:listing` | `extract-listing-details.mjs` | Scrape one listing's facts into `output/listings/{slug}.json`. `--url <listing-url>` or a positional URL; `--profile`, `--json`. |
| `hunt:sequential` | `hunt-runner.mjs` | Hunt phases 1–7 in order: reset, verify, scan, scan:verify, evaluate:pending, merge, audit:research. Forwards boolean platform flags to scan. |

## Tracker

`data/listings.md` is the source of truth. A single listing should appear once.

| Command | Runs | What it does |
|---------|------|--------------|
| `merge` *(aliases: `merge-tracker`, `merge:tracker`)* | `merge-tracker.mjs` | Merge staged TSVs from `batch/tracker-additions/` into the tracker, deduplicating by report number, row number, then address + city. `--dry-run`, `--verify`. |
| `verify` | `verify-pipeline.mjs` | Pipeline health check: row format, canonical statuses, duplicate addresses, resolvable report links, score format, pending TSVs. |
| `normalize` | `normalize-statuses.mjs` | Normalize the Status column against `templates/states.yml`. `--dry-run`. |
| `dedup` | `dedup-tracker.mjs` | Remove duplicate rows, keeping the most advanced status, highest score, and merged notes. `--dry-run`. |

## Deep research — single home

| Command | Runs | What it does |
|---------|------|--------------|
| `deep:single` | `deep-single-runner.mjs` | Pre-evaluation capture for one listing: listing facts + assigned schools. `--url <listing-url>`, `--profile`. |
| `deep:single-final` | `deep-single-final-runner.mjs` | Post-evaluation capture chain against the written report: source plan, community, sentiment (browser + public), construction, county permits, site hazards, parcel/tax, access, builder, school metadata, HOA docs, utilities, then the research packet. `--report <path>`, `--profile`. |
| `axis:write` | `axis-sidecar-write.mjs` | Validate the merged axis-agent JSON and persist it to `output/axis/{slug}.json`. `--report <path>`, `--input <merged.json>`, `--json`. |
| `brief:single` | `briefing-pdf.mjs --report` | Render the single-home briefing PDF and open it as a hosted tab. |

## Deep research — shortlist batch

| Command | Runs | What it does |
|---------|------|--------------|
| `hunt:deep` | `hunt-deep-runner.mjs` | Deep prep phases 1–4 across the shortlist: source plan, community, browser sentiment, construction, public sentiment, utilities, site hazards, parcel/tax, access, then one research packet per home. |
| `hunt:deep-final` | `hunt-deep-final-runner.mjs` | Deep finalization phases 5–8: promote finalists, run the gate, replace tabs with the top 3, render the briefing PDF. |
| `promote:finalists` | `promote-finalists.mjs` | Rank the shortlist top 10 and write the best three into the Refined Top 3 section. |
| `gate:finalists` *(alias: `finalist-gate`)* | `shortlist-finalist-gate.mjs` | Gate the finalists on research completeness. `--allow-warnings`, `--json`. |
| `brief:top3` *(alias: `briefing-pdf`)* | `briefing-pdf.mjs` | Render the top-3 briefing PDF. `--report <path>` for one home, `--reports a.md,b.md` combined, `--no-open`. |

## Research capture

Each of these writes a JSON sidecar under `output/`. All take a positional
report path for one home, `--shortlist` for the current top 10, or `--top3`
for the refined finalists.

| Command | Runs | Sidecar | What it captures |
|---------|------|---------|------------------|
| `audit:research` *(alias: `research:audit`)* | `research-coverage-audit.mjs` | — | Which shortlisted reports have weak or missing evidence. `--strict`. |
| `plan:research` *(alias: `research:source-plan`)* | `research-source-plan.mjs` | `output/source-plan/` | Concrete per-home lookup plan from `portals.yml`. `--type all\|development\|school\|sentiment`. |
| `lookup:community` | `community-lookup.mjs` | `output/communities/` | Resolve an address to its named community, the key for Nextdoor/Facebook URLs. `--profile`. |
| `extract:sentiment` *(alias: `sentiment:extract`)* | `sentiment-browser-extract.mjs` | `output/sentiment/` | Facebook and Nextdoor evidence via the hosted session. `--profile`, `--concurrency`, `--quick`. |
| `sentiment:public` | `sentiment-public-extract.mjs` | `output/sentiment/` | Google Maps public sentiment (the `traffic_commute` source). `--profile` routes through the hosted session to read the Reviews tab instead of place cards; without it, falls back to crawl4ai/fetch. |
| `sentiment:doctor` | `sentiment-doctor.mjs` | — (reads only) | Per-source coverage diagnostic: opted-in in the profile, present in the plan, attempted, status, snippet count, and the exact field that caused any skip. |
| `check:construction` *(alias: `construction:check`)* | `construction-check.mjs` | `output/construction/` | NCDOT projects near the home. `--quick`. |
| `permits:check` | `county-permits-check.mjs` | `output/permits/` | County GIS permits and development cases within 5 miles. `--radius <m>`. |
| `permits:discover` | `county-services-discover.mjs` | `output/county-sources.json` | Probe a county's ArcGIS catalog for usable services. `--all`, `--county <name>`, `--base-url <url>`. |
| `hazards:check` | `site-hazards-check.mjs` | `output/hazards/` | FEMA flood zone and SFHA flag, wetlands, county radon zone, EPA superfund/brownfield sites, septic soil suitability, RDU noise contours. `--radius <m>`, `--no-network`. |
| `parcel:check` | `parcel-tax-check.mjs` | `output/parcel/` | Parcel ID, acreage, assessed land/improvement value, last sale, estimated annual tax, zoning, guided future-land-use link. `--no-network`. |
| `access:check` | `access-check.mjs` | `output/access/` | Nearest NCDOT AADT count station (route, volume, distance), busy-road exposure, measured drive times, guided sex-offender and redistricting checks. `--profile`, `--no-drive-times`, `--no-network`. |
| `schools:assignments` | `school-assignments-fetch.mjs` | `output/school-metadata/` | Assigned schools from district and listing sources. `--address`/`--city`, or `--listing`. |
| `schools:metadata` | `school-metadata-fetch.mjs` | `output/school-metadata/` | Per-school ratings, enrollment, and demographics. `--profile`. |
| `hoa:docs` | `hoa-docs-check.mjs` | `output/hoa/` | Public HOA documents, dues, and rules. `--url`, `--listing`, `--address`/`--city`, `--community`, `--update-report`. |
| `utilities:check` *(alias: `utility-options:check`)* | `utility-options-check.mjs` | `output/utilities/` | Electric, water/sewer, gas, and internet provider options and billing estimates. `--no-network`. |
| `geocode` | `geocode.mjs` | `output/geocode/` | Resolve and cache coordinates for an address. |
| `prepare:deep` | `deep-research-packet.mjs` | `output/deep-packets/` | Assemble every sidecar into one research packet per home, behind an address match. |

All capture scripts accept `--json` for machine-readable output and fail soft:
an unreachable source is recorded as `blocked` in the sidecar's
`sourceCoverage` and the script still exits 0. **`blocked` means the source
could not be reached, which is not the same as "nothing found"** — see
[`DATA_CONTRACT.md`](../DATA_CONTRACT.md).

## Reset and caches

| Command | Runs | What it does |
|---------|------|--------------|
| `reset:data` | `reset-search-state.mjs` | Clear generated search state — reports, tracker rows, pipeline, scan history, axis/briefings/packets — while preserving the buyer layer and every learned sidecar. `--dry-run`, `--purge-knowledge`. |
| `cache:stats` | `cache-utils.mjs --stats extraction` | Listing-extraction cache statistics. |
| `cache:clear` | `cache-utils.mjs --clear extraction` | Clear the listing-extraction cache. |
| `cache:sentiment:stats` | `cache-utils.mjs --stats sentiment` | Sentiment cache statistics. |
| `cache:sentiment:clear` | `cache-utils.mjs --clear sentiment` | Clear the sentiment cache. |

`reset:data` preserves `output/knowledge/`, `output/areas/`, and every learned
sidecar directory. Only `--purge-knowledge` removes learned facts.
