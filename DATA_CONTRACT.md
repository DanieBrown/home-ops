# Data Contract

This document defines which files belong to the **user layer** and which belong to the **system layer**.

User-layer files hold the buyer's identity, preferences, search history, and reports. They should never be overwritten by a system update.

System-layer files hold prompts, scripts, dashboards, templates, and repo instructions. They can be revised as the tool evolves.

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
| `output/*` | Generated exports or temporary artifacts |

## System Layer (safe to update)

| File | Purpose |
|------|---------|
| `modes/_shared.md` | Shared scoring logic and global rules |
| `modes/evaluate.md` | Single-listing evaluation mode |
| `modes/compare.md` | Multi-listing comparison mode |
| `modes/scan.md` | Listing scanner mode |
| `modes/tracker.md` | Tracker overview mode |
| `modes/deep.md` | Deep-dive research mode |
| `modes/_profile.template.md` | Starter template for buyer overrides |
| `templates/states.yml` | Canonical listing states |
| `templates/portals.example.yml` | Example scanner configuration |
| `CLAUDE.md` | Agent operating instructions |
| `AGENTS.md` | Codex routing instructions |
| `docs/*` | Documentation |
| `dashboard/*` | Go TUI dashboard |
| `*.mjs` | Utility scripts |
| `.claude/skills/*` | Skill routers |
| `.opencode/commands/*` | OpenCode command wrappers |
| `fonts/*` | Local fonts and assets |
| `VERSION` | Version marker |
| `DATA_CONTRACT.md` | This file |

## The Rule

If a file belongs to the user layer, updates must not overwrite, delete, or reset it.

If a file belongs to the system layer, it can be improved or replaced as the shared product evolves.
