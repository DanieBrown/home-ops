# Home-Ops

Home-Ops is an AI-assisted home search pipeline for evaluating listings, comparing tradeoffs, scanning portals, tracking decisions, and researching neighborhoods.

Phase 1 is intentionally lean:
- guided buyer-profile setup and weighting refresh
- evaluate one listing or batch-evaluate the pending pipeline
- run the full hunt workflow as one reset-scan-evaluate sequence
- compare multiple homes
- scan configured portals
- track listing status
- run deeper neighborhood or school research

The system is built for decision quality, not volume. It should help the buyer reject weak listings quickly and focus energy on the few homes worth touring.

## Core Features

- Interactive buyer-profile capture that updates the buyer-layer files
- Listing evaluation with hard-requirement gating and 1.0 to 5.0 scoring
- Batch evaluation of pending pipeline homes with dedupe and safe tracker merges
- One-command hunt workflow for reset, scan, and evaluate
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

`browser:setup` reads `portals.yml`, launches a real local hosted browser window with a separate repo-local user-data-dir under `output/browser-sessions/chrome-host`, opens the configured login-required browser targets such as Zillow, Redfin, Realtor.com, Facebook, and Nextdoor, writes session state to `output/browser-sessions/chrome-host/session-state.json`, and appends lifecycle entries to `batch/logs/browser-sessions.tsv`. It prefers local Chrome, but now falls back to Edge or Chromium when Chrome is not installed. Playwright can later attach to that running browser over CDP instead of forcing login to happen inside an automated browser instance.

If you only need to refresh one platform, run a targeted bootstrap such as:

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

`--greatschools` is the direct school-research bootstrap path. It does not change the default `browser:setup` target set, but it gives the hosted Playwright/CDP session a first-class GreatSchools target when you want direct school pages available in the browser instead of falling back to search snippets.

Leave the hosted browser running while you scan or verify listings. Check the current repo-local session status with `npm run browser:status`. Reuse that session in Playwright-backed checks with `node check-liveness.mjs --profile chrome-host <listing-url>`. Realtor.com may still return a block page even with a real browser session; treat that as blocked rather than active.

To launch the terminal dashboard with one repo-level command, run `npm run dashboard`. To build a standalone dashboard binary, run `npm run dashboard:build`.

On Windows PowerShell, use `npm.cmd` instead of `npm` if execution policy blocks `npm.ps1`.

Then create or customize:
- `buyer-profile.md`
- `config/profile.yml`
- `portals.yml`

If you want guided setup instead of manual edits, run `/home-ops profile` and let Home-Ops interview you and map the answers back into the buyer files.

## Commands

The main command surface is:

```text
/home-ops {listing-url}
/home-ops profile
/home-ops init
/home-ops hunt
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

`/home-ops profile` asks a guided series of questions using short default option sets, multi-select preference lists, and custom follow-ups when needed, then converts the answers into normalized weights and updates `buyer-profile.md`, `config/profile.yml`, and `modes/_profile.md`. Scan now syncs the portal filter ranges from `config/profile.yml` at runtime, so `portals.yml` mainly needs to keep the right area paths, source settings, and login prompts. The stored neighborhood and school weights currently guide evaluator judgment and research emphasis; phase 1 does not yet have a separate deterministic scoring engine that computes every subscore directly from structured source data.

`/home-ops hunt` runs `reset`, then `scan`, then `evaluate` in sequence. It requires that `/home-ops init` has already been run and that the hosted browser session is still open. Hunt is intentionally opinionated and destructive to generated state because it starts with reset; use the separate commands when you want finer control.

`/home-ops evaluate` with no explicit target reads unchecked entries from `data/pipeline.md`, deduplicates the same property across Zillow, Redfin, and Realtor.com links, splits the canonical set into 5-property worker batches, assigns one subagent per batch, and merges the results into `data/listings.md`. The run should keep dispatching those batches until the full pending set has been attempted, and it should clearly report any backlog left behind by blockers or runtime limits.

After a no-target evaluate batch finishes, Home-Ops should rank up to ten viable review candidates from that completed batch and open them in the hosted Chrome session inside one tab group named `Top 10`. Use `npm run browser:review -- reports <report-paths...> --group "Top 10"` or `npm.cmd run browser:review -- reports <report-paths...> --group "Top 10"` on Windows PowerShell.

Use `/home-ops init` to create or refresh the hosted browser session first. Scan flags now narrow the scan scope only; they no longer bootstrap login sessions. `--relator` is the preferred flag for Realtor.com.
For portals that reject automated sign-in, prefer the hosted real-Chrome setup path over the Playwright-managed login path.
When a scan reuses a hosted search-results tab, Home-Ops refreshes that exact tab before extracting cards. If Zillow responds with a press-and-hold challenge, the refreshed tab is brought to the front and Home-Ops tells you to clear it manually before rerunning the scan.
Scan mode keeps at most 3 unchecked pending homes per source per configured area. If a Zillow, Redfin, or Realtor.com area bucket already has 3 or more pending homes, Home-Ops clears that source-area bucket and refreshes it with up to 3 current homes from that engine for that area. The pending list may contain the same home from multiple sources at once, but it does not keep duplicate URLs or same-source duplicate homes.
Bucket refill uses the current search results instead of suppressing older URLs from `data/scan-history.tsv`, so each engine can repopulate its own area buckets on later scans.
If Zillow hits a sign-in, press-and-hold, or similar human-verification blocker during scan mode, Home-Ops skips Zillow for the rest of that scan, continues with the other platforms, and tells you to clear the blocker before rerunning `/home-ops scan --zillow`.

`/home-ops reset` clears generated reports, tracker rows, staged tracker TSVs, pipeline items, and scan history while keeping buyer profiles, portal configuration, and browser session data. If `config/profile.yml` sets `workflow.shortlist.preserve_on_reset: true`, reset also leaves `data/shortlist.md` alone so recurring hunt runs do not churn shortlist state. The low-level terminal equivalent is `npm run reset:data` or `npm.cmd run reset:data` on Windows PowerShell.

Batch evaluation should stage tracker additions through `batch/tracker-additions/` and merge them with `merge-tracker.mjs` instead of having multiple workers edit `data/listings.md` directly. Browser-backed listing verification should remain serialized even when the workload is divided into 5-property worker batches. `merge-tracker.mjs` now accepts either one staged row per TSV or multiple staged rows in the same TSV file so recovery workflows do not need one file per home.

The same modes are available through the OpenCode command wrappers in `.opencode/commands/`.

`/home-ops evaluate` with no explicit target should persist up to ten viable review candidates into `data/shortlist.md` and open that saved top-10 cohort in hosted Chrome. `/home-ops compare` can overwrite the same file with a compare-derived top ten. `/home-ops deep` should then read whichever top-10 cohort is current, launch one subagent per shortlisted home, synthesize the returned research in the main agent, rerank the field to a refined top three, and replace the remaining Chrome home tabs with only those finalist tabs.

Before deep promotes that refined top three, run `npm run gate:finalists` or `npm.cmd run gate:finalists`. The final `shortlist-top3` review-tab action now enforces the same strict research gate automatically and will block finalists whose reports still have weak neighborhood, school, or development coverage unless `--skip-finalist-gate` is used explicitly.

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

The source inventories in `portals.yml` are real configuration, but they are not yet a fully automated harvesting pipeline. They now do five jobs: they drive hosted-browser session setup for login-required sentiment sources, they define the expected research surface for evaluate and deep, they power the explicit post-run audit in `research-coverage-audit.mjs`, they feed the deterministic sentiment, school, and development planner in `research-source-plan.mjs`, and they support browser-backed Facebook and Nextdoor extraction through `sentiment-browser-extract.mjs`. Run `npm run plan:research -- --shortlist --type development` or `npm.cmd run plan:research -- --shortlist --type development` when you need a development-first lookup plan from the saved shortlist, run `npm run extract:sentiment -- --shortlist --profile chrome-host` or `npm.cmd run extract:sentiment -- --shortlist --profile chrome-host` when you want deterministic hosted-browser sentiment evidence before deep reranking, and run `npm run audit:research` or `npm.cmd run audit:research` after evaluate or deep when you need to see whether neighborhood, school, and development evidence was actually sourced versus merely expected by the prompts.

For Facebook groups, assume this workflow depends on the hosted Chrome session for manual, user-authenticated lookups. Nextdoor does offer approved developer APIs for public `anyone` content, trending posts, and public-agency feeds, but private neighborhood-feed sentiment still depends on manual, user-authenticated browsing unless an approved integration is added later. In both cases, prioritize the most recent 7 days of posts and comments when the goal is current neighborhood sentiment.

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
npm run plan:research -- --top3 --type development
npm run audit:research
npm run gate:finalists
node test-all.mjs --quick
```

## License

MIT
