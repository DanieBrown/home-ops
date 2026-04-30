---
description: Open pre-filtered search tabs in the hosted browser for all configured portals
---

Open one filtered search tab per configured portal area in the hosted browser. Buyer profile filters (price, beds, baths, sqft, garage, listing age) are baked into each URL automatically. If no hosted session is running, one is launched automatically.

Examples:
- `/home-ops skim`
- `/home-ops skim --zillow --redfin`
- `/home-ops skim --no-zillow`

Use `/home-ops scan` afterward to extract and pipeline the listings you find.

Additional context:
$ARGUMENTS

Load the home-ops skill:
```
skill({ name: "home-ops" })
```
