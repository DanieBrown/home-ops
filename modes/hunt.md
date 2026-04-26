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

### 1–3. Sequential Phase (Reset → Scan → Evaluate)

**CRITICAL: DO NOT run individual scripts for this phase. Run one single command:**

```
npm.cmd run hunt:sequential
```

Use a **600000ms timeout** (10 minutes). This is the only correct way to run phases 1–3. The runner uses `spawnSync` so each step fully completes before the next starts — calling individual scripts directly will cause the scan to be killed by the tool timeout.

To skip Zillow (use when Zillow bot detection is active, or if Zillow was auto-skipped by the session flag):
```
npm.cmd run hunt:sequential -- --redfin --relator --homes
```

To restrict to specific platforms (flag set from hunt arguments):
```
npm.cmd run hunt:sequential -- --zillow --redfin
```

**The runner handles these steps internally — do not call them separately:**
- reset:data → verify-pipeline → scan → scan:verify → evaluate:pending → merge → audit:research

Run this command with a timeout of at least 600000ms (10 minutes) because the scan and batch evaluate phases can take several minutes each.

The runner exits 0 when all phases succeed, or 1 when any phase fails with a clear message identifying which step failed. Do not proceed to `browser:review` or the deep phase if the runner exits non-zero.

**When the runner exits non-zero**, determine which phase failed from the runner output and act accordingly — do NOT ask the user what they want to do:

| Failed phase | Auto-recovery action | If still failing |
|---|---|---|
| `reset:data` or `verify-pipeline` | None needed — retry `npm.cmd run hunt:sequential` once | Abort with reason `hunt: reset failed` |
| `scan` (CDP timeout / connection lost / browser crash) | Run `npm.cmd run browser:status`. If session is dead, run `npm.cmd run browser:setup` and wait for it to succeed. Then retry `npm.cmd run hunt:sequential` once. | Abort with reason `hunt: scan failed, browser session unrecoverable` |
| `scan` (no listings found / portal blocked, NOT a browser crash) | Abort immediately — this is a no-op outcome, not an error | Write `{"reason":"hunt: scan returned no listings"}` |
| `scan:verify` | Re-run `npm.cmd run scan:verify` once | Abort with reason `hunt: scan:verify failed` |
| `evaluate:pending` | Re-run `npm.cmd run hunt:sequential` once from the top (safe because reset is idempotent) | Abort with reason `hunt: evaluate failed` |
| `merge` or `audit:research` | Re-run the failed step directly once | Abort with reason `hunt: post-evaluate step failed` |

Abort means: write `.home-ops/contract-abort.json` with the specific `{"reason":"..."}`, report the failure and what the user must do manually to resume (e.g., "restart the hosted browser, then re-run `/home-ops hunt`"), and end the turn without asking for further direction.

If the runner fails because the scan found no new qualifying listings, evaluate will complete as a no-op. Check whether the pipeline is empty after the runner returns. If empty, skip the deep phase, write `.home-ops/contract-abort.json` with `{"reason":"hunt: pipeline empty after scan, deep skipped"}`, and report that clearly.

### 4. Open Top-10 Review Tabs

Before running the deep phase, open the top-10 shortlist in the hosted browser:

- Windows PowerShell: `npm.cmd run browser:review -- shortlist-top10 --replace`
- Other shells: `npm run browser:review -- shortlist-top10 --replace`

If `data/shortlist.md` is empty after evaluate (no qualifying homes survived), abort the deep phase by writing `.home-ops/contract-abort.json` with `{"reason":"hunt: shortlist empty after evaluate, deep skipped"}` and report it clearly.

### 5. Deep Phase (shortlist batch branch)

The deep phase has three sub-steps. Do not skip any of them.

#### 5a. Data collection prep

**CRITICAL: DO NOT run individual prep scripts. Run one single command:**

```
npm.cmd run hunt:deep
```

Use a **600000ms timeout** (10 minutes).

**The runner handles these steps internally — do not call them separately:**
- research-source-plan → community-lookup → sentiment-browser-extract → construction-check → sentiment-public-extract → deep-research-packet

The runner exits 0 when all six prep steps succeed and the packets are written to `output/deep-packets/`. If it exits non-zero, fix the failing step before continuing.

#### 5b. Per-home subagent fan-out

After the prep runner exits 0, read `output/deep-packets/` to enumerate the packet files. Then follow **modes/deep.md steps 9–13** to fan out per-home AI subagents:

- Launch one subagent per shortlisted home (up to 10 total) in a **single message** so the runtime fans them out in parallel. Never serialize the launches.
- Each worker receives exactly one deep packet plus the matching evaluation report path, researches all deep-dive axes (neighborhood, schools, development, commute, risk, resale), and returns a structured result.
- As workers return, stream their findings into the combined batch brief.
- After all workers have returned, the main agent writes the combined brief to `reports/deep-shortlist-{YYYY-MM-DD}.md` and updates `data/shortlist.md` with the deep batch status and a reranked top 3.

Workers must follow the Worker Tool Contract in `modes/deep.md` — actual tool calls required, no hallucination from the packet alone.

#### 5c. Finalization

After all subagents have returned and the combined brief is written, run:

```
npm.cmd run hunt:deep-final
```

Use a **300000ms timeout** (5 minutes).

**The runner handles these steps internally — do not call them separately:**
- promote-finalists → shortlist-finalist-gate → review-tabs top3 → briefing-pdf

The runner exits 0 when all finalization steps succeed. If the finalist gate fails due to research gaps, fix the gaps and re-run `npm.cmd run hunt:deep-final`. Do not proceed to the output summary if the runner exits non-zero.

If the hosted Chrome session dies mid-deep and cannot be reopened, surface it, write `.home-ops/contract-abort.json` with `{"reason":"hunt: chrome session lost mid-deep"}`, and end the turn.

## Important Rules

- **ALWAYS use the runners.** Call `npm.cmd run hunt:sequential` (phases 1–3), `npm.cmd run hunt:deep` (deep prep 5a), and `npm.cmd run hunt:deep-final` (finalization 5c) with appropriate timeouts. Never call individual scripts directly (`npm run scan`, `node scripts/pipeline/scan-listings.mjs`, etc.) — they will be killed by the tool timeout before completing and cause cascade failures.
- If you find yourself about to run `reset:data`, `verify`, `scan`, `scan:verify`, `evaluate:pending`, `merge`, `audit:research`, or any individual deep-phase script: STOP. Call the appropriate runner instead.
- Do not parallelize the runners or call any phase script while a runner is still executing. The per-home subagent fan-out (step 5b) happens **between** `hunt:deep` and `hunt:deep-final`, not during either runner.
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