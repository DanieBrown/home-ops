---
description: Reset generated state, scan for fresh listings, and batch-evaluate the refreshed pipeline
---

Run the Home-Ops hunt workflow using home-ops hunt mode.

Examples:
- `/home-ops hunt`
- `/home-ops hunt --zillow`
- `/home-ops hunt --redfin --relator`

Use `/home-ops init` first and keep the hosted browser session open before running hunt.

Additional context:
$ARGUMENTS

Load the home-ops skill:
```
skill({ name: "home-ops" })
```