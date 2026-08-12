# Data Contract

This document defines which files belong to the **user layer** and which belong to the **system layer**.

User-layer files hold the buyer's identity, preferences, search history, and reports. They should never be overwritten by a system update.

System-layer files hold prompts, scripts, templates, and repo instructions. They can be revised as the tool evolves.

## User Layer (NEVER auto-updated)

| File | Purpose |
|------|---------|
| `buyer-profile.md` | Canonical buyer brief in markdown |
| `config/profile.yml` | Buyer identity, search criteria, weighting, and financing assumptions |
| `modes/_profile.md` | Buyer-specific heuristics and overrides |
| `portals.yml` | User-customized search URLs and platform settings |
| `data/listings.md` | Canonical listing tracker |
| `data/pipeline.md` | Pending listing inbox |
| `data/shortlist.md` | Latest compare top-three tags and deep handoff state |
| `data/scan-history.tsv` | Scan dedup and history log |
| `reports/*` | Saved listing evaluation reports |
| `output/*` | Generated user-layer facts, learned source inventories, and exports |

### Learned Output Layer

`output/` is durable user-layer storage. Resets should clear transient run clutter, not learned facts about places or properties.

Durable learned stores include:

- `output/knowledge/index.json` -- index of learned sidecars.
- `output/knowledge/commands.jsonl` -- per-command memory log.
- `output/areas/{area-slug}.json` -- reusable area facts and source references.
- `output/geocode/`, `output/permits/`, `output/construction/`, `output/school-metadata/`, `output/utilities/`, `output/sentiment/`, `output/communities/`, `output/listings/`, `output/builder/`, `output/hoa/`, `output/hazards/`, `output/parcel/`, and `output/access/`.
- `output/*-sources.json` source inventories.

Transient generated output (cleared by `reset:data`, never treated as learned facts): `output/axis/`, `output/briefings/`, `output/cache/`, `output/deep-packets/`, `output/evaluate-packets/`.

One-off scripts and scratch artifacts must live under `.home-ops/tmp/{commandId}/` or the OS temp directory and be removed after use.

Generated sidecars should include additive metadata when possible: `schemaVersion`, `scope`, `subjectKey`, `commandId`, `generatedAt`, `expiresAt`, `sourceUrls`, `status`, and `warnings`. Readers must tolerate older sidecars that do not yet include those fields.

### Generated Utility Sidecars

Deep utility/provider capture writes `output/utilities/{slug}.json`. The sidecar belongs to the generated user layer and must match the report address before a renderer or packet consumes it.

Required top-level fields: `generatedAt`, `address`, `city`, `state`, `reportPath`, `assumptions`, `providers`, `monthlyEstimate`, `sourceCoverage`, and `warnings`.

Provider entries must include `name`, `serviceStatus`, `sourceUrl`, and `checkedAt`, plus either `estimateMonthly` or `plans`. Address-gated, blocked, or unconfirmed sources must stay marked as `blocked` or `unconfirmed`; they must not be rendered as confirmed availability.

### Generated Property Snapshot Sidecars

The deep flow writes three snapshot sidecars per home. All three belong to the generated user layer, are durable across `reset:data`, and must match the report address before a renderer or packet consumes them.

| Sidecar | Written by | Covers |
|---------|-----------|--------|
| `output/hazards/{slug}.json` | `scripts/research/site-hazards-check.mjs` | FEMA flood zone and SFHA flag, wetlands, county radon zone, EPA superfund/brownfield sites, septic soil suitability, RDU airport noise contours |
| `output/parcel/{slug}.json` | `scripts/research/parcel-tax-check.mjs` | Parcel ID, deeded acreage, assessed land/improvement value, last recorded sale, estimated annual tax, zoning district, guided future-land-use link |
| `output/access/{slug}.json` | `scripts/research/access-check.mjs` | Nearest NCDOT AADT count station with route/volume/distance, busy-road exposure, measured drive times, guided sex-offender and school-redistricting checks |

Required top-level fields: `generatedAt`, `address`, `city`, `state`, `reportPath`, `status`, `dimensions`, `sourceCoverage`, and `warnings`, plus the standard sidecar metadata above.

**`dimensions`** maps a dimension key to `{ label, provenance, value, detail, sourceUrl, note }`. `provenance` is one of `captured`, `unconfirmed`, `blocked`, `unsupported`, or `not-applicable`. **`value` is null for anything other than `captured`** -- there is no default flood zone, tax figure, or traffic count.

**`sourceCoverage`** is an array of `{ key, name, url, status, checkedAt, note, error }`. `status` is one of `captured`, `blocked`, `unsupported`, `skipped-by-profile`, or `missing`.

The distinction these states carry is the point of the whole layer, and renderers must keep them visually distinct: **`blocked` means the source could not be reached, which is not the same as "no hazard found"**. A blocked FEMA query must never render like a home outside the flood zone.

The vocabulary itself lives in `scripts/research/source-coverage.mjs` so the sidecars, the briefing PDF, and the tests cannot drift apart.

## System Layer (safe to update)

| File | Purpose |
|------|---------|
| `modes/_shared.md` | Shared scoring logic and global rules |
| `modes/init.md` | Browser session setup mode |
| `modes/reset.md` | Generated-state reset mode |
| `modes/profile.md` | Interactive buyer-profile setup mode |
| `modes/afford.md` | Affordability estimate and optional profile-update mode |
| `modes/hunt.md` | Sequential reset-scan-evaluate orchestration mode |
| `modes/evaluate.md` | Single-listing evaluation mode |
| `modes/compare.md` | Multi-listing comparison mode |
| `modes/scan.md` | Listing scanner mode |
| `modes/tracker.md` | Tracker overview mode |
| `modes/deep.md` | Deep-dive research mode |
| `modes/_profile.template.md` | Starter template for buyer overrides |
| `templates/states.yml` | Canonical listing states |
| `templates/portals.example.yml` | Example scanner configuration |
| `templates/research-defaults.yml` | Reusable seed catalog for state/county/municipal source discovery |
| `CLAUDE.md` | Agent operating instructions |
| `AGENTS.md` | Codex routing instructions |
| `docs/*` | Documentation |
| `*.mjs` | Utility scripts |
| `.claude/skills/*` | Skill routers |
| `.opencode/commands/*` | OpenCode command wrappers |
| `fonts/*` | Local fonts and assets |
| `VERSION` | Version marker |
| `DATA_CONTRACT.md` | This file |

## The Rule

If a file belongs to the user layer, updates must not overwrite, delete, or reset it. `reset:data` preserves learned `output/` facts by default; use `--purge-knowledge` only when the user explicitly wants that full deletion.

If a file belongs to the system layer, it can be improved or replaced as the shared product evolves.
