# Codex Setup

Home-Ops supports Codex through the root `AGENTS.md` file.

If your Codex client reads project instructions automatically, `AGENTS.md` plus `CLAUDE.md` are enough for routing and behavior.

## Prerequisites

- A Codex client that honors `AGENTS.md`
- Node.js 18+
- Playwright Chromium installed
- Go 1.21+ if you want the dashboard

## Install

```bash
npm install
npx playwright install chromium
```

## Recommended Starting Prompts

- `Evaluate this listing URL with Home-Ops.`
- `Scan my configured portals for new listings.`
- `Compare these three homes.`
- `Do a deep dive on this neighborhood.`

## Routing Map

| User intent | Files Codex should read |
|-------------|-------------------------|
| Raw listing URL | `modes/_shared.md` + `modes/evaluate.md` |
| Single evaluation | `modes/_shared.md` + `modes/evaluate.md` |
| Multiple homes | `modes/_shared.md` + `modes/compare.md` |
| Portal scan | `modes/_shared.md` + `modes/scan.md` |
| Tracker summary or updates | `modes/_shared.md` + `modes/tracker.md` |
| Deep property or area research | `modes/_shared.md` + `modes/deep.md` |

## Behavioral Rules

- Keep buyer-specific content in `buyer-profile.md`, `config/profile.yml`, `modes/_profile.md`, or `portals.yml`.
- Never verify listing status with generic fetch alone when Playwright is available.
- Never contact agents, schedule tours, or submit offers for the user.
- Do not add or change git remotes unless the user explicitly asks.

## Verification

```bash
npm run doctor
npm run sync-check
npm run verify

# optional dashboard build
cd dashboard && go build ./...
```
