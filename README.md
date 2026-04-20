# Home-Ops

## Prerequisites
- Node.js 18+
- npm 9+
- Playwright Chromium (`npx playwright install chromium`)
- Optional: Go 1.21+ (dashboard only)

## Get started (run in order)
1. Install dependencies:
```bash
npm install
npx playwright install chromium
```
2. Run setup checks:
```bash
npm run doctor
npm run sync-check
npm run verify
```
3. Create/update buyer files (interactive):
```bash
/home-ops profile
```
4. Generate portal URLs after profile setup:
```bash
npm run portals:generate
```
5. Start/reuse hosted browser session:
```bash
/home-ops init
```
6. Run intake pipeline end-to-end:
```bash
/home-ops hunt
```

## Daily command order
1. `/home-ops init` (if browser session needs refresh)
2. `/home-ops scan`
3. `/home-ops evaluate`
4. `/home-ops compare`
5. `/home-ops deep`

## Core commands
- `/home-ops {listing-url}`: evaluate one listing
- `/home-ops hunt`: reset -> scan -> evaluate
- `/home-ops tracker`: review/update statuses
- `npm run brief:top3`: generate top-3 PDF briefing

> On Windows PowerShell, use `npm.cmd` instead of `npm` if `npm.ps1` is blocked.
