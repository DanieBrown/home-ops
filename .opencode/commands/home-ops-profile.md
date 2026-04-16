---
description: Interview the buyer and update the Home-Ops profile files interactively
---

Use home-ops profile mode to collect or revise the buyer profile.

Examples:
- `/home-ops profile`
- `/home-ops profile refresh`

This command should ask guided questions, accept bulleted-list answers when that is easier, normalize the weighting scores, and update the buyer-layer files.

Additional context:
$ARGUMENTS

Load the home-ops skill:
```
skill({ name: "home-ops" })
```