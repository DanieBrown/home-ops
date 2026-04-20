# Home-Ops
A dedicated home hunting application that takes in your preferences and applys them to multiple search engines to determine the best house on the market for you. Utilizing semantic weight measurements and resources from local information sites (For now, limited to NC).

## Prerequisites
- Node.js 18+
- npm 9+
- Playwright Chromium (`npx playwright install chromium`)
- Optional: Go 1.21+ (For dashboard only)

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
3. Create/update buyer files (Recommend using the dashboard wizard). This also regenerates `portals.yml` from your source picks:
```bash
/home-ops profile
```
4. Start/reuse hosted browser session:
```bash
/home-ops init
```
5. Run intake pipeline end-to-end:
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

## Tips
- `/home-ops` Will print a copy of relevant commands to use


