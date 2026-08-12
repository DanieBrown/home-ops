# Goal Prompt — Complete the Deep Analysis Snapshot

**Status:** ready to execute
**Written:** 2026-08-11
**Repo:** `home-ops`
**Audience:** a fresh Claude Code session working in this repository

---

## How to use this file

This is a self-contained work order. You do not need the conversation that produced it.

Run it **one phase per session**. Each phase has entry criteria, tasks, a verification command, and exit
criteria. Do not start a phase until the previous phase's exit criteria pass. The phase order is a real
dependency chain, not a preference — Phase 1 hardens the mechanism that Phases 2 and 3 rely on.

To begin, tell the session:

> Read `docs/GOAL-PROMPT-deep-snapshot.md` and execute Phase 1.

If Superpowers skills are available, use `superpowers:test-driven-development` for every new script and
`superpowers:verification-before-completion` before claiming any phase is done.

---

## 1. The problem this solves

Home-Ops scores homes on a weighted model defined in `modes/_shared.md`. Four of its scoring rules grade
dimensions **that no capture script feeds**. The model asks a question the pipeline cannot answer, so the
answer is either blank or inferred from whatever prose the listing agent happened to write.

| Scoring rule | Declared at | What actually feeds it today |
|---|---|---|
| "Flood-zone exposure … caps at 2.2 unless disproven" | `modes/_shared.md:144` | `floodRisk: /flood zone\|floodplain\|drainage/i.test(text)` — `scripts/pipeline/evaluate-pending.mjs:1689`. A regex over listing marketing copy. No authoritative flood source is ever queried. |
| "major road adjacency … caps at 2.2" | `modes/_shared.md:144` | `busyRoadRisk: /busy road\|cut-through\|high traffic\|.../i.test(text)` — `scripts/pipeline/evaluate-pending.mjs:1688`. Same pattern. No traffic-volume data. |
| Financial Fit (weight 0.10) includes "taxes" | `modes/_shared.md:127` | Nothing. There is no parcel, assessment, or tax capture anywhere in the repo. |
| Resale / Risk (weight 0.15) includes "flood risk" and "busy-road exposure" | `modes/_shared.md:128` | Same two regexes above. |

This is a correctness problem, not a cosmetic one. `modes/_shared.md:36` forbids inventing flood status, and
`modes/_shared.md:343` forbids inventing taxes — both correct rules. The result is that a home in a FEMA
Special Flood Hazard Area whose listing text never says "flood" scores identically to one on high ground.
The cap at `_shared.md:144` says "unless disproven", but nothing in the pipeline can prove or disprove it.

Two secondary problems compound it:

- **Contract gates are bypassable.** Gates whose regex matches a bare script name are satisfied by running
  that script with `--help`, which exits 0 without doing any work.
- **The command surface is substantially undocumented.** 50 of the 78 npm scripts appear in no user-facing
  documentation, including an entire update/rollback subsystem.

**Goal:** every dimension the report scores or displays is backed by a real, cited, provenance-tagged source
— or is explicitly marked `unconfirmed`. No dimension silently reads as "clear" because it was never checked.

---

## 2. Non-negotiable rules

These override any convenience shortcut. They come from `CLAUDE.md`, `DATA_CONTRACT.md`, and `modes/_shared.md`.

1. **Never invent a fact.** Missing data is `unconfirmed` or `missing-input`, never a default value and never
   an inference presented as a finding. A source that was unreachable is `blocked`, which is *not* the same
   as "no hazard found". Rendering must keep those three states visually distinct.
2. **Respect terms of service and anti-bot limits.** Where a source has no public API, produce an official
   link plus buyer-facing "how to check this home" instructions. Do not scrape it. This applies with
   particular force to the sex-offender registry (Section 5, D-2).
3. **Honor the data contract.** New sidecars under `output/` are durable user-layer data
   (`DATA_CONTRACT.md:24-40`). Add each new directory to the durable list in `DATA_CONTRACT.md` so
   `reset:data` preserves it. Scratch files go in `.home-ops/tmp/{commandId}/` and are deleted after use.
4. **Sidecar metadata is mandatory.** Every new sidecar carries `schemaVersion`, `scope`, `subjectKey`,
   `commandId`, `generatedAt`, `sourceUrls`, `status`, `warnings`, and a `sourceCoverage` array whose entries
   use `captured` / `blocked` / `unsupported` / `skipped-by-profile` / `missing`. Readers must tolerate older
   sidecars missing these fields (`DATA_CONTRACT.md:40`).
5. **Address match before consume.** A sidecar must match the report address before any renderer or packet
   uses it — the rule already stated for utilities at `DATA_CONTRACT.md:44`. Apply it to all three new sidecars.
6. **Tests first.** Every new script gets a test with a recorded fixture *before* implementation, registered
   in `scripts/system/test-all.mjs`. See Section 6.
7. **No new network calls from axis agents.** Axis agents remain sidecar-first. `WebFetch`, `WebSearch`, and
   launching a new browser stay forbidden (`modes/deep.md:39`).

---

## 3. Phase 1 — Integrity hardening

**Do this first.** Phase 2 adds new contract gates. If the gate mechanism is still bypassable when you add
them, you mint five more bypassable gates.

### Entry criteria
- `npm run test` passes on a clean tree.
- Working tree is clean, or you are on a dedicated branch.

### Task 1.1 — Close the `--help` gate bypass

`scripts/hooks/contract-shared.mjs` gates a step by regex-matching the Bash command string. Patterns that
match a bare script name are satisfied by `node <script> --help`, which exits 0 having done nothing. The
`axis-sidecar` gate got this right by requiring an argument:

```js
req('axis-sidecar', '...', [
  /axis-sidecar-write\.mjs[^\n]*--report\b/,     // ← requires real work
  /npm(?:\.cmd)?\s+run\s+axis:write[^\n]*--report\b/,
], { requires: ['deep-research-packet-single'], isGate: true }),
```

Audit **every** `req(...)` in `CONTRACTS` and apply that shape. Known-vulnerable gates, all in
`scripts/hooks/contract-shared.mjs`:

| Gate | Line | Current pattern | Problem |
|---|---|---|---|
| `construction-check-single` | 141 | `/construction-check\.mjs\b/` | script has `--help`; exits 0 |
| `deep-research-packet-single` | 173 | `/deep-research-packet\.mjs\b/` | script has `--help`; exits 0 |
| `research-audit` | 201 | `/research-coverage-audit\.mjs\b/` | script has `--help`; exits 0 |
| `finalist-gate` | 240 | `/shortlist-finalist-gate\.mjs\b/` | script has `--help`; exits 0 |
| `briefing-pdf` (batch) | 251 | `/briefing-pdf\.mjs\b/` | script has `--help`; exits 0 |
| `promote-finalists` | 236 | `/promote-finalists\.mjs\b/` | no `--help` today, but Task 1.2 adds one |
| `merge-tracker` | 63 | `/merge-tracker\.mjs\b/` | same |
| `verify-pipeline` | 47 | `/verify-pipeline\.mjs\b/` | same |
| `scan` | 51 | `/scan-listings\.mjs\b/` | script has `--help` |
| `reset:data` | 43 | `/reset-search-state\.mjs\b/` | script has `--help` |

Do not fix this by pattern-matching the absence of `--help` — that is brittle and a future flag will
reintroduce it. Fix it in the hook: **`scripts/hooks/on-bash.mjs` must refuse to mark a requirement satisfied
when the command string contains `--help` or `-h`**, regardless of exit code. Add the argument-requiring
patterns as defense in depth where a required argument genuinely exists (`--shortlist`, `--report`, a
positional report path).

Write the test first: a fixture command string with `--help` must leave the requirement unsatisfied.

### Task 1.2 — Add `--help` to every user-facing script

These 12 scripts have no `--help` handling and are reachable by a user or by documentation:

```
scripts/pipeline/merge-tracker.mjs        scripts/pipeline/verify-pipeline.mjs
scripts/pipeline/verify-pipeline-write.mjs scripts/pipeline/normalize-statuses.mjs
scripts/pipeline/dedup-tracker.mjs        scripts/pipeline/hunt-runner.mjs
scripts/pipeline/hunt-deep-runner.mjs     scripts/pipeline/hunt-deep-final-runner.mjs
scripts/research/promote-finalists.mjs    scripts/config/generate-portals.mjs
scripts/config/profile-sync-check.mjs     scripts/system/doctor.mjs
scripts/system/update-system.mjs
```

Follow the established shape — a `HELP_TEXT` template literal and an early `if (config.help)` return, as in
`scripts/pipeline/deep-single-final-runner.mjs:44-56,132-135`. Prefer `parseArgs` from
`scripts/shared/cli.mjs`, which already sets `config.help` on `--help`/`-h`. Each help text must list every
flag the script actually accepts — this is the source of truth Phase 3 documents from.

Internal modules with no CLI entry point (`scripts/shared/*`, `scripts/research/research-utils.mjs`,
`utility-options-core.mjs`, `affordability-core.mjs`, `sentiment-scoring.mjs`, `crawl4ai-utils.mjs`,
`browser-extract-utils.mjs`, and the `scripts/hooks/*` stdin handlers) are out of scope — they are not
invoked directly.

### Task 1.3 — Reconcile `deep.md` with the deep contracts

The batch deep flow and its contract disagree in **both** directions:

- **Documented but ungated.** `modes/deep.md:245-247` tells the agent to run `county-permits-check`,
  `school-metadata-fetch`, and `builder-check` with `--shortlist` (steps 4f–4h), plus `hoa-docs-check`. The
  `deep-shortlist` contract in `contract-shared.mjs:197-259` has **no requirement for any of them**. All four
  can be skipped silently, and the run still passes its gates.
- **Gated but undocumented.** The contract requires `utility-options-check --shortlist`
  (`contract-shared.mjs:224-227`) as a prerequisite of `deep-research-packet`. `modes/deep.md`'s Phase A list
  (4a–4h) never mentions it. An agent following the doc literally stalls on a gate it was never told to satisfy.
- **Single-flow drift.** `modes/deep.md:128` lists the ten scripts `deep-single-final-runner.mjs` runs but
  omits `utility-options-check`, which the runner does in fact run
  (`scripts/pipeline/deep-single-final-runner.mjs:200-205`).

Fix all three. Add contract requirements for the four ungated steps, add `utility-options-check` to the
Phase A list in `modes/deep.md`, and correct the Phase 2 step list at `modes/deep.md:128`.

### Verification
```bash
npm run test
node scripts/system/doctor.mjs
```
Plus a manual check: start a `deep-single` contract, run a gated script with `--help`, and confirm the gate
stays unsatisfied.

### Exit criteria
- No gate in `CONTRACTS` can be satisfied by a `--help` invocation.
- All 13 scripts in Task 1.2 respond to `--help` with a complete flag list and exit 0.
- `modes/deep.md` step lists and the two deep contracts describe the same set of scripts.

---

## 4. Phase 2 — Capture and render the snapshot

### Entry criteria
Phase 1 exit criteria pass.

### Architecture

Three new capture scripts, three sidecars, one new PDF page pack. Grouping by domain rather than one
directory per dimension keeps the contract and renderer surface small, and lets a single flaky source degrade
one domain instead of the whole run.

| Script | Sidecar | Covers |
|---|---|---|
| `scripts/research/site-hazards-check.mjs` | `output/hazards/{slug}.json` | flood, wetlands, radon, EPA sites, soil/septic, airport noise |
| `scripts/research/parcel-tax-check.mjs` | `output/parcel/{slug}.json` | parcel record, assessed value, tax history, zoning, future land use |
| `scripts/research/access-check.mjs` | `output/access/{slug}.json` | road adjacency + AADT, drive times, guided-link dimensions |

All three follow the existing conventions:

- Accept a **positional report path** for single-home mode and `--shortlist` for batch, matching
  `construction-check.mjs` and `county-permits-check.mjs`.
- Accept `--profile <name>` where a hosted browser session is needed (drive times only).
- Resolve coordinates through `scripts/research/geocode.mjs`, which already caches to `output/geocode/`.
- Query ArcGIS REST the way `scripts/research/county-permits-check.mjs` already does — reuse its request,
  radius, and error handling rather than writing a second client. If that logic is not already shared, lift it
  into `scripts/research/research-utils.mjs` as part of this work.
- Fail soft. A dead source is `blocked` in `sourceCoverage`; the script still exits 0 and writes what it got.

### Task 2.1 — `site-hazards-check.mjs`

Verified sources, all live as of 2026-08-11. Section 5 has the full detail.

- **Flood** — FEMA NFHL layer 28 "Flood Hazard Zones". Point-in-polygon at the geocoded coordinate. Capture
  the zone code (`AE`, `X`, `VE`, …), whether it is a Special Flood Hazard Area, and the FIRM panel. This is
  the field `modes/_shared.md:144` has always wanted.
- **Wetlands** — USFWS National Wetlands Inventory layer 0. Intersect the parcel; report classification and
  distance.
- **Radon** — county-level lookup, no network. Ship `config/radon-zones.yml` with all 100 NC counties keyed by
  lowercase county name, matching the key style of `config/county-arcgis-registry.yml`.
- **Environmental sites** — EPA Facility Registry Service, which carries both ACRES (brownfields) and SEMS
  (superfund). Radius query; report site name, program, and distance.
- **Soil / septic suitability** — NRCS Soil Data Access. Relevant only when the home is not on public sewer;
  read that from the utilities sidecar (`output/utilities/{slug}.json`) and skip with
  `skipped-by-profile` when public sewer is confirmed.
- **Airport noise** — RDU composite noise contours. Report the DNL band or "outside modeled contours".
  Meaningful only for homes near RDU; mark `not-applicable` beyond the modeled area rather than "clear".

### Task 2.2 — `parcel-tax-check.mjs`

- **Parcel + assessment + tax** — county ArcGIS parcel layer. Wake is confirmed at
  `maps.wake.gov/arcgis/rest/services/Property/Parcels/FeatureServer`. Extend
  `config/county-arcgis-registry.yml` with a `parcelLayer` key per county rather than hardcoding Wake, and
  make `county-services-discover.mjs` able to find it. A county with no registered parcel layer reports
  `unsupported`, mirroring how `county-permits-check.mjs` already reports `unsupported-county`.
- Capture: PIN/parcel ID, deeded acreage, assessed land and improvement value, most recent sale price and
  date, and the tax year. Compute an estimated annual tax from the county + municipal rate when both are
  known; mark it an estimate, never a quote.
- **Zoning and future land use** — where the county exposes a zoning or future-land-use layer, capture the
  designation. Otherwise fall back to the guided-link pattern (Section 5, D-1).

### Task 2.3 — `access-check.mjs`

- **Road adjacency + traffic volume** — NCDOT AADT stations and traffic segments. Find the nearest classified
  road and its annual average daily traffic, with distance. This is what `_shared.md:144`'s "major road
  adjacency" rule needs: a number and a distance, not a keyword.
- **Drive times** — for each destination in `config/profile.yml`'s commute list, compute an actual drive time.
  Route through the hosted browser session with `--profile chrome-host`, following
  `scripts/research/sentiment-browser-extract.mjs` and `scripts/research/community-lookup.mjs` — those are the
  scripts that drive the user's established CDP session. Do **not** model this on
  `sentiment-public-extract.mjs`: despite reaching Google Maps, it uses crawl4ai with a plain `fetch()`
  fallback (`scripts/research/sentiment-public-extract.mjs:112-138`) and never touches the hosted session,
  which is why it takes no `--profile` flag. Capture free-flow and peak-hour durations if both are available;
  record which one you got. The PDF currently renders only *map links*
  (`scripts/reports/briefing-pdf.mjs:710`); replace that with real durations, keeping the links.
- **Guided-link dimensions** — sex-offender proximity, school-redistricting risk, and any future-land-use
  lookup that has no queryable layer. Emit an official URL plus per-home search instructions. Do not scrape.
  See Section 5, group D.

### Task 2.4 — Price history

Not an external source. Extend `scripts/research/extract-listing-details.mjs` to capture the portal's own
price-history table into `output/listings/{slug}.json`: each entry's date, event, and price. Derive total cut
from original list and days-on-market-at-cut. `daysOnMarket` is already captured
(`scripts/pipeline/evaluate-pending.mjs:751-752`); price *movement* is not, and it is the stronger resale signal.

### Task 2.5 — Wire into the pipeline

- Add the three scripts to `scripts/pipeline/deep-single-final-runner.mjs`'s `phases` array (after
  `county-permits-check`, before `deep-research-packet` — they are inputs to the packet).
- Add them to the batch equivalent in `scripts/pipeline/hunt-deep-runner.mjs`.
- Add contract requirements to **both** `deep-single` and `deep-shortlist` in `contract-shared.mjs`, using the
  argument-requiring pattern shape from Task 1.1, with `deep-research-packet` depending on them.
- Extend `scripts/research/deep-research-packet.mjs` to fold the three sidecars into the packet.
- Feed hazards and access into the existing `risk-builder-axis` agent — it already owns risk interpretation
  (`.claude/agents/risk-builder-axis.md`). Do **not** add a fourth axis agent; the new data is deterministic
  and needs rendering plus risk interpretation, not a new interpreter.

### Task 2.6 — Render the Property Snapshot

Add one page pack to `scripts/reports/briefing-pdf.mjs` following the existing panel conventions
(`hoa` at line 444, `utilities` at line 550 are the closest models). It must:

- Show every dimension with its value **and** its provenance state. `captured`, `unconfirmed`, `blocked`,
  `unsupported`, and `not-applicable` must be visually distinguishable. A blocked FEMA query must not look
  like a home outside the flood zone.
- Add missing-data lines to the existing research-gaps collector (`briefing-pdf.mjs:207-244`) for each new
  sidecar, matching how `!finalist.construction` and `!finalist.utilities` already work there.
- Register the three new sidecar directories in the "Sources Checked" section (`briefing-pdf.mjs:654`).

### Task 2.7 — Make the scoring rules cite the new data

**This is the point of the whole phase; do not skip it.** Update `modes/_shared.md` so the scoring rules read
from the sidecars instead of from listing prose:

- The 2.2 cap at `_shared.md:144` cites `output/hazards/{slug}.json` for flood and
  `output/access/{slug}.json` for road adjacency, and states explicitly that a `blocked` or `unconfirmed`
  hazard read does **not** trigger the cap but **does** lower confidence and must appear in the report's
  open-questions section.
- Financial Fit (`_shared.md:127`) cites `output/parcel/{slug}.json` for taxes.
- Resale / Risk (`_shared.md:128`) cites price history from `output/listings/{slug}.json`.

Then retire the misleading regexes at `scripts/pipeline/evaluate-pending.mjs:1688-1689`. They may stay as a
weak pre-screen signal for the fast evaluate path, but they must be renamed and reported as
`listing-text-mention`, never as a hazard determination. Anything that reads them must treat them as a hint.

Keep buyer-specific values out of `_shared.md` — that rule still holds (`CLAUDE.md`, Personalization).
Thresholds like "what AADT counts as a busy road" belong in `config/profile.yml`.

### Verification
```bash
npm run test
node scripts/research/site-hazards-check.mjs --help
node scripts/research/parcel-tax-check.mjs --help
node scripts/research/access-check.mjs --help
node scripts/system/doctor.mjs
```
Then a live single-home run end to end:
```bash
node scripts/pipeline/deep-single-runner.mjs --url <listing-url> --profile chrome-host
# write the eval report
node scripts/pipeline/deep-single-final-runner.mjs --report reports/<report>.md --profile chrome-host
```
Confirm all three sidecars exist, carry `sourceCoverage`, and appear in the rendered PDF.

### Exit criteria
- Three sidecars written for a real address, each with full metadata and honest `sourceCoverage`.
- The PDF shows the Property Snapshot with provenance states visually distinct.
- A deliberately blocked source renders as `blocked`, not as absence of hazard.
- `modes/_shared.md` scoring rules cite sidecar paths; no scoring rule depends on a listing-text regex.
- `DATA_CONTRACT.md` lists the three new directories as durable.

---

## 5. Verified source appendix

All endpoints confirmed reachable on 2026-08-11. Re-verify before coding; public GIS services move.

### Group A — spatial queries (ArcGIS REST, same pattern as `county-permits-check.mjs`)

**A-1. FEMA National Flood Hazard Layer**
`https://hazards.fema.gov/arcgis/rest/services/public/NFHL/MapServer`
Layer 28 = "Flood Hazard Zones" (polygon). Layer 27 = "Flood Hazard Boundaries" (polyline). 35 layers total
including FIRM Panels, LOMRs, Base Flood Elevations. Capabilities include Query; formats JSON/geoJSON/PBF;
max 2000 records per request. Spatial reference NAD 1983, WKID **4269** — note this is *not* 4326; reproject
or pass `inSR` explicitly.

**A-2. NCDOT Annual Average Daily Traffic**
Stations: `https://services.arcgis.com/NuWFvHYDMVmmxMeM/ArcGIS/rest/services/NCDOT_AADT_Stations/FeatureServer`
Segments: `https://services.arcgis.com/NuWFvHYDMVmmxMeM/arcgis/rest/services/NCDOT_AADT_Traffic_Segmentation/FeatureServer/2`
Station points carry `Location_ID`, `ROUTE`, `LOCATION`, and the AADT estimate. Derived from NCDOT Roads &
Highways Q1 publication; this is the FHWA HPMS submission. Prefer segments for "what road is this house on",
stations for volume.

**A-3. USFWS National Wetlands Inventory**
`https://fwspublicservices.wim.usgs.gov/wetlandsmapservice/rest/services/Wetlands/MapServer`
Layer 0 = "Wetlands" (polygon); table 1 = `NWI_Wetland_Codes` for decoding classifications. Query supported.
Note the host: `www.fws.gov/wetlandsmapservice/...` issues a 301 to this USGS host — use the final URL directly.

**A-4. Wake County parcels**
`https://maps.wake.gov/arcgis/rest/services/Property/Parcels/FeatureServer`
The `Property` folder also holds `Addresses`, `Easements`, `CountyFacilities`. The county's ArcGIS base is
already registered at `config/county-arcgis-registry.yml:22`. Harnett is registered at
`https://gis.harnett.org/arcgis/rest/services` but its parcel layer is unverified — discover it via
`node scripts/research/county-services-discover.mjs` rather than guessing.

**A-5. EPA Facility Registry Service**
`https://services.arcgis.com/cJ9YHowT8TU7DUyn/arcgis/rest/services/FRS_INTERESTS/FeatureServer`
Integrates ACRES (brownfields) and SEMS (superfund/hazardous waste) with other national program systems.
Alternative: `https://geopub.epa.gov/arcgis/rest/services/EMEF/efpoints/MapServer/5` for brownfields only.
Filter by program so a routine regulated facility is not reported as a superfund site.

**A-6. RDU airport noise contours**
ArcGIS Online item `7a0bb4bbfe324c4693a7b68b8da0fade` ("RDU Composite Noise Contours"); public viewer at
`https://experience.arcgis.com/experience/9b371abfb6bd4084be571b546789ff4a`. Resolve the item to its
FeatureServer before coding. Contours model down to 55 dB DNL; the FAA 65 dB DNL threshold sits mostly on
airport property, extending roughly 5,500 ft northeast and 3,650 ft southwest of the property line. For the
buyer's Apex / Holly Springs / Fuquay-Varina search area most homes fall outside the modeled contours — report
`not-applicable`, not "quiet".

### Group B — tabular API

**B-1. USDA NRCS Soil Data Access**
`https://SDMDataAccess.sc.egov.usda.gov/Tabular/post.rest` — POST, SQL over the SSURGO database, returns
JSON or XML. Docs: `https://sdmdataaccess.nrcs.usda.gov/webservicehelp.aspx`. Query the septic-suitability
interpretation for the map unit at the parcel coordinate. This is the most complex integration in the set;
budget accordingly and consider shipping it last within Task 2.1.

### Group C — static table, no network

**C-1. EPA Map of Radon Zones — North Carolina**
`https://www.epa.gov/sites/default/files/2014-08/documents/north_carolina.pdf`
County-level Zone 1/2/3 classification for all 100 counties; the dataset is stable and does not need a live
query. Transcribe into `config/radon-zones.yml`. Zone 1 is predicted indoor average above 4 pCi/L. Include a
note in the rendered output that zone is a screening predictor and only a test measures a specific house —
`ncdhhs.gov/divisions/health-service-regulation/north-carolina-radon-program/nc-radon-data`.

### Group D — official link + how-to-check (no scraping)

Follow the pattern `modes/deep.md:350` already establishes for `propertyPermitGuides`: emit the official
link and buyer-facing search instructions, and never claim a result the pipeline did not obtain.

**D-1. Future land use / rezoning.** Municipal development maps are already seeded in
`templates/research-defaults.yml` for Holly Springs and Fuquay-Varina, and `output/development-sources.json`
already carries profile-selected sources. Extend that catalog rather than building a new one.

**D-2. Sex-offender proximity.** NCSBI registry at `https://sexoffender.ncsbi.gov` supports a public radius
search by address, and `stats.aspx` publishes aggregate statistics. There is **no official public API**.
Do not scrape it and do not use third-party resellers: it is a law-enforcement registry with an acceptable-use
policy, the data is sensitive, and `CLAUDE.md`'s ToS rule applies. Emit the official radius-search URL and
instructions. The national portal `https://www.nsopw.gov/search-public-sex-offender-registries` is a
reasonable secondary link.

**D-3. School redistricting risk.** Assignment changes are published as board proposals without a stable API.
Link the district's assignment-change page and note the current assignment's stability. Existing school
capture (`school-assignments-fetch.mjs`, `school-metadata-fetch.mjs`) covers current assignment; this adds only
the change-risk narrative.

---

## 6. Test policy

Tests come first, and each new test is registered in `scripts/system/test-all.mjs` alongside the existing
entries at lines 153-234 (`const result = run('node scripts/tests/test-<name>.mjs');`). Fixtures live in
`scripts/tests/fixtures/`.

**Required new tests**
- `test-site-hazards.mjs`, `test-parcel-tax.mjs`, `test-access.mjs` — parse recorded ArcGIS JSON fixtures into
  sidecars. Record real responses once, then test offline. No network in the test suite.
- Sidecar shape tests: required metadata present, `sourceCoverage` states valid, address-match rejection works.
- A gate test proving `--help` cannot satisfy a contract requirement (Task 1.1).

**Two known gaps to close while you are here**
- `briefing-pdf.mjs`'s `riskLevel: 'high'` → Top Concerns path has never been exercised; the existing fixture
  uses `'moderate'`. Add the high case.
- **Never assert on a CSS class token in briefing-pdf tests.** The static `<style>` block leaks every selector
  name into every render, so `html.includes('axis-panel')` passes even when nothing rendered. Assert on
  rendered *content* — an address, a zone code, a dollar figure. This has already caused a false pass once.

---

## 7. Phase 3 — Document the real surface

### Entry criteria
Phase 2 exit criteria pass. Documenting a surface that is still changing wastes the work.

### Task 3.1 — Command reference

50 of 78 npm scripts appear in no user-facing doc. Generate a complete reference at `docs/COMMANDS.md`
covering every entry in `package.json`, grouped by purpose, each with its underlying script, its flags (taken
from the `--help` text Phase 1 standardized), and a one-line description.

Entirely undocumented today, and worth calling out explicitly:

- `update:check`, `update`, `rollback` — the whole `scripts/system/update-system.mjs` subsystem. No docs,
  and no `--help` before Phase 1. A user has no way to discover their update path exists.
- `cache:stats`, `cache:clear`, `cache:sentiment:stats`, `cache:sentiment:clear`
- `deep:single`, `deep:single-final`, `axis:write`, `brief:single`, `brief:top3`
- `profile:wizard`, `profile:wizard:once`, `afford:wizard`, `afford:wizard:once`
- `portals:generate`, `normalize`, `dedup`, `geocode`, `liveness`, `test`, `browser:setup:edge`

Note that several names are aliases of the same script (`merge` / `merge-tracker` / `merge:tracker`;
`review-tabs` / `review:tabs`). Document the canonical name and list aliases once — do not present them as
distinct capabilities.

### Task 3.2 — Fix the stale surfaces

- **`README.md:51-60`** — "Core commands" omits `compare`, `skim`, `reset`, and `profile`, and describes
  `hunt` as "reset, scan, and evaluate sequentially", which predates the deep shortlist branch that
  `modes/hunt.md` now runs. Correct it and link `docs/COMMANDS.md`.
- **`.claude/skills/home-ops/SKILL.md:121`** — states that `deep` with a populated shortlist "should launch
  one subagent per shortlisted home". This contradicts `modes/deep.md:29-41`, which specifies exactly three
  axis agents plus the main agent for every run, batch included. `deep.md` is correct; fix `SKILL.md`.
- **`SKILL.md:53-77`** — the discovery menu lists modes but not their options. Add the option lines each mode
  actually supports: `deep <url>` / `deep <url1> <url2> …` / `deep` (shortlist batch); `evaluate` with and
  without a target; `compare` arguments; the `--zillow/--redfin/--relator` platform selectors already shown
  for `init`, `scan`, and `skim`; and the new snapshot behavior from Phase 2.
- **`CLAUDE.md`** — the OpenCode command table should gain the modes and options added above. Keep
  buyer-specific criteria out of it.
- **`DATA_CONTRACT.md`** — add `output/hazards/`, `output/parcel/`, and `output/access/` to the durable
  learned-output list at line 33, and document their required fields the way the utilities sidecar is
  documented at lines 42-48.

### Task 3.3 — Close the loop

Add a check to `scripts/system/doctor.mjs` that fails when a `package.json` script is absent from
`docs/COMMANDS.md`. Without it this document rots again within a few features. Keep the check advisory
(warning, non-zero only with `--strict`) if a hard failure would be disruptive to routine runs.

### Verification
```bash
npm run test
node scripts/system/doctor.mjs
node scripts/config/profile-sync-check.mjs
```

### Exit criteria
- Every `package.json` script appears in `docs/COMMANDS.md` with accurate flags.
- No documented command or flag is missing from the code; no user-facing script is missing from the docs.
- `SKILL.md` and `modes/deep.md` describe the same agent architecture.
- `doctor.mjs` detects a newly added undocumented npm script.

---

## 8. Definition of done

1. `npm run test` passes; `node scripts/system/doctor.mjs` reports clean.
2. A single-home deep run on a real listing produces a PDF whose Property Snapshot shows flood zone, parcel
   and tax, nearest-road AADT, drive times, and the remaining dimensions — each with visible provenance.
3. Deliberately breaking one source (block the FEMA host) yields `blocked` in the sidecar, a research-gap line
   in the PDF, and lowered confidence — **not** an implied all-clear.
4. No contract gate can be satisfied by `--help`.
5. `modes/_shared.md` contains no scoring rule whose only input is a regex over listing text.
6. `docs/COMMANDS.md` covers all 78 npm scripts, and `doctor.mjs` enforces that.

---

## 9. Deliberately out of scope

- Insurance premium estimates — no free authoritative source; quotes are underwriter-specific.
- Crime statistics as numbers — agency data is inconsistent across jurisdictions and easy to misread.
  The existing `crime_safety` sentiment dimension stays qualitative.
- Cell coverage — carrier maps are marketing claims, not measurements.
- Topography, slope, and tree canopy — obtainable from LiDAR/NLCD, but low decision value relative to build cost.
- Comparable-sales valuation — a real AVM is its own project and a bad one is worse than none.
- Any automated contact with an agent, tour scheduling, or offer submission. Permanently out of scope
  per `CLAUDE.md`, Ethical Use.
