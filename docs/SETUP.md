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

### 4. Verify the buyer configuration

```bash
node profile-sync-check.mjs
node verify-pipeline.mjs
```

### 5. Start using the workflow

Typical entry points:

- Paste a listing URL to evaluate a single home.
- Run `/home-ops-scan` to look for new listings from configured portal searches.
- Run `/home-ops-tracker` to review or update tracker status.
- Run `/home-ops-deep` for school, neighborhood, and development research.

## Buyer Files

Use these files for buyer-specific changes:

- `buyer-profile.md`: narrative priorities and constraints
- `config/profile.yml`: structured thresholds, weights, and finance assumptions
- `modes/_profile.md`: preference overrides for prompt behavior
- `portals.yml`: search URLs and source configuration

Do not put buyer-specific rules into `modes/_shared.md`.

## Dashboard Build

If Go is installed, build the terminal dashboard with:

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
node test-all.mjs --quick
```
