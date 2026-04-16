---
description: Clear generated reports, pipeline items, tracker rows, and scan history while keeping buyer profiles and portal configuration
---

Reset the generated Home-Ops working state.

Examples:
- `/home-ops reset`
- `/home-ops reset --dry-run`

Use this when you want a clean search slate without changing buyer preferences, portal URLs, or browser sessions.

Additional context:
$ARGUMENTS

Load the home-ops skill:
```
skill({ name: "home-ops" })
```