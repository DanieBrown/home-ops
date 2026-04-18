# Home-Ops

An AI-assisted home search pipeline built on Claude Code. It helps you evaluate listings, compare tradeoffs, scan portals, track decisions, and research neighborhoods — designed for decision quality, not inventory volume.

## Highlights

- Guided buyer-profile setup with weighted scoring that adapts to what you care about
- One-command hunt workflow that resets state, scans portals, and evaluates in a single run
- Hosted Chrome session so Zillow, Redfin, Realtor.com, Facebook, and Nextdoor logins survive across scans
- Deep-research workflow that fans out one subagent per shortlisted home and produces a clickable top-3 briefing PDF
- Markdown tracker with dedup, status normalization, and a Go-based terminal dashboard

## Quick Start

```bash
npm install
npx playwright install chromium
npm run doctor

cp config/profile.example.yml config/profile.yml
cp modes/_profile.template.md modes/_profile.md
# Edit config/profile.yml to set search.areas, hard_requirements, etc.
npm run portals:generate
```

`portals.yml` is generated from `config/profile.yml` and `config/city-registry.yml` — skip the old `cp templates/portals.example.yml portals.yml` step. Rerun `npm run portals:generate` any time you change search areas (the `/home-ops profile` flow does this for you automatically).

Then set up the hosted browser session so portal logins persist:

```bash
/home-ops init
```

From there, you can paste a listing URL, run a scan, or kick off a full hunt. If you'd rather answer a few questions than hand-edit config, run `/home-ops profile`.

> On Windows PowerShell, use `npm.cmd` instead of `npm` if execution policy blocks `npm.ps1`.

## Slash Commands

The main command surface. Each one routes through the Home-Ops skill.

| Command | What it does |
|---|---|
| `/home-ops` | Show the menu, or evaluate a listing when given a URL |
| `/home-ops {listing-url}` | Evaluate a single listing |
| `/home-ops profile` | Interview-style buyer-profile setup with multi-select defaults |
| `/home-ops init` | Launch or refresh the hosted Chrome session for portal logins |
| `/home-ops hunt` | Reset → scan → evaluate in one pass (requires an open hosted session) |
| `/home-ops evaluate` | Batch-evaluate the pending pipeline |
| `/home-ops evaluate {url-or-address}` | Evaluate one listing directly |
| `/home-ops compare` | Compare multiple homes and pick a top 10 |
| `/home-ops scan` | Scan configured portal searches for new listings |
| `/home-ops scan --zillow --redfin --relator` | Scope a scan to specific portals |
| `/home-ops reset` | Clear generated state (reports, tracker rows, pipeline, scan history) |
| `/home-ops tracker` | Show or update listing status |
| `/home-ops deep` | Deep dive on a property, area, or the current shortlist |

`/home-ops init` accepts the same portal flags as scan (`--zillow`, `--redfin`, `--relator`, `--facebook`, `--nextdoor`, `--greatschools`) when you only need to refresh one platform's login.

## npm Scripts

Lower-level scripts used by the slash commands or run directly when you want fine-grained control.

### Hosted browser session

| Script | Purpose |
|---|---|
| `npm run browser:setup` | Launch the hosted Chrome session (Chrome → Edge → Chromium fallback) |
| `npm run browser:setup:edge` | Launch the hosted session on Microsoft Edge |
| `npm run browser:status` | Show status of the `chrome-host` session |
| `npm run browser:session` | Low-level session control — see `--help` |
| `npm run browser:review -- <command>` | Open review tabs in the hosted session (used by `deep`) |

### Evaluate and scan

| Script | Purpose |
|---|---|
| `npm run scan` | Run a portal scan from the terminal |
| `npm run evaluate:pending` | Deterministic batch evaluator for the pending pipeline |
| `npm run liveness` | Playwright-backed listing liveness check |
| `npm run reset:data` | Low-level equivalent of `/home-ops reset` |

### Research pipeline

| Script | Purpose |
|---|---|
| `npm run plan:research` | Build a sentiment/school/development lookup plan from `portals.yml` |
| `npm run extract:sentiment` | Capture Facebook and Nextdoor evidence through the hosted session |
| `npm run check:construction` | Fetch NCDOT project-index pages and score construction pressure |
| `npm run prepare:deep` | Assemble a per-home packet for deep-mode subagents |
| `npm run audit:research` | Audit whether evidence was actually sourced vs. merely expected |
| `npm run gate:finalists` | Gate the refined top 3 against the strict research evidence bar |
| `npm run brief:top3` | Render the top-3 finalist PDF briefing and open it in hosted Chrome |

Add `--no-open` to `brief:top3` to render without opening a tab. Add `--shortlist` or `--top3` to the research scripts to scope them to the current cohort.

### Tracker maintenance

| Script | Purpose |
|---|---|
| `npm run normalize` | Normalize listing statuses against `templates/states.yml` |
| `npm run dedup` | Remove duplicate rows from the tracker |
| `npm run merge` | Merge staged tracker additions from `batch/tracker-additions/` |
| `npm run sync-check` | Verify profile files stay in sync |
| `npm run verify` | Pipeline health check |

### Caches

| Script | Purpose |
|---|---|
| `npm run cache:stats` | Show extraction cache hit rate and entry count |
| `npm run cache:clear` | Clear the extraction cache |
| `npm run cache:sentiment:stats` | Show sentiment cache stats |
| `npm run cache:sentiment:clear` | Clear the sentiment cache |

### System

| Script | Purpose |
|---|---|
| `npm run doctor` | Diagnose missing dependencies or config |
| `npm run dashboard` | Launch the Go terminal dashboard |
| `npm run dashboard:build` | Build a standalone dashboard binary |
| `npm run update:check` | Check for pipeline updates |
| `npm run update` | Apply updates |
| `npm run rollback` | Roll back the last update |
| `npm test` | Full repository self-test |

## Data Files

| File | Role |
|---|---|
| `buyer-profile.md` | Human-readable buyer brief |
| `config/profile.yml` | Structured buyer configuration and weights |
| `portals.yml` | Scan targets, login requirements, research sources |
| `modes/_profile.md` | Personalized mode guidance layered on top of `_shared.md` |
| `data/listings.md` | Canonical tracker |
| `data/pipeline.md` | Pending listings waiting to be evaluated |
| `data/shortlist.md` | Current top 10 and refined top 3 |
| `data/scan-history.tsv` | Scan dedup log |
| `reports/` | Saved evaluation and deep-dive reports |
| `output/` | Generated artifacts: sessions, packets, briefings, caches |

## How Verification Works

Home-Ops uses Playwright to confirm a listing is still active before reporting on it. Listing facts come from the portal page. Neighborhood, school, and development context come from public sources (GreatSchools, Niche, local government, local news, community posts) plus optional Facebook and Nextdoor evidence through the hosted session.

Portal sign-ins, captchas, and press-and-hold checks are handled manually in the hosted Chrome window — Home-Ops does not try to bypass bot checks. The browser session lives in a repo-local user-data-dir under `output/browser-sessions/` and is gitignored so each user keeps their own logins.

### Caching

Extraction work is cached under `output/cache/` to keep repeat runs cheap:

- Listings: URL-keyed with status-aware TTL (24h active, 30d inactive, 15m blocked)
- Sentiment: subdivision-keyed with a 6h TTL so shortlist siblings in the same neighborhood share a single sweep

Pass `--no-cache` or `--refresh-cache` to any script that supports them when you need fresh data.

## Safety Rules

- Never contact an agent, schedule a tour, or submit an offer without the user's review
- Never treat missing data as a positive signal
- Never recommend a listing that clearly fails multiple hard requirements
- Respect each portal's terms of service

## Repo Layout

```text
home-ops/
├── buyer-profile.md         # buyer brief (user-layer)
├── config/                  # profile.yml and examples
├── data/                    # tracker, pipeline, shortlist
├── reports/                 # saved evaluations
├── output/                  # sessions, packets, caches, briefings
├── modes/                   # prompt-driven workflows
├── templates/               # canonical states and portal examples
├── dashboard/               # Go terminal dashboard
├── .claude/skills/          # Claude Code skill definitions
├── .opencode/commands/      # OpenCode command wrappers
└── *.mjs                    # Node utilities
```

## Validation

```bash
npm run doctor
npm run verify
npm test -- --quick
```

## License

MIT
