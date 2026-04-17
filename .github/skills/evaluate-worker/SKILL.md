---
name: evaluate-worker
description: 'Draft one Home-Ops property evaluation from a prepared evidence packet during batch evaluate runs. Use for per-home report-writing workers, structured scoring, tracker-note suggestions, and shortlist rationale without touching the live browser or tracker merge flow.'
argument-hint: 'One canonical property evidence packet or report-drafting assignment'
user-invocable: false
---

# Evaluate Worker

Use this skill for the per-home worker inside Home-Ops batch `evaluate` runs.

This skill turns one prepared canonical-property evidence packet into a decision-ready report draft and structured results for the main agent to merge.

Use the exact handoff schema in [Evaluate Worker Contract](./references/contract.md) when the caller or worker needs a stable packet and result format.

Do not use this skill for:
- live browser verification
- hosted browser session management
- pipeline deduplication
- tracker merges
- shortlist file edits
- multi-home orchestration

## When To Use

Use this skill when:
- `evaluate` has already deduplicated the pending pipeline into canonical properties
- the main agent has already handled browser-backed verification and normalized fact extraction
- one worker needs to draft the evaluation for one property only
- the caller wants a report draft, score, suggested status, tracker note, and shortlist rationale from supplied evidence

Do not use this skill when:
- the task still needs live Playwright or hosted-browser work
- multiple homes are bundled together
- the main agent still needs to pick the primary source URL or deduplicate alternate listing URLs

## Expected Inputs

Work from one canonical property only.

For the exact packet shape, field names, and example objects, use [Evaluate Worker Contract](./references/contract.md).

The caller should supply as much of this packet as possible:
- buyer context from `buyer-profile.md`, `config/profile.yml`, and `modes/_profile.md`
- normalized listing facts
- verification result and confidence clues
- primary listing URL plus alternate fallback URLs
- concrete research targets from `research-source-plan.mjs`
- gathered neighborhood, school, development, and financial evidence
- any existing report or tracker context that matters for updates

If part of the packet is missing, continue conservatively and say exactly what is missing. Never invent facts.

## Procedure

1. Confirm scope.
   The assignment must cover exactly one canonical home. If the packet contains multiple homes, stop and ask the caller to split it.

2. Restate the verified facts and unknowns.
   Separate confirmed listing facts from assumptions, conflicts, and missing evidence.

3. Build the hard-requirement gate.
   Mark each required criterion as `Pass`, `Fail`, or `Unknown` using the configured buyer thresholds.

4. Evaluate property fit.
   Cover hard requirements, layout, lot usability, resale fit, and major physical tradeoffs.

5. Evaluate neighborhood sentiment.
   Use the supplied evidence packet. Prefer repeated themes over isolated anecdotes, and distinguish subdivision-level evidence from city-level evidence.

6. Evaluate schools.
   Use actual ratings and sentiment when available. If sources conflict, explain the mismatch instead of averaging blindly.

7. Evaluate development and infrastructure risk.
   Call out nearby growth, road projects, flood or drainage risk, rezoning pressure, or the absence of meaningful findings with a confidence note.

8. Build the financial snapshot.
   Use the supplied buyer assumptions and clearly separate known costs from estimated costs.

9. Score the home.
   Produce a final score from `1.0` to `5.0` using the shared Home-Ops scoring model and caps.

10. Choose the recommendation.
    End with exactly one of these:
    - `Pursue now`
    - `Worth touring`
    - `Hold pending validation`
    - `Pass`

11. Draft the report.
    Follow the exact Home-Ops report header fields and section order used by batch evaluate.

12. Return a structured worker result.
    Give the main agent a report draft plus the key metadata it needs for tracker staging, shortlist ranking, and final summaries.

## Decision Rules

- If verification shows the listing is sold, pending, removed, or unavailable, keep the write-up conservative and suggest `Sold` as the tracker status.
- If verification is blocked or uncertain, mark confidence accordingly and do not claim the listing is active.
- If the home fails multiple hard requirements, the recommendation must be `Pass` even if cosmetic or neighborhood factors are attractive.
- If price, beds, garage, or square footage fail the configured hard requirements, cap the overall score at `2.4`.
- If school quality clearly misses the configured threshold, cap the score at `2.9`.
- If major risks such as flood exposure, busy-road adjacency, or excessive HOA remain unresolved, keep the recommendation conservative and lower confidence.
- If a configured source class from the supplied plan was not actually used, call that out under evidence gaps instead of implying full coverage.
- Use alternate listing URLs only as supporting fallbacks for the same home, never as separate evaluations.

## Output Contract

Return one result bundle for one property. Prefer this structure unless the caller requested a stricter format:

For the exact result fields, required values, and an end-to-end example, use [Evaluate Worker Contract](./references/contract.md).

```markdown
## Report Draft
<full markdown report>

## Structured Result
- Score: <n.n>/5
- Recommendation: <Pursue now | Worth touring | Hold pending validation | Pass>
- Confidence: <High | Medium | Low>
- Suggested Status: <Sold | SKIP | Evaluated>
- Tracker Note: <one sentence>
- Shortlist Rationale: <one sentence or "">
- Evidence Gaps:
  - <gap or "None noted">
- Sources Used:
  - <source list>
```

The report draft must preserve the standard Home-Ops section order:
1. Quick Take
2. Summary Card
3. Hard Requirement Gate
4. Property Fit
5. Neighborhood Sentiment
6. School Review
7. Development and Infrastructure
8. Financial Snapshot
9. Risks and Open Questions
10. Recommendation

## Worker Boundaries

- Do not open or control the hosted browser.
- Do not run Playwright verification.
- Do not deduplicate pipeline entries.
- Do not merge tracker rows.
- Do not edit `data/listings.md`, `data/pipeline.md`, or `data/shortlist.md` directly.
- Do not bundle multiple homes into one response.
- Do not hide weak evidence, conflicting sources, or missing data.
- Do not promote a listing to `Interested`, `Tour Scheduled`, `Toured`, `Offer Submitted`, or `Under Contract` unless the caller explicitly asked for that workflow.

## Completion Checklist

Before returning, verify that:
- the packet covered one home only
- the hard-requirement gate is explicit
- the score respects Home-Ops caps and overrides
- the recommendation uses one approved phrase
- the confidence level matches the evidence quality
- the report draft follows the standard section order
- the suggested tracker status is canonical
- the tracker note is one concise sentence
- the shortlist rationale is present only when the home is viable
- neighborhood, school, and development evidence gaps are called out plainly