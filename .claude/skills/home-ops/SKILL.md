---
name: home-ops
description: AI home search command center -- evaluate listings, compare homes, scan portals, track status, and run deep neighborhood research
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
| `init` | `init` |
| `init ...args` | `init` |
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
  /home-ops init            -> Launch or confirm the hosted browser session for portal logins
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
- `modes/init.md`
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

`evaluate` with no explicit listing target should split the deduplicated pending pipeline into worker slices of up to 5 canonical properties and use one subagent per slice.

When multiple listings are being evaluated, the main agent should own the final tracker merge, pipeline edits, and summary. Workers should return structured evaluation results or other staged output rather than racing to edit `data/listings.md` directly, and browser-backed verification should stay serialized across the run.

`deep` may also use a subagent if the research scope is broad, but it is not required.

Execute the instructions from the loaded mode files.