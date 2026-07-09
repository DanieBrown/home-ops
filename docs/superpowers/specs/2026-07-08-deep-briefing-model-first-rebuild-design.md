# Deep Briefing Model-First Rebuild — Design

- **Date:** 2026-07-08
- **Status:** Approved design, pending implementation plan
- **Scope decision:** "Model-first rebuild" approved over "visual-only pass" and "data-first" alternatives.

## Context

The `/home-ops deep` pipeline captures evidence deterministically (11 capture scripts → JSON sidecars under `output/`), interprets it with three axis agents (sentiment, risk-builder, schools), and renders a briefing PDF via `scripts/reports/briefing-pdf.mjs`.

The core flaw: **the axis agents' structured outputs are never persisted.** They exist only in the conversation; the main agent flattens them into report markdown, and the PDF re-derives everything from raw capture sidecars and regex-scrapes of the markdown (`buildSchoolRatings`, `shortRecommendationLabel`). The PDF's sentiment section is a raw keyword-hit table rather than the weighted, quoted, confidence-rated interpretation the axis agents already produce. Separately, the PDF renders zero photos (3 CDN URLs are captured per listing and unused), has no charts beyond ethnicity bars, forces every section onto its own mostly-empty page, and has no page numbers or running headers.

## Goals

1. Persist the interpreted axis layer as a first-class, validated sidecar consumed by the PDF.
2. Make the briefing PDF visually decision-grade: photos, score gauges, sentiment chart, risk distance-ring map, hard-gate chips, page furniture, sane page packing.
3. Zero new npm dependencies (charts are inline SVG; PDF stays Playwright `page.pdf()`).
4. Preserve the "unknown, not favorable" doctrine: every new block degrades gracefully when its data is missing, and a run with no axis sidecar still renders today's output.

## Non-Goals (queued follow-up)

FEMA flood-zone lookup, road-adjacency computation, price-history extraction, computed drive times, parcel/tax capture. These become new capture scripts later; once the axis/PDF spine exists they land in the PDF without further layout work.

## Data Flow (after this change)

```
Phase 0/2  capture scripts ──────────────► output/{listings,sentiment,construction,permits,
                                            school-metadata,builder,hoa,utilities,deep-packets}/{slug}.json
Phase 3    3 axis agents (unchanged schemas)
Phase 4a   main agent merges axis JSON + verdict → .home-ops/tmp/{commandId}/axis-{slug}.json
Phase 4b   node scripts/research/axis-sidecar-write.mjs --report <path> --input <tmpfile>
              └─ validates, stamps metadata → output/axis/{slug}.json   [new contract gate]
Phase 4c   review-tabs --replace → briefing-pdf.mjs
              └─ per section: axis sidecar → raw sidecars → report-markdown regex (last resort)
```

## Component 1 — Axis sidecar: `output/axis/{slug}.json`

### Schema

```json
{
  "schemaVersion": 1,
  "generatedAt": "<iso>",
  "address": "...", "city": "...", "state": "NC",
  "slug": "<same slug convention as all sidecars>",
  "reportPath": "reports/{N}-{slug}-{date}.md",
  "sentiment":   { "...": "verbatim sentiment-axis output (see .claude/agents/sentiment-axis.md)" },
  "riskBuilder": { "...": "verbatim risk-builder-axis output" },
  "schools":     { "...": "verbatim schools-axis output" },
  "verdict": {
    "recommendation": "pursue | consider | pass",
    "confidence": "high | medium | low",
    "rationale": "1-3 sentences from the main agent's synthesis",
    "inPersonChecks": ["..."]
  }
}
```

Each axis block is the agent's documented output schema verbatim, including the degraded `{ "status": "missing-input", ... }` form. The writer script appends the standard knowledge-store metadata (`subjectKey`, `scope: "property"`, `commandId`, `expiresAt` at 14 days) via `withSidecarMetadata` + `recordArtifact`, matching every other sidecar.

### Writer script: `scripts/research/axis-sidecar-write.mjs`

```
node scripts/research/axis-sidecar-write.mjs --report reports/{N}-{slug}-{date}.md --input .home-ops/tmp/{commandId}/axis-{slug}.json
```

- Parses the report (existing `parseReport`) to resolve address/city/state/slug.
- Validation (exit 1 with a readable list of failures):
  - input parses as JSON; `sentiment`, `riskBuilder`, `schools`, `verdict` blocks present;
  - each axis block either has its required fields (`sentimentScores` / `riskLevel` / `schools` array) or is a well-formed `missing-input` record;
  - input `address`+`city`, when present, match the report (same normalization as `companionMatchesReport`).
- Writes `output/axis/{slug}.json`; prints a one-line summary (per-axis status + verdict).
- Batch mode: the main agent calls it once per home.

### Contract gate

Add an `axis-sidecar` required entry (matched by `/axis-sidecar-write\.mjs\b/`) to the `deep-single` and `deep-shortlist` templates in `scripts/hooks/contract-shared.mjs`, positioned as a prereq of `briefing-pdf-deep-single` / `briefing-pdf`, using the templates' existing prereq mechanism. The PDF can no longer run without the interpreted layer (or an explicit recorded failure).

### Reset classification

`output/axis/` joins `OUTPUT_CACHE_SUBDIRS` in `scripts/pipeline/reset-search-state.mjs` (transient, like `deep-packets`) — axis interpretations derive from a specific run and must not bias re-runs. Update the reset help text list.

## Component 2 — Photo caching at capture time

In `scripts/research/extract-listing-details.mjs`, after facts extraction:

- Download up to 3 photo URLs through the already-attached hosted browser context (`page.request.get(url)` carries portal cookies, avoiding hotlink 403s), 10s timeout each, soft-fail per photo.
- Save to `output/listings/photos/{slug}/photo-{n}.jpg`; record workspace-relative paths in the sidecar as `photos.localPaths: []` alongside the existing `count`/`urls`.
- Lifecycle: lives under `output/listings/`, so it already follows the listing sidecar's learned/purge lifecycle — no reset change needed.
- The PDF embeds local files as base64 data URIs (skip any file over 2 MB). **No remote fetch at render time** — if `localPaths` is empty, the photo strip is omitted entirely (a broken hotlink would stall `networkidle` and can 403).

## Component 3 — PDF data spine

`briefing-pdf.mjs` changes:

- `loadFinalist()` additionally loads `output/axis/{slug}.json` through the existing `loadCompanionForReport` machinery (address-mismatch safety included) as `finalist.axis`.
- Consumption hierarchy per section: **`finalist.axis` → raw capture sidecars → report-markdown regex fallback** (current regex paths are kept but demoted to last resort).
- Export `buildHtml` (and the small builders) so tests can render HTML from fixtures without launching Chromium.

## Component 4 — Page model

### Overview page (decision dashboard, per home)

Top to bottom:

1. **Photo strip** — hero + 2 thumbnails, fixed-height row (~2.2in), base64-embedded. Omitted when no cached photos.
2. **Title block** — address (linked), locality, community tag; badge row: overall score, recommendation, and **per-axis confidence chips** (`sentiment: high`, `risk: medium`, `schools: high`) from the axis sidecar.
3. **KPI stat tiles** — price, **computed $/sqft with delta vs. tracker median for the same city**, beds/baths, sqft, lot, year built, HOA, DOM. Median from `data/listings.md` via `parseListingRow` (`scripts/shared/listings.mjs`): same-city rows with both price and sqft; require n ≥ 3, else omit the delta (never the tile). Show as e.g. `$236/sqft · −4% vs Apex median (n=12)`.
4. **Hard-requirement gate chip row** — parse the report's `Hard Requirement Gate` markdown table; map statuses to ✓ (pass/meets/yes), ✗ (fail/no), ? (unknown). Table missing → row omitted.
5. **Axis score gauges** — inline-SVG horizontal bars: the four weighted sentiment dimensions (signed scores from `axis.sentiment.sentimentScores`), `axis.schools.weightedSchoolScore`, and a colored `riskLevel` chip.
6. **Top concerns + research gaps** — existing logic, additionally fed by `axis.sentiment.redFlagsTriggered` and `axis.riskBuilder` high-pressure projects.

### Evidence pages

- **Sentiment page:** diverging bar chart per dimension (SVG, negative left in red / positive right in green, annotated with `evidenceCount` and `proximityMix`), then 2–3 verbatim quotes per dimension with source + provenance chips (`sidecar` / `fallback-capture`), a red-flags callout box, and the source-coverage row. Falls back to today's kpiRollup table when no axis sidecar.
- **Risk page:** **distance-ring map** — SVG with the home centered, rings at 1/3/5 miles (to scale), one dot per `axis.riskBuilder.nearbyProjects[]` entry placed at its true radius (`distanceMiles`) with a deterministic schematic angle (hash of caseId/description); dots colored by status, numbered to a legend. Caption states: *distance rings are to scale; bearing is schematic.* Below it: pressure-breakdown table, `resaleRiskNote`, existing builder card, manual permit-lookup links. Entries without `distanceMiles` appear in the legend only. No axis data → today's infrastructure section unchanged.
- **Schools page:** existing metadata table + ethnicity bars, plus `axis.schools.flags`, mismatch notes, and a weighted-score gauge.
- **Sources ledger:** unchanged, stays last.

### Page packing

Replace unconditional full-page sections: classify **full-page** (overview, sentiment, risk/infrastructure, schools, sources) vs **compact** (utilities, HOA, builder, commute). Compact cards flow together onto shared pages (`break-inside: avoid` per card); full-page sections keep `break-before: page`. Kills the near-empty commute/utilities pages.

### Page furniture

`page.pdf()` gains `displayHeaderFooter: true` with a footer template — address left, `page N of M` right (Chromium's `pageNumber`/`totalPages` classes) — and bottom margin adjusted to ~0.65in. Cover page suppresses the running address via the standard blank-header trick (header template empty; footer is global, which is acceptable).

## Component 5 — Mode, agents, docs

- `modes/deep.md`: Phase 4 (single) and Phase C (batch) gain the numbered step: *merge axis outputs + verdict to a temp file under `.home-ops/tmp/{commandId}/`, run `axis-sidecar-write.mjs` per home* — inserted into the authoritative script-order diagram before `review-tabs`/`briefing-pdf`. Update both final-summary checklists to include the axis sidecar path.
- `.claude/agents/*-axis.md` (and `.github/agents/*` mirrors): add one line — "Return strict JSON only; your output is persisted verbatim to `output/axis/{slug}.json`."
- `DATA_CONTRACT.md`: list `output/axis/` as generated, reset-cleared state.

## Error handling

| Failure | Behavior |
|---|---|
| Axis agent returns malformed JSON | `axis-sidecar-write.mjs` exits 1 with field-level errors; contract records failure; main agent fixes payload and re-runs (run-to-completion rule: continue, note in brief) |
| Axis sidecar missing at PDF time | Gate normally prevents this; if bypassed, every axis-fed block falls back to raw-sidecar/regex rendering |
| Photo download fails / oversized | Photo skipped; strip renders with fewer images or is omitted; `coverageNotes` records it |
| Tracker has <3 same-city comps | $/sqft tile renders without the delta |
| `nearbyProjects` lacks distances | Ring map omits those dots; they stay in the legend/table |
| Gate table absent from report | Chip row omitted |

## Testing

New tests wired into `scripts/system/test-all.mjs`:

1. `scripts/tests/test-axis-sidecar.mjs` — valid payload writes file with metadata; missing block → exit 1; address mismatch → exit 1; `missing-input` axis block accepted.
2. `scripts/tests/test-briefing-html.mjs` — renders HTML (exported `buildHtml`) from fixture sidecars under `scripts/tests/fixtures/`: asserts photo `data:` URI present when `localPaths` exist, gauge/ring SVGs present with axis data, gate chips parsed, **and a no-axis fixture still renders the legacy layout**. No Chromium launch needed.
3. Manual smoke: `node scripts/reports/briefing-pdf.mjs --report <recent report> --no-open` against an existing home with real sidecars.

## Implementation order

1. `axis-sidecar-write.mjs` + tests (unblocks everything downstream).
2. Contract gate + reset classification + `modes/deep.md` + agent-def lines.
3. Photo caching in the extractor.
4. PDF data spine (`finalist.axis` loading + consumption hierarchy).
5. Overview dashboard (photos, KPI tiles, gate chips, gauges, confidence chips).
6. Evidence pages (sentiment chart + quotes, risk ring map, schools additions).
7. Page packing + header/footer.
8. HTML fixture tests + manual smoke run.
