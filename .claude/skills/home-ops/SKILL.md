---
name: home-ops
description: AI home search command center -- evaluate listings, compare homes, scan portals, track status, and run deep neighborhood research
user_invocable: true
args: mode
---

# home-ops -- Router

## Mode Routing

Determine the mode from `{{mode}}`:

| Input | Mode |
|-------|------|
| (empty / no args) | `discovery` -- Show command menu |
| Listing URL or pasted property details (no sub-command) | `evaluate` |
| `evaluate` | `evaluate` |
| `compare` | `compare` |
| `scan` | `scan` |
| `tracker` | `tracker` |
| `deep` | `deep` |

If `{{mode}}` is not a known sub-command and looks like a Zillow, Redfin, Realtor.com, or other listing URL, treat it as `evaluate`.

If `{{mode}}` is not a known sub-command and does not look like a listing input, show discovery.

---

## Discovery Mode

Show this menu:

```text
home-ops -- Command Center

Available commands:
  /home-ops {listing-url}   -> Evaluate a single listing and update the tracker
  /home-ops evaluate        -> Evaluation only for one address or listing URL
  /home-ops compare         -> Compare and rank multiple homes
  /home-ops scan            -> Scan configured portals for new listings
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
- `modes/evaluate.md`
- `modes/compare.md`
- `modes/scan.md`
- `modes/tracker.md`
- `modes/deep.md`

Also read the relevant data files before acting:
- `buyer-profile.md`
- `config/profile.yml`
- `data/listings.md`
- `data/pipeline.md` when scanning or processing pending listings
- `portals.yml` when scanning or validating portal behavior

## Subagent Guidance

Prefer a subagent for `scan` because it can involve multiple pages and platform-specific extraction.

`deep` may also use a subagent if the research scope is broad, but it is not required.

Execute the instructions from the loaded mode files.