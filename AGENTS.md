# Home-Ops Agent Guide

Start here:
- Read `CLAUDE.md` first for routing, mode behavior, and ethical limits.
- Read `docs/CODEX.md` for Codex-specific setup, the routing map, and verification commands.
- Read `DATA_CONTRACT.md` before changing buyer-layer files, generated data, or tracker content.
- Read `docs/SETUP.md` for hosted-browser setup and Windows PowerShell caveats.
- Read `docs/ARCHITECTURE.md` for the workflow and data-flow overview.
- Read `docs/CUSTOMIZATION.md` when changing profile weights, prompt behavior, or canonical states.

Core rules:
- Reuse the checked-in modes, scripts, templates, and tracker flow. Do not create a parallel workflow.
- Treat `buyer-profile.md`, `config/profile.yml`, `modes/_profile.md`, and `portals.yml` as buyer-owned customization files.
- Never put buyer-specific criteria into `modes/_shared.md`.
- Never contact an agent, schedule a tour, or submit an offer on the user's behalf.
- Do not add or change git remotes unless the user explicitly asks.
- When browser verification is available, do not trust generic fetch alone for listing status. If verification is blocked, report the listing as blocked or unconfirmed instead of active or inactive.

Execution model:
- On Windows PowerShell, prefer `npm.cmd` over `npm` if execution policy blocks `npm.ps1`.
- Reuse the hosted browser session created by `/home-ops init` or `npm.cmd run browser:setup`; do not try to bootstrap a new session from scan, evaluate, or hunt.
- Keep Playwright-backed listing verification and fact extraction serialized against the hosted browser session. Do not run multiple browser checks in parallel.
- In hunt mode, run reset -> scan -> evaluate sequentially. Do not overlap those phases.
- For batch evaluate with no explicit target, deduplicate homes by normalized address + city before dispatching report work.
- Use one report-writing worker per canonical home. If the queue is large, dispatch workers in waves of up to 5.
- Keep tracker merges, shortlist updates, and processed-pipeline edits in the main agent. Subagents should return evidence and report drafts only.
- When a user intent maps to a mode, read `modes/_shared.md` plus the matching file under `modes/` before acting.

Key files and outputs:
- `data/listings.md` is the source of truth for tracker state.
- `batch/tracker-additions/` is the staging area for batch tracker rows; merge staged output with `npm.cmd run merge`.
- `reports/` filenames must stay `{###}-{address-slug}-{YYYY-MM-DD}.md`.
- `templates/states.yml` is the source of truth for canonical listing statuses.

Verification:
- General repo health: `npm.cmd run doctor`, `npm.cmd run sync-check`, `npm.cmd run verify`.
- After report-heavy evaluate or deep work: `npm.cmd run audit:research`.
- After dashboard changes: `npm.cmd run dashboard:build` or `cd dashboard && go build ./...`.
