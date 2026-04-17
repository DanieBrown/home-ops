# Setup Guide

## Prerequisites

- Claude Code, Codex, or another compatible local coding agent
- Node.js 18+
- Playwright browser binaries for listing verification
- Optional: Go 1.21+ for the terminal dashboard

## First-Time Setup

### 1. Install dependencies

```bash
npm install
npx playwright install chromium
```

Create the reusable repo-local hosted browser session after you configure `portals.yml`:

```bash
/home-ops init

# low-level terminal equivalent
npm run browser:setup
```

This command reads the login-required browser targets from `portals.yml`, launches a real local hosted browser window with CDP enabled and a separate repo-local user-data-dir under `output/browser-sessions/chrome-host`, opens the configured base pages for sites such as Zillow, Redfin, Realtor.com, Facebook, and Nextdoor, writes status to `output/browser-sessions/chrome-host/session-state.json`, and appends lifecycle events to `batch/logs/browser-sessions.tsv`. It prefers Chrome, but now falls back to Edge or Chromium when Chrome is unavailable.

For a targeted refresh instead of the full configured set:

```bash
/home-ops init --zillow --redfin --relator
/home-ops init --facebook --nextdoor
/home-ops init --greatschools

# low-level terminal equivalents
npm run browser:session -- --hosted --zillow --channel chrome
npm run browser:session -- --hosted --redfin --channel chrome
npm run browser:session -- --hosted --relator --channel chrome
npm run browser:session -- --hosted --facebook --nextdoor --channel chrome
npm run browser:session -- --hosted --greatschools --channel chrome
```

`--greatschools` opens the direct GreatSchools home page inside the hosted browser session without changing the default login-required setup set.

Sign in manually in the opened browser window, complete any captcha or anti-bot challenge yourself, and keep the browser running while Home-Ops attaches to it for scanning or verification. Check the repo-local hosted browser status with:

```bash
npm run browser:status
```

Realtor.com may still return a request-processing block page even with a real browser session. Treat that as blocked and retry later rather than assuming the session is valid.

Google explicitly blocks sign-in from browsers controlled through software automation, so Google-based sign-in should be attempted in the hosted real Chrome window, not inside a Playwright-launched browser. If a portal still rejects Google or Apple sign-in, try the site's direct email/password login form instead of federated OAuth.

On Windows PowerShell, use `npm.cmd` instead of `npm` if execution policy blocks `npm.ps1`.

### 2. Run the repo health check

```bash
node doctor.mjs
```

This validates the expected folders and creates missing system directories.

### 3. Fill in the buyer layer

Home-ops expects these files:

- `buyer-profile.md`
- `config/profile.yml`
- `modes/_profile.md`
- `portals.yml`

If a file is missing, use the matching template or let the agent walk through onboarding.

If you want guided setup instead of manual editing, run `/home-ops profile` and let Home-Ops collect the buyer criteria interactively.

### 4. Verify the buyer configuration

```bash
node profile-sync-check.mjs
node verify-pipeline.mjs
```

### 5. Start using the workflow

Typical entry points:

- Run `/home-ops profile` when you want to create or refresh the buyer-layer files interactively.
- Run `/home-ops init` before the first scan or whenever the portal login session needs to be refreshed.
- Run `/home-ops hunt` when you want one command to reset generated state, scan fresh listings, and batch-evaluate them. Keep the hosted browser session open first.
- Paste a listing URL to evaluate a single home.
- Run `/home-ops evaluate` with no arguments to process the unchecked entries in `data/pipeline.md`.
- Run `/home-ops-scan` to look for new listings from configured portal searches.
- Run `/home-ops reset` when you want to clear generated reports, tracker rows, pipeline items, and scan history without touching profiles or browser sessions.
- Run `/home-ops-tracker` to review or update tracker status.
- Run `/home-ops-deep` for school, neighborhood, and development research.

When `/home-ops evaluate` runs without an explicit target, it should persist up to ten viable newly evaluated homes into `data/shortlist.md` and open that saved cohort in one hosted-Chrome tab group titled `Top 10`. When `/home-ops compare` ranks evaluated homes, it can overwrite the same file with up to the top ten viable comparison tags and reopen those pages for side-by-side review. When `/home-ops deep` is then asked to work on the shortlist, it should launch one subagent per shortlisted home, save the batch brief to `reports/deep-shortlist-{YYYY-MM-DD}.md`, update `data/shortlist.md` with a refined post-deep top three, and replace the remaining Chrome home tabs with only those finalist listing pages.

Use `npm run plan:research -- --shortlist --type development` or `npm.cmd run plan:research -- --shortlist --type development` when deep needs a development-first source plan from `portals.yml`, and run `npm run gate:finalists` or `npm.cmd run gate:finalists` before promoting the refined top 3. The final `shortlist-top3` review helper enforces the same gate unless `--skip-finalist-gate` is used explicitly.

Use `npm run browser:review` or `npm.cmd run browser:review` on Windows PowerShell when you need the low-level review-tab helper directly.

When `/home-ops evaluate` runs without a target, Home-Ops should deduplicate the pending pipeline by property, split the canonical set into 5-property worker batches, assign one subagent per batch, stage tracker additions under `batch/tracker-additions/`, merge them into `data/listings.md`, and move handled items into the `Processed` section of `data/pipeline.md`. The main agent should keep dispatching those batches until the full pending set has been attempted.

After evaluate or deep writes reports, run `node research-coverage-audit.mjs` or `npm.cmd run audit:research` on Windows PowerShell to check whether neighborhood, school, and development evidence was actually sourced. If the audit or finalist gate flags school or development gaps, run `node research-source-plan.mjs <report-path> --type all` or `npm.cmd run plan:research -- <report-path> --type all` to turn the configured `portals.yml` inventories into concrete source URLs and lookup targets.

When `/home-ops scan` runs, Home-Ops should keep at most 3 unchecked pending listings per source per configured area. If a Zillow, Redfin, or Realtor.com area bucket already has 3 or more pending entries, Home-Ops should clear that source-area bucket first and then refresh it with up to 3 current homes from that source and area.
The pending list may contain the same home from multiple sources at once, but it should not keep duplicate URLs or same-source duplicate homes. `data/scan-history.tsv` should continue to log scan outcomes, but it should not block later area-bucket refills.
If Zillow blocks on sign-in or human verification during scan mode, Home-Ops should skip Zillow for the rest of that scan, continue with the other platforms, and tell the user how to rerun `/home-ops scan --zillow` after clearing the blocker.

When you need a saved browser session for Playwright-backed checks, reuse it with:

```bash
node check-liveness.mjs --profile chrome-host <listing-url>
```

## Buyer Files

Use these files for buyer-specific changes:

- `buyer-profile.md`: narrative priorities and constraints
- `config/profile.yml`: structured thresholds, weights, and finance assumptions
- `modes/_profile.md`: preference overrides for prompt behavior
- `portals.yml`: search URLs and source configuration

Do not put buyer-specific rules into `modes/_shared.md`.

## Dashboard Build

If Go is installed, the simplest repo-level launcher is:

```bash
npm run dashboard
```

This command resolves Go from PATH or common Windows install locations, then runs the dashboard against the current repository.

To build a standalone dashboard binary, run:

```bash
npm run dashboard:build
```

If you prefer the direct Go commands, build the terminal dashboard with:

```bash
cd dashboard
go build -o home-ops-dashboard .
```

Run it from the dashboard directory with:

```bash
./home-ops-dashboard --path ..
```

## Recommended Checks Before Use

```bash
node doctor.mjs
node profile-sync-check.mjs
node verify-pipeline.mjs
node research-coverage-audit.mjs
node test-all.mjs --quick
```

## Reset Generated State

If you want a clean slate while keeping buyer-specific setup and portal sessions:

```bash
/home-ops reset

# low-level terminal equivalents
npm run reset:data
npm run reset:data -- --dry-run
```

On Windows PowerShell, use `npm.cmd` instead of `npm` if needed.
