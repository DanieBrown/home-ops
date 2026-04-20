---
description: Evaluate one home listing or batch-evaluate pending pipeline homes
---

Evaluate the following listing using home-ops evaluate mode.

If no listing URL, address, or pasted listing text is supplied, process the unchecked entries in `data/pipeline.md` in batch mode.

In batch mode, deduplicate the pending pipeline by canonical property, keep listing verification serialized in the main agent, and let evaluate create one report-writing worker per pending home. If the queue is large, dispatch those per-home workers in waves of up to 5 until the full pending set has been attempted.

Prefer the checked-in `node scripts/pipeline/evaluate-pending.mjs` or `npm.cmd run evaluate:pending` path for the deterministic packet/extraction/orchestration work so evaluate reuses the repo implementation instead of recreating temporary helper scripts.

Examples:
- `/home-ops evaluate`
- `/home-ops evaluate https://www.zillow.com/...`
- `/home-ops evaluate 24 Lane Farms Way, Holly Springs, NC`

$ARGUMENTS

Load the home-ops skill:
```
skill({ name: "home-ops" })
```