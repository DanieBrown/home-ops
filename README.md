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

> The next steps should be taken within the copilot chat or CLI of your choice.
> Some commands are still being utilized with copilot, if you are using vs code make sure to enable the "Use Claude Hooks" in the vs code settings for optimal performance.
> On Windows PowerShell, use `npm.cmd` instead of `npm` if `npm.ps1` is blocked.

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

## Core commands
- `/home-ops init`: refresh portal browser sessions
- `/home-ops scan`: find new listings from saved searches
- `/home-ops evaluate`: review pending listings or one target
- `/home-ops deep`: research a home, school, or area
- `/home-ops {listing-url}`: evaluate one listing
- `/home-ops hunt`: reset, scan, and evaluate sequentially
- `/home-ops tracker`: review and update listing statuses


## Tips
- `/home-ops` Will print a copy of relevant commands to use


