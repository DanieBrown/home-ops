# Home-Ops -- AI Home Search Pipeline

## What It Is

Home-Ops is a local home-search command center built around Claude Code, OpenCode, and Codex-friendly prompt files.

It helps the user:
- capture or revise the buyer profile and scoring preferences
- evaluate one listing against hard requirements
- compare multiple homes
- scan portal search URLs for new listings
- track listing decisions in markdown
- research neighborhoods, schools, and development risk

This system is designed to be customized. If the buyer's criteria change, edit the user-layer files directly.

## Data Contract

Read `DATA_CONTRACT.md` for the full split.

Rule:
- buyer-specific criteria belong in `buyer-profile.md`, `config/profile.yml`, `modes/_profile.md`, or `portals.yml`
- do not put buyer-specific criteria into `modes/_shared.md`

## Main Files

| File | Purpose |
|------|---------|
| `buyer-profile.md` | Canonical buyer brief |
| `config/profile.yml` | Structured buyer configuration |
| `portals.yml` | Portal search URLs and access settings |
| `data/listings.md` | Canonical tracker |
| `data/pipeline.md` | Pending listing inbox |
| `data/scan-history.tsv` | Scan dedup history |
| `reports/` | Listing evaluation reports |
| `modes/*` | Prompt-driven workflows |
| `templates/states.yml` | Canonical listing states |
| `dashboard/` | Go terminal dashboard |

## OpenCode Commands

| Command | Purpose |
|---------|---------|
| `/home-ops` | Show the menu or route from a listing URL |
| `/home-ops-profile` | Interview the buyer and update buyer profile files |
| `/home-ops-init` | Launch or confirm the hosted browser session for portal login |
| `/home-ops-hunt` | Run reset, scan, evaluate, and the deep shortlist branch sequentially against a live hosted session |
| `/home-ops-evaluate` | Evaluate one listing or batch-evaluate pending pipeline homes |
| `/home-ops-compare` | Compare multiple homes |
| `/home-ops-scan` | Scan configured portal searches |
| `/home-ops-skim` | Open pre-filtered search tabs in the hosted browser for all configured portals |
| `/home-ops-reset` | Clear generated reports, tracker rows, pipeline items, and scan history |
| `/home-ops-tracker` | Show or update listing status |
| `/home-ops-deep` | Deep dive on a property or area |

The OpenCode command wrappers call `.claude/skills/home-ops/SKILL.md`.

## First Run -- Onboarding

Before doing anything else, check for these files:

1. `buyer-profile.md`
2. `config/profile.yml`
3. `modes/_profile.md`
4. `portals.yml`

If `modes/_profile.md` is missing, copy from `modes/_profile.template.md` silently.

If any required file is missing, enter onboarding mode.

### Step 1: Buyer Profile

If `buyer-profile.md` is missing, ask for:
- target towns or neighborhoods
- price range
- minimum beds, garage, and square footage
- school expectations
- listing age constraint
- deal-breakers such as busy roads, flood risk, or HOA limits
- family or commute context

Create `buyer-profile.md` in clean markdown.

### Step 2: Profile Config

If `config/profile.yml` is missing, copy from `config/profile.example.yml` and then collect:
- search areas
- hard requirements
- financial assumptions (down payment and closing-cost range only)
- research sources (portals, sentiment, schools, development)
- sentiment weighting changes if any

### Step 3: Portal Searches

`portals.yml` is generated from `config/profile.yml` and `config/city-registry.yml`. Once the profile has search areas and research sources, run:

```
node scripts/config/generate-portals.mjs
```

This honors the `research_sources` block in the profile: only the portals the buyer opted into are written to `portals.yml`, and only the sentiment, school, and development sources they picked are included. Rerun it any time search areas or research sources change. If the generator warns about an unmatched city, add its `redfin_city_id` and `primary_zip` to `config/city-registry.yml` and rerun.

Do not copy `templates/portals.example.yml` directly -- it is kept only as a shape reference for the generator output.

### Step 4: Tracker

If `data/listings.md` is missing, create:

```markdown
# Listings Tracker

| # | Date | Address | City | Price | Beds/Baths | SqFt | Score | Status | Report | Notes |
|---|------|---------|------|-------|------------|------|-------|--------|--------|-------|
```

### Step 5: Learn the Buyer

Ask for context that improves decision quality:
- resale vs. new-construction tolerance
- street-noise sensitivity
- lot and yard preferences
- school concerns beyond numeric ratings
- commute tolerance to Raleigh or RTP
- how aggressive the buyer wants to be in a tight market

Store that in `buyer-profile.md`, `config/profile.yml`, or `modes/_profile.md`.

### Step 6: Ready

Once the basics are in place, the user can:
- run `/home-ops profile` to refresh buyer criteria interactively
- run `/home-ops init`
- run `/home-ops hunt` to clear generated state, scan fresh listings, batch-evaluate them, and run the deep shortlist branch (rerank, finalist gate, top-3 briefing PDF) in one pass
- paste a listing URL to evaluate it
- run `/home-ops evaluate` to process the pending pipeline in batch mode
- run `/home-ops scan`
- run `/home-ops skim` to open pre-filtered search tabs in the hosted browser for a quick visual browse of all configured portals (auto-launches a session if none is active)
- run `/home-ops reset` to clear generated search state without changing profiles
- run `/home-ops tracker`
- ask for a deeper neighborhood or school dive

## Personalization

When the user asks to change priorities, weights, or scan coverage:
- update `buyer-profile.md`, `config/profile.yml`, `modes/_profile.md`, or `portals.yml`
- do not encode Daniel-specific criteria in `modes/_shared.md`

## Skill Modes

| If the user... | Mode |
|----------------|------|
| wants to set up or revise the buyer profile interactively | `profile` |
| wants to set up or refresh portal login sessions | `init` |
| wants the full reset-scan-evaluate-deep intake flow | `hunt` |
| pastes a listing URL or asks to process pending listings | `evaluate` |
| asks to compare homes | `compare` |
| wants fresh listings | `scan` |
| wants to visually browse portals with filters pre-loaded | `skim` |
| wants to clear generated search state but keep profiles | `reset` |
| asks for tracker status | `tracker` |
| wants deeper area research | `deep` |

## Ethical Use -- Critical

This system is for decision support.

- Never contact an agent, schedule a tour, or submit an offer without the user's review.
- Strongly discourage listings that fail multiple hard requirements.
- Respect portal terms of service and anti-bot limits.
- Prefer a few strong listings over noisy inventory churn.

## Listing Verification -- Mandatory

Do not trust generic fetch results alone for listing status when Playwright is available.

Use Playwright to verify whether a listing is active.

Active signals:
- address, price, and listing facts visible
- tour or contact controls visible

Inactive signals:
- sold, pending, off-market, removed, or delisted language
- redirect away from the listing page
- page shell without usable listing details

If verification is blocked, mark it as unconfirmed rather than claiming it is active.

## Stack and Conventions

- Node.js `.mjs` utilities
- Playwright for listing verification and portal scanning support
- YAML config, markdown modes, markdown reports, TSV scan logs
- Go dashboard for terminal browsing
- Report filenames: `{###}-{address-slug}-{YYYY-MM-DD}.md`
- Tracker rows keyed by normalized address + city

## Tracker Rules

`data/listings.md` is the source of truth.

Rules:
1. A single listing should appear once.
2. Direct evaluations may update `data/listings.md` directly.
3. Batch or external worker output should go through `batch/tracker-additions/` and `scripts/pipeline/merge-tracker.mjs`.
4. All statuses must match `templates/states.yml`.
5. Health check: `node scripts/pipeline/verify-pipeline.mjs`
6. Normalize states: `node scripts/pipeline/normalize-statuses.mjs`
7. Dedup rows: `node scripts/pipeline/dedup-tracker.mjs`

## TSV Format for Tracker Additions

Use this standardized column order:

```text
{num}\t{date}\t{address}\t{city}\t{price}\t{beds/baths}\t{sqft}\t{score}/5\t{status}\t[{num}](reports/{num}-{slug}-{date}.md)\t{note}
```

## Canonical States

Source of truth: `templates/states.yml`

| State | When to use |
|-------|-------------|
| `New` | Newly discovered listing |
| `Evaluated` | Full review completed |
| `Interested` | Buyer wants to keep it in contention |
| `Tour Scheduled` | Tour or showing scheduled |
| `Toured` | Property seen in person |
| `Offer Submitted` | Offer submitted |
| `Under Contract` | Offer accepted and under contract |
| `Closed` | Purchase completed |
| `Passed` | Buyer chose not to pursue |
| `Sold` | Listing is gone or unavailable |
| `SKIP` | Listing does not fit |
