---
description: Evaluate one home listing or batch-evaluate pending pipeline homes
---

Evaluate the following listing using home-ops evaluate mode.

If no listing URL, address, or pasted listing text is supplied, process the unchecked entries in `data/pipeline.md` in batch mode.

In batch mode, deduplicate the pending pipeline by canonical property, split it into 5-property worker batches, and keep dispatching those batches until the full pending set has been attempted.

Examples:
- `/home-ops evaluate`
- `/home-ops evaluate https://www.zillow.com/...`
- `/home-ops evaluate 24 Lane Farms Way, Holly Springs, NC`

$ARGUMENTS

Load the home-ops skill:
```
skill({ name: "home-ops" })
```