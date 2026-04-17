---
description: Interview the buyer and update the Home-Ops profile files interactively
---

Use home-ops profile mode to collect or revise the buyer profile.

Examples:
- `/home-ops profile`
- `/home-ops profile refresh`

This command should ask guided questions, accept bulleted-list answers when that is easier, accept comma-delimited area lists in a single reply, normalize the weighting scores, and update the buyer-layer files.
When the profile flow finishes, explicitly tell the user to run `/home-ops init` next.

Additional context:
$ARGUMENTS

Load the home-ops skill:
```
skill({ name: "home-ops" })
```