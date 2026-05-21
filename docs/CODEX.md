# Codex Setup

Home-Ops supports Codex through the root `AGENTS.md` file.

If your Codex client reads project instructions automatically, `AGENTS.md` plus `CLAUDE.md` are enough for routing and behavior.

## Prerequisites

- A Codex client that honors `AGENTS.md`
- Node.js 18+
- npm 9+
- Playwright Chromium installed, or available for `/home-ops init` to install automatically
- Optional: Python 3.10+ for enhanced school metadata crawling; `/home-ops init` attempts sidecar setup automatically

## Install

```bash
npm run bootstrap
```

The browser-session commands used by `/home-ops init` run this bootstrap automatically when dependencies or Playwright Chromium are missing. Init also runs Python sidecar setup and can attempt a Windows Python install through `winget` when Python is missing.

## Recommended Starting Prompts

- `Initialize the portal browser session with Home-Ops.`
- `Set up or revise my buyer profile with Home-Ops.`
- `Estimate my home affordability range with Home-Ops.`
- `Run the full hunt workflow with Home-Ops.`
- `Evaluate this listing URL with Home-Ops.`
- `Evaluate the pending pipeline with Home-Ops.`
- `Scan my configured portals for new listings.`
- `Reset the generated Home-Ops scan data but keep my profiles.`
- `Compare these three homes.`
- `Do a deep dive on this neighborhood.`

## Routing Map

| User intent | Files Codex should read |
|-------------|-------------------------|
| Buyer profile setup or refresh | `modes/_shared.md` + `modes/profile.md` |
| Affordability estimate or price-range refresh | `modes/_shared.md` + `modes/afford.md` |
| Portal login setup or refresh | `modes/_shared.md` + `modes/init.md` |
| Full reset-scan-evaluate workflow | `modes/_shared.md` + `modes/hunt.md` |
| Raw listing URL | `modes/_shared.md` + `modes/evaluate.md` |
| Single evaluation | `modes/_shared.md` + `modes/evaluate.md` |
| Evaluate with no explicit target | `modes/_shared.md` + `modes/evaluate.md` + `data/pipeline.md` |
| Multiple homes | `modes/_shared.md` + `modes/compare.md` |
| Portal scan | `modes/_shared.md` + `modes/scan.md` |
| Reset generated working state | `modes/_shared.md` + `modes/reset.md` |
| Tracker summary or updates | `modes/_shared.md` + `modes/tracker.md` |
| Deep property or area research | `modes/_shared.md` + `modes/deep.md` |

## Behavioral Rules

- Keep buyer-specific content in `buyer-profile.md`, `config/profile.yml`, `modes/_profile.md`, or `portals.yml`.
- Treat learned facts under `output/knowledge/`, `output/areas/`, and output sidecar directories as durable user-layer data. Ordinary reset/hunt work must preserve them.
- Put scratch or one-off scripts under `.home-ops/tmp/{commandId}/` or OS temp and remove them after use.
- Never verify listing status with generic fetch alone when Playwright is available.
- Never contact agents, schedule tours, or submit offers for the user.
- Do not add or change git remotes unless the user explicitly asks.

## Verification

```bash
npm run doctor
npm run sync-check
npm run verify
npm run temp:check
```
