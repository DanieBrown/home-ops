---
description: Initialize or refresh the hosted browser session for portal logins
---

Initialize the hosted browser session using home-ops init mode.

Examples:
- `/home-ops init`
- `/home-ops init --zillow --redfin --relator`
- `/home-ops init --relator --refresh-site-data`

Additional context:
$ARGUMENTS

Load the home-ops skill:
```
skill({ name: "home-ops" })
```
