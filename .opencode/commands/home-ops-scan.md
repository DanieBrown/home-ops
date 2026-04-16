---
description: Scan configured real-estate portals for new home listings
---

Scan the configured portals using home-ops scan mode.

Examples:
- `/home-ops scan`
- `/home-ops scan --zillow --redfin --relator`

Use `/home-ops init` first if you need to create or refresh the hosted browser session before scanning.

Scan mode keeps at most 3 unchecked pending homes per source per configured area. If a Zillow, Redfin, or Realtor.com area bucket is already full, Home-Ops clears that source-area bucket and refreshes it with a new set.
The pending list may contain the same home from multiple sources at once, but it should not keep duplicate URLs or same-source duplicate homes. Scan-history entries are kept for logging, not as a hard stop on bucket refills.
If Zillow blocks on sign-in or human verification, the scan command must pause immediately and request the user to sign in before continuing.

Additional context:
$ARGUMENTS

Load the home-ops skill:
```
skill({ name: "home-ops" })
```