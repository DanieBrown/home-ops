---
name: home-ops
description: profile | init | scan | evaluate | compare | deep | hunt | tracker | reset
user_invocable: true
args: mode
---

# home-ops -- Router

## Mode Routing

Determine the mode from `{{mode}}`.

If `{{mode}}` contains multiple tokens, use the first token as the sub-command and treat the remaining tokens as mode-specific arguments or flags.

| Input | Mode |
|-------|------|
| (empty / no args) | `discovery` -- Show command menu |
| Listing URL or pasted property details (no sub-command) | `evaluate` |
| `profile` | `profile` |
| `profile ...args` | `profile` |
| `init` | `init` |
| `init ...args` | `init` |
| `hunt` | `hunt` |
| `hunt ...args` | `hunt` |
| `evaluate` | `evaluate` |
| `evaluate ...args` | `evaluate` |
| `compare` | `compare` |
| `compare ...args` | `compare` |
| `scan` | `scan` |
| `scan ...args` | `scan` |
| `reset` | `reset` |
| `reset ...args` | `reset` |
| `tracker` | `tracker` |
| `tracker ...args` | `tracker` |
| `deep` | `deep` |
| `deep ...args` | `deep` |

If `{{mode}}` is not a known sub-command and looks like a Zillow, Redfin, Realtor.com, or other listing URL, treat it as `evaluate`.

If `{{mode}}` is not a known sub-command and does not look like a listing input, show discovery.

---

## Discovery Mode

Show this menu:

```text
home-ops -- Command Center

Available commands:
  /home-ops {listing-url}   -> Evaluate a single listing and update the tracker
  /home-ops profile         -> Interview the buyer and update the profile files
  /home-ops init            -> Launch or confirm the hosted browser session for portal logins
  /home-ops hunt            -> Reset, scan, batch-evaluate the refreshed pipeline, then run the deep shortlist flow (rerank, finalist gate, top-3 briefing PDF)
  /home-ops init --zillow --redfin --relator -> Initialize only those platform sessions in the hosted browser
  /home-ops evaluate        -> Evaluate one address or listing URL, or batch-evaluate pending pipeline homes when no target is supplied
  /home-ops compare         -> Compare and rank multiple homes
  /home-ops scan            -> Scan configured portals for new listings
  /home-ops scan --zillow --redfin --relator -> Scan only those platforms using the existing session
  /home-ops reset           -> Clear generated reports, tracker rows, pipeline items, and scan history while keeping profiles
  /home-ops tracker         -> Listings tracker overview and status updates
  /home-ops deep            -> Deep dive on a property, neighborhood, or school area

Pipeline inbox: data/pipeline.md
Tracker: data/listings.md
Buyer profile: buyer-profile.md
```

---

## Context Loading

For all active modes, read:
- `modes/_shared.md`
- `modes/_profile.md`

Then read the mode file:
- `modes/profile.md`
- `modes/init.md`
- `modes/hunt.md`
- `modes/evaluate.md`
- `modes/compare.md`
- `modes/scan.md`
- `modes/reset.md`
- `modes/tracker.md`
- `modes/deep.md`

Also read the relevant data files before acting:
- `buyer-profile.md`
- `config/profile.yml`
- `data/listings.md`
- `data/pipeline.md` when scanning or processing pending listings, including `evaluate` with no explicit target
- `portals.yml` when scanning or validating portal behavior

## Subagent Guidance

Prefer a subagent for `scan` because it can involve multiple pages and platform-specific extraction.

`evaluate` with no explicit listing target should deduplicate the pending pipeline into canonical properties, keep browser-backed verification and normalized fact extraction in the main agent, and then create one report-writing subagent per property. If the queue is large, dispatch those per-property workers in waves of up to 5, but keep the unit of work at one home per agent.

`profile` should use the interactive question flow from `modes/profile.md` and keep the buyer-layer writes in the main agent.

`hunt` should orchestrate `reset`, then `scan`, then `evaluate`, then the `deep` shortlist batch branch sequentially without terminating any running jobs.. Do not overlap those four phases. The deep phase's internal step-6 fan-out is allowed and expected. If subagents are used outside the deep phase, keep them inside the scan or evaluate phases rather than across the full hunt flow. The contract hook in `scripts/hooks/contract-shared.mjs` enforces that every deep-shortlist script (`research-source-plan`, `sentiment-browser-extract`, `construction-check`, `deep-research-packet`, `shortlist-finalist-gate`, `review-tabs shortlist-top3`, `briefing-pdf`) actually runs before the turn ends.

When multiple listings are being evaluated, the main agent should own the final tracker merge, pipeline edits, and summary. Workers should return full report drafts plus structured evaluation results or other staged output rather than racing to edit `data/listings.md` directly, and browser-backed verification should stay serialized across the run.

`deep` with a populated top-10 shortlist in `data/shortlist.md` should launch one subagent per shortlisted home. Each worker should return structured deep-dive findings and a tentative verdict for one home, while the main agent owns the combined batch brief, shortlist rewrite, final top-3 rerank, and finalist-tab replacement in the hosted browser.

Execute the instructions from the loaded mode files.