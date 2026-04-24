# Mode: hunt -- Full Reset, Scan, Batch Evaluation, and Deep Shortlist

Use this mode when the user wants one command to clear generated state, discover fresh listings, batch-evaluate the refreshed pipeline, and run the deep shortlist research flow that promotes a finalist top 3.

## Read First

- `modes/_shared.md`
- `modes/_profile.md`
- `buyer-profile.md`
- `config/profile.yml`
- `portals.yml`
- `data/listings.md`
- `data/pipeline.md`
- `data/shortlist.md` if it exists
- `data/scan-history.tsv` if it exists
- `output/browser-sessions/chrome-host/session-state.json` if it exists
- `batch/logs/browser-sessions.tsv` if it exists
- `modes/reset.md`
- `modes/scan.md`
- `modes/evaluate.md`
- `modes/deep.md`

## Goal

Run the bulk intake flow in this exact order:

1. `reset`
2. `scan`
3. `evaluate`
4. `deep` (shortlist batch branch)

The user asked for a simpler top-level command, not a replacement for the separate commands. Keep `reset`, `scan`, `evaluate`, and `deep` available as independent workflows for flexible use.

## Prerequisite

`hunt` depends on a live hosted browser session for portal scans, listing verification, and gated neighborhood research.

Rules:
- Check the hosted browser session first with `npm run browser:status` (or the npm.cmd variant on Windows PowerShell).
- If the session is already open and the CDP endpoint is reachable, reuse it without relaunching.
- If the session is missing, closed, or not CDP-reachable, run the `init` mode inline as Phase 0 before reset/scan/evaluate/deep. Pass through any platform flags from the hunt arguments (`--zillow`, `--redfin`, `--relator`, `--homes`) so init only opens the targets that hunt needs. After init reports the session is ready, re-verify with `npm run browser:status` before continuing.
- The user must still complete the manual portal sign-in inside the hosted Chrome window. If init opens a fresh session and no signed-in cookies are detected for any required platform, pause once and ask the user to finish sign-in before continuing -- this counts as a legitimate stop point per `modes/_shared.md`.
- If init itself fails (Node/npm preflight failure, browser launch error, no Chrome/Edge/Chromium available), stop the hunt run, write `.home-ops/contract-abort.json` with `{"reason":"hunt: init failed, hosted browser unavailable"}`, and report the failure. Do not attempt reset or any later phase against a dead session.

## Optional Flags

If the command arguments include scan platform flags such as:

- `--zillow`
- `--redfin`
- `--relator`
- `--homes`

apply those flags only to the `scan` phase.

If the command arguments include `--quick`, pass it through to every step-6 command in the deep phase (per `modes/deep.md` quick-mode rules). Do not let `--quick` skip any of the deep contract scripts -- it only narrows their work.

Rules:
- `reset` still clears the generated working state.
- `reset` should preserve `data/shortlist.md` when `config/profile.yml` sets `workflow.shortlist.preserve_on_reset: true`.
- `evaluate` still runs with no explicit listing target against the pipeline created by the scan phase.
- `deep` always runs after `evaluate`. There is no `--no-deep` opt-out -- if the buyer wants the lighter intake without the deep rerank, run `/home-ops scan` and `/home-ops evaluate` separately instead.

## Execution Order

### 0. Session Check + Auto-Init

- Run `npm run browser:status` (Windows PowerShell: `npm.cmd run browser:status`) and parse the result.
- If the hosted session is open and CDP-reachable, skip to Reset Phase.
- If the session is missing, closed, or not CDP-reachable, follow `modes/init.md` to bootstrap it:
  - With no platform flags, run `npm.cmd run browser:setup` (or `npm run browser:setup`).
  - With platform flags forwarded from hunt, run `npm.cmd run browser:session -- --hosted --caller hunt --channel chrome {forwarded flags}`.
  - After bootstrap, re-run `npm run browser:status` to confirm the session is now reusable.
- Do not enter credentials. If a platform requires manual sign-in, surface that to the user and pause exactly once.
- If init fails or status still reports closed, abort the hunt (see Prerequisite rules above) before touching generated state.

### 1. Reset Phase

- Execute the existing reset workflow first.
- Prefer the checked-in script:
  - Windows PowerShell: `npm.cmd run reset:data`
  - Other shells: `npm run reset:data`
- Run `node scripts/pipeline/verify-pipeline.mjs` after the reset, following the reset-mode instructions.

### 2. Scan Phase

- Run the scan workflow next using the same hosted browser session.
- Reuse the exact scan-mode rules for platform filters, session checks, per-source caps, and anti-bot stops.
- If Zillow or another selected portal blocks on login or human verification, report the blocker, skip that platform for the rest of the scan, and continue the hunt with whatever pipeline entries the unblocked platforms produced.

### 3. Evaluate Phase

- Run the evaluate workflow with no explicit target against the refreshed pipeline.
- Reuse the existing batch-evaluate rules, including canonical-property dedupe, one report-writing worker per property, staged tracker additions, and serialized browser-backed verification.
- Let evaluate handle the top-10 review tab behavior at the end of the batch.
- If every selected platform blocked and the pipeline stayed empty, evaluate may complete as a no-op. In that case, skip the deep phase, write `.home-ops/contract-abort.json` with `{"reason":"hunt: pipeline empty after scan, deep skipped"}`, and report that clearly. The Stop hook will let the turn end without flagging the missing deep scripts.

### 4. Deep Phase (shortlist batch branch)

- Run the shortlist batch branch from `modes/deep.md` against the top-10 cohort that the evaluate phase wrote into `data/shortlist.md`.
- Follow `modes/deep.md` Run-to-Completion Contract: announce each numbered step, fan out steps 6a-6e in parallel, and continue through the rerank, finalist gate, tab replacement, and briefing PDF without pausing for user approval.
- All deep contract scripts must run in this phase. The hunt contract hook (see `scripts/hooks/contract-shared.mjs`) requires every script the deep mode requires:
  - `node scripts/research/research-source-plan.mjs --shortlist --type all`
  - `node scripts/research/sentiment-browser-extract.mjs --shortlist --profile chrome-host --concurrency 4`
  - `node scripts/research/construction-check.mjs --shortlist`
  - `node scripts/research/deep-research-packet.mjs --shortlist` (or `npm.cmd run prepare:deep -- --shortlist`)
  - `node scripts/research/shortlist-finalist-gate.mjs` (or `npm.cmd run gate:finalists`)
  - `node scripts/browser/review-tabs.mjs shortlist-top3 --replace` (or `npm.cmd run browser:review -- shortlist-top3 --replace`)
  - `node scripts/reports/briefing-pdf.mjs` (or `npm.cmd run brief:top3`)
- The pre-rerank `research-coverage-audit.mjs` invocation that the hunt evaluate phase already ran satisfies the deep mode's audit prerequisite. Do not re-run it just to satisfy the contract.
- If `data/shortlist.md` is empty after evaluate (no qualifying homes survived), abort the deep phase by writing `.home-ops/contract-abort.json` with `{"reason":"hunt: shortlist empty after evaluate, deep skipped"}` and report it.
- If the hosted Chrome session dies mid-deep and cannot be reopened, follow the deep mode's hard-failure stop point: surface it, write the abort file, and end the turn.

## Important Rules

- Do not parallelize `reset`, `scan`, `evaluate`, and `deep` against each other -- they run sequentially. The deep phase's internal step-6 fan-out is allowed and expected.
- The hunt command is intentionally destructive to generated working state because it starts with `reset`.
- If the user wants to preserve existing reports, tracker rows, or pipeline contents, direct them to the separate commands instead of changing hunt behavior.
- If scan finds no new qualifying listings, still report that outcome clearly before the evaluate phase completes with no-op or empty results.
- The hunt contract is satisfied only after the briefing PDF renders. Do not end the turn until either every contract step is satisfied or `.home-ops/contract-abort.json` records a legitimate early-exit reason.

## Output Summary

Return a concise summary with:
- whether the hosted browser session was reused or auto-launched via init (and which platforms it covers)
- reset actions completed
- scan platforms and counts
- listings added to the pipeline
- canonical properties evaluated
- reports written
- tracker updates merged
- deep packets generated and per-home subagents launched
- finalist gate result (pass / fail / bypassed)
- finalist top-3 plus briefing PDF path
- final hosted-Chrome tab state (expected: three finalist listings + the briefing PDF)
- any blockers or remaining backlog