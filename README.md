# Home-Ops

Home-Ops is an AI-assisted home search pipeline for evaluating listings, comparing tradeoffs, scanning portals, tracking decisions, and researching neighborhoods.

Phase 1 is intentionally lean:
- evaluate one listing or batch-evaluate the pending pipeline
- compare multiple homes
- scan configured portals
- track listing status
- run deeper neighborhood or school research

The system is built for decision quality, not volume. It should help the buyer reject weak listings quickly and focus energy on the few homes worth touring.

## Core Features

- Listing evaluation with hard-requirement gating and 1.0 to 5.0 scoring
- Batch evaluation of pending pipeline homes with dedupe and safe tracker merges
- Neighborhood, school, and development-risk research
- Portal scanning through saved Zillow, Redfin, and Realtor.com searches
- Markdown tracker with status normalization, deduplication, and verification scripts
- Go dashboard for a terminal-based view of the pipeline

## Quick Start

```bash
npm install
npx playwright install chromium
npm run doctor

cp config/profile.example.yml config/profile.yml
cp templates/portals.example.yml portals.yml
cp modes/_profile.template.md modes/_profile.md
```

If Zillow, Redfin, or Realtor.com reject the default Playwright browser during sign-in, use the hosted real-Chrome setup path instead of logging in inside a Playwright-launched browser:

```bash
/home-ops init

# low-level terminal equivalent
npm run browser:setup
```

`browser:setup` reads `portals.yml`, launches a real local Chrome window with a separate repo-local user-data-dir under `output/browser-sessions/chrome-host`, opens the configured login-required platform home pages, writes session state to `output/browser-sessions/chrome-host/session-state.json`, and appends lifecycle entries to `batch/logs/browser-sessions.tsv`. Playwright can later attach to that running browser over CDP instead of forcing login to happen inside an automated browser instance.

If you only need to refresh one platform, run a targeted bootstrap such as:

```bash
/home-ops init --zillow --redfin --relator

# low-level terminal equivalents
npm run browser:session -- --hosted --zillow --channel chrome
npm run browser:session -- --hosted --redfin --channel chrome
npm run browser:session -- --hosted --relator --channel chrome
```

Leave the hosted browser running while you scan or verify listings. Check the current repo-local session status with `npm run browser:status`. Reuse that session in Playwright-backed checks with `node check-liveness.mjs --profile chrome-host <listing-url>`. Realtor.com may still return a block page even with a real browser session; treat that as blocked rather than active.

To launch the terminal dashboard with one repo-level command, run `npm run dashboard`. To build a standalone dashboard binary, run `npm run dashboard:build`.

On Windows PowerShell, use `npm.cmd` instead of `npm` if execution policy blocks `npm.ps1`.

Then create or customize:
- `buyer-profile.md`
- `config/profile.yml`
- `portals.yml`

## Commands

The main command surface is:

```text
/home-ops {listing-url}
/home-ops init
/home-ops init --zillow --redfin --relator
/home-ops evaluate
/home-ops evaluate {listing-url-or-address}
/home-ops compare
/home-ops scan
/home-ops scan --zillow --redfin --relator
/home-ops reset
/home-ops tracker
/home-ops deep
```

`/home-ops {listing-url}` or `/home-ops evaluate {listing-url-or-address}` evaluates one property.

`/home-ops evaluate` with no explicit target reads unchecked entries from `data/pipeline.md`, deduplicates the same property across Zillow, Redfin, and Realtor.com links, splits the canonical set into 5-property worker batches, assigns one subagent per batch, and merges the results into `data/listings.md`. The run should keep dispatching those batches until the full pending set has been attempted, and it should clearly report any backlog left behind by blockers or runtime limits.

Use `/home-ops init` to create or refresh the hosted browser session first. Scan flags now narrow the scan scope only; they no longer bootstrap login sessions. `--relator` is the preferred flag for Realtor.com.
For portals that reject automated sign-in, prefer the hosted real-Chrome setup path over the Playwright-managed login path.
When a scan reuses a hosted search-results tab, Home-Ops refreshes that exact tab before extracting cards. If Zillow responds with a press-and-hold challenge, the refreshed tab is brought to the front and Home-Ops tells you to clear it manually before rerunning the scan.
Scan mode keeps at most 3 unchecked pending homes per source per configured area. If a Zillow, Redfin, or Realtor.com area bucket already has 3 or more pending homes, Home-Ops clears that source-area bucket and refreshes it with up to 3 current homes from that engine for that area. The pending list may contain the same home from multiple sources at once, but it does not keep duplicate URLs or same-source duplicate homes.
Bucket refill uses the current search results instead of suppressing older URLs from `data/scan-history.tsv`, so each engine can repopulate its own area buckets on later scans.
If Zillow hits a sign-in, press-and-hold, or similar human-verification blocker during scan mode, Home-Ops pauses immediately and requires the user to restore the Zillow session before continuing the scan.

`/home-ops reset` clears generated reports, tracker rows, staged tracker TSVs, pipeline items, and scan history while keeping buyer profiles, portal configuration, and browser session data. The low-level terminal equivalent is `npm run reset:data` or `npm.cmd run reset:data` on Windows PowerShell.

Batch evaluation should stage tracker additions through `batch/tracker-additions/` and merge them with `merge-tracker.mjs` instead of having multiple workers edit `data/listings.md` directly. Browser-backed listing verification should remain serialized even when the workload is divided into 5-property worker batches.

The same modes are available through the OpenCode command wrappers in `.opencode/commands/`.

`/home-ops compare` should write up to the latest top ten viable ranked homes to `data/shortlist.md` using persistent compare tags and open those shortlisted listing pages in separate browser tabs for review. `/home-ops deep` can then use that shortlist file to run a batch deep dive on those tagged homes, save the batch brief to `reports/deep-shortlist-{date}.md`, rerank that same shortlist down to a refined top three with the deeper research folded in, and open the finalist listing pages in separate tabs.

## Data Files

- `buyer-profile.md` — buyer brief and non-structured preferences
- `config/profile.yml` — structured configuration
- `portals.yml` — scan targets and platform settings
- `data/listings.md` — canonical tracker
- `data/pipeline.md` — pending listing inbox
- `data/shortlist.md` — latest compare top-10 tags and deep handoff state
- `data/scan-history.tsv` — scan dedup log
- `reports/` — saved evaluation reports

## Verification Model

Home-Ops uses Playwright to verify whether a listing is still active. Listing facts come from the platform page first. Neighborhood, school, and development context come from public sources such as GreatSchools, Niche, local government sites, local news, and community discussion where available.

For portal logins and captcha prompts, Home-Ops expects manual completion inside a persistent local browser profile. It does not try to bypass platform bot checks automatically.

The browser-session artifacts are intentionally repo-local and ignored by git so each user can clone the repo, run the same setup command, and keep their platform session isolated.

If a portal still refuses Google or Apple single-sign-on inside the Playwright browser, use the site's direct email/password login path instead of federated OAuth.

The system does not depend on paid listing APIs in phase 1.

## Safety Rules

- Never contact an agent, schedule a tour, or submit an offer without the user's review.
- Never treat missing data as a positive signal.
- Never recommend a listing that clearly fails multiple hard requirements.
- Respect the terms of the sites being used.

## Repo Layout

```text
home-ops/
├── buyer-profile.md
├── config/
├── data/
├── reports/
├── dashboard/
├── modes/
├── templates/
├── .claude/skills/
├── .opencode/commands/
└── *.mjs
```

## Validation

```bash
npm run doctor
npm run sync-check
npm run verify
node test-all.mjs --quick
```

## License

MIT
