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
- `output/geocode/`, `output/permits/`, `output/construction/`, `output/school-metadata/`, `output/utilities/`, `output/sentiment/`, `output/communities/`, `output/listings/`, `output/builder/`, and `output/hoa/`.
- `output/*-sources.json` source inventories.
- `output/axis/` -- per-home axis-agent interpretation sidecars (generated, cleared by reset).

One-off scripts and scratch artifacts must live under `.home-ops/tmp/{commandId}/` or the OS temp directory and be removed after use.

Generated sidecars should include additive metadata when possible: `schemaVersion`, `scope`, `subjectKey`, `commandId`, `generatedAt`, `expiresAt`, `sourceUrls`, `status`, and `warnings`. Readers must tolerate older sidecars that do not yet include those fields.

### Generated Utility Sidecars

Deep utility/provider capture writes `output/utilities/{slug}.json`. The sidecar belongs to the generated user layer and must match the report address before a renderer or packet consumes it.

Required top-level fields: `generatedAt`, `address`, `city`, `state`, `reportPath`, `assumptions`, `providers`, `monthlyEstimate`, `sourceCoverage`, and `warnings`.

Provider entries must include `name`, `serviceStatus`, `sourceUrl`, and `checkedAt`, plus either `estimateMonthly` or `plans`. Address-gated, blocked, or unconfirmed sources must stay marked as `blocked` or `unconfirmed`; they must not be rendered as confirmed availability.

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
