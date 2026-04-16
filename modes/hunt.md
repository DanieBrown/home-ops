# Mode: hunt -- Full Reset, Scan, and Batch Evaluation

Use this mode when the user wants one command to clear generated state, discover fresh listings, and batch-evaluate the refreshed pipeline.

## Read First

- `modes/_shared.md`
- `modes/_profile.md`
- `buyer-profile.md`
- `config/profile.yml`
- `portals.yml`
- `data/listings.md`
- `data/pipeline.md`
- `data/scan-history.tsv` if it exists
- `output/browser-sessions/chrome-host/session-state.json` if it exists
- `batch/logs/browser-sessions.tsv` if it exists
- `modes/reset.md`
- `modes/scan.md`
- `modes/evaluate.md`

## Goal

Run the bulk intake flow in this exact order:

1. `reset`
2. `scan`
3. `evaluate`

The user asked for a simpler top-level command, not a replacement for the separate commands. Keep `reset`, `scan`, and `evaluate` available as independent workflows for flexible use.

## Prerequisite

`hunt` depends on an existing hosted browser session that was already created through `/home-ops init` and is still open.

Rules:
- Check the hosted browser session first.
- If the session is missing, closed, or not CDP-reachable, stop immediately and tell the user to run `/home-ops init` first.
- `hunt` must not bootstrap, refresh, or recreate the login session by itself.

## Optional Flags

If the command arguments include scan platform flags such as:

- `--zillow`
- `--redfin`
- `--relator`

apply those flags only to the `scan` phase.

Rules:
- `reset` still clears the generated working state.
- `reset` should preserve `data/shortlist.md` when `config/profile.yml` sets `workflow.shortlist.preserve_on_reset: true`.
- `evaluate` still runs with no explicit listing target against the pipeline created by the scan phase.

## Execution Order

### 1. Session Check

- Confirm the hosted browser session is still open and reusable.
- If the session is not ready, stop before touching generated state.

### 2. Reset Phase

- Execute the existing reset workflow first.
- Prefer the checked-in script:
  - Windows PowerShell: `npm.cmd run reset:data`
  - Other shells: `npm run reset:data`
- Run `node verify-pipeline.mjs` after the reset, following the reset-mode instructions.

### 3. Scan Phase

- Run the scan workflow next using the same hosted browser session.
- Reuse the exact scan-mode rules for platform filters, session checks, per-source caps, and anti-bot stops.
- If Zillow or another selected portal blocks on login or human verification, stop the hunt and report the blocker instead of moving on to evaluate.

### 4. Evaluate Phase

- Run the evaluate workflow with no explicit target against the refreshed pipeline.
- Reuse the existing batch-evaluate rules, including canonical-property dedupe, 5-property worker slices, staged tracker additions, and serialized browser-backed verification.
- Let evaluate handle the top-10 review tab behavior at the end of the batch.

## Important Rules

- Do not parallelize `reset`, `scan`, and `evaluate` against each other.
- The hunt command is intentionally destructive to generated working state because it starts with `reset`.
- If the user wants to preserve existing reports, tracker rows, or pipeline contents, direct them to the separate commands instead of changing hunt behavior.
- If scan finds no new qualifying listings, still report that outcome clearly before the evaluate phase completes with no-op or empty results.

## Output Summary

Return a concise summary with:
- whether the hosted browser session prerequisite passed
- reset actions completed
- scan platforms and counts
- listings added to the pipeline
- canonical properties evaluated
- reports written
- tracker updates merged
- any blockers or remaining backlog