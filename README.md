# Home-Ops
A dedicated home hunting application that takes in your preferences and applys them to multiple search engines to determine the best house on the market for you. Utilizing semantic weight measurements and resources from local information sites (For now, limited to NC).

## Prerequisites
- Node.js 18+
- npm 9+
- Playwright Chromium (auto-installed by `/home-ops init` when missing)
- Optional: Python 3.10+ for enhanced school metadata crawling (`/home-ops init` attempts setup automatically)

## Get started (run in order)
1. Optional manual dependency setup:
```bash
npm run bootstrap
```
`/home-ops init` and the browser-session npm scripts run this automatically. It installs the project packages and Playwright Chromium when they are missing. During init, Home-Ops also attempts Python sidecar setup; on Windows it can use `winget` to install Python 3.12 if Python is missing.

Manual equivalent:
```bash
npm install
npx playwright install chromium
npm run bootstrap:python
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

3. Create/update buyer files. This also regenerates `portals.yml` from your source picks:
```bash
/home-ops profile
```
4. Optional affordability check before scanning:
```bash
/home-ops afford
```
5. Start/reuse hosted browser session:
```bash
/home-ops init
```
6. Run intake pipeline end-to-end:
```bash
/home-ops hunt
```

## Core commands
- `/home-ops`: show the command menu
- `/home-ops profile`: interview the buyer and update the profile files
- `/home-ops afford`: estimate conservative affordability and optionally update price range
- `/home-ops init`: refresh portal browser sessions
- `/home-ops init --relator --refresh-site-data`: clear one portal's cookies/cache/site data and open a clean homepage for manual verification
- `/home-ops scan`: find new listings from saved searches
- `/home-ops skim`: open pre-filtered search tabs for every configured portal
- `/home-ops evaluate`: review pending listings or one target
- `/home-ops {listing-url}`: evaluate one listing
- `/home-ops compare`: compare and rank multiple homes
- `/home-ops deep`: research a home, school, or area — one URL, several URLs, or the whole shortlist
- `/home-ops hunt`: reset, scan, batch-evaluate, then run the deep shortlist branch (rerank, finalist gate, top-3 briefing PDF) in one pass
- `/home-ops tracker`: review and update listing statuses
- `/home-ops reset`: clear generated search state while keeping the buyer profile

Platform selectors (`--zillow`, `--redfin`, `--relator`, `--homes`) work on
`init`, `scan`, and `skim`.

Every underlying `npm run` script is listed in
[`docs/COMMANDS.md`](docs/COMMANDS.md) with its flags — including the
update/rollback subsystem, the cache utilities, and the individual research
capture scripts.


## Tips
- `/home-ops` Will print a copy of relevant commands to use


