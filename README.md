# Home-Ops

Home-Ops is an AI-assisted home search pipeline for evaluating listings, comparing tradeoffs, scanning portals, tracking decisions, and researching neighborhoods.

Phase 1 is intentionally lean:
- evaluate one listing
- compare multiple homes
- scan configured portals
- track listing status
- run deeper neighborhood or school research

The system is built for decision quality, not volume. It should help the buyer reject weak listings quickly and focus energy on the few homes worth touring.

## Core Features

- Listing evaluation with hard-requirement gating and 1.0 to 5.0 scoring
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

Then create or customize:
- `buyer-profile.md`
- `config/profile.yml`
- `portals.yml`

## Commands

The main command surface is:

```text
/home-ops {listing-url}
/home-ops evaluate
/home-ops compare
/home-ops scan
/home-ops tracker
/home-ops deep
```

The same modes are available through the OpenCode command wrappers in `.opencode/commands/`.

## Data Files

- `buyer-profile.md` — buyer brief and non-structured preferences
- `config/profile.yml` — structured configuration
- `portals.yml` — scan targets and platform settings
- `data/listings.md` — canonical tracker
- `data/pipeline.md` — pending listing inbox
- `data/scan-history.tsv` — scan dedup log
- `reports/` — saved evaluation reports

## Verification Model

Home-Ops uses Playwright to verify whether a listing is still active. Listing facts come from the platform page first. Neighborhood, school, and development context come from public sources such as GreatSchools, Niche, local government sites, local news, and community discussion where available.

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
